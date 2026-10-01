import { z } from 'zod';
import { loadAsNewApp, type Manifest, type SnapshotDeps, type SnapshotRow } from './backup/snapshots.js';
import { type Client, type Database, maybeOne, one, type SessionContext, withoutSession, withSession } from './db.js';
import { HttpError } from './errors.js';
import { type BlobStore, memoryBlobStore } from './files/blobs.js';
import { sha256Hex } from './files/hash.js';
import type { App, Ctx, Deps } from './routes/context.js';
import { readJson } from './routes/context.js';
import { sessionFromHeader } from './auth/session.js';

/**
 * Public demo sandboxes. "Try the demo" creates a tenant of the visitor's own, loads a copy of the
 * sample application into it from the stored template, and hands back a session for its
 * administrator. The copy expires (24 hours by default) and is then removed, rows and files.
 * Demo sessions cannot invite users, change roles, create applications or upload large files.
 */

export interface DemoPersona {
  key: 'admin' | 'planner' | 'viewer';
  email: string;
  display_name: string;
  label: string;
  description: string;
}

/** The people in every demo copy. The first is the administrator. The template grants the others. */
export const DEMO_PERSONAS: DemoPersona[] = [
  { key: 'admin', email: 'demo-admin@nextwelve.invalid', display_name: 'Avery (administrator)', label: 'Administrator',
    description: 'Sees and changes everything, including metadata, definitions and backups.' },
  { key: 'planner', email: 'demo-planner@nextwelve.invalid', display_name: 'Pat (planner)', label: 'Planner, Fernhollow Canada',
    description: 'Enters numbers for Fernhollow Canada only; the rest of the company is hidden.' },
  { key: 'viewer', email: 'demo-viewer@nextwelve.invalid', display_name: 'Vic (viewer)', label: 'Viewer',
    description: 'Reads every form and report; cannot change anything.' },
];
export const DEMO_APP_NAME = 'Fernhollow Operating Plan';

export interface DemoConfig {
  enabled: boolean;
  /** Live demo copies at most (each holds a copy of the sample, ~30,000 cells). */
  maxLive: number;
  /** New demos per visitor network per hour ("Start over" counts). */
  perIpHour: number;
  /** Live copies one network may hold at once (default: perIpHour). */
  perIpLive?: number;
  /** How long a copy lives. */
  hours: number;
  /** Mixed into the IP hash, so stored hashes cannot be matched to addresses without it. */
  ipSalt: string;
  turnstileSecret?: string;
  turnstileSiteKey?: string;
  /** For tests: what verifies a Turnstile token. */
  verifyTurnstile?: (token: string, ip: string | null) => Promise<boolean>;
}

/** Uploads a demo session may send (any request body, in fact). */
export const DEMO_MAX_UPLOAD = 1024 * 1024;
/** Uploaded files a demo copy may keep, in total. */
export const DEMO_MAX_STORED = 16 * 1024 * 1024;

const PersonaBody = z.object({ persona: z.enum(['admin', 'planner', 'viewer']) });
const StartBody = z.object({ turnstile_token: z.string().max(4096).optional() });

// ---------------------------------------------------------------------------
// The template: the files of a snapshot, kept in the database by `pnpm demo:template`
// ---------------------------------------------------------------------------
let cached: { snapshotId: string; snap: SnapshotRow; blobs: BlobStore } | null = null;
const PREFIX = 'demo-template';

export async function loadTemplate(db: Database): Promise<{ snap: SnapshotRow; blobs: BlobStore }> {
  const head = await withoutSession(db, (c) => maybeOne<{ bytes: Uint8Array }>(c, `select bytes from epm.demo_template_files() where name = 'manifest.json'`));
  if (!head) throw new HttpError(503, 'the demo is not set up yet (run pnpm demo:template)');
  const manifest = JSON.parse(new TextDecoder().decode(head.bytes)) as Manifest;
  if (cached?.snapshotId === manifest.snapshot_id) return cached;
  const files = await withoutSession(db, (c) => c.query<{ name: string; bytes: Uint8Array }>('select name, bytes from epm.demo_template_files()'));
  const blobs = memoryBlobStore();
  for (const f of files.rows) await blobs.put(`${PREFIX}/${f.name}`, new Uint8Array(f.bytes), 'application/octet-stream');
  const snap: SnapshotRow = {
    snapshot_id: manifest.snapshot_id, app_id: manifest.app_id, app_name: manifest.app_name, kind: 'demo_template', scope: {},
    status: 'complete', storage_prefix: PREFIX, metadata_rev: manifest.metadata_rev, high_chain_seq: manifest.high_chain_seq,
    fact_count: manifest.fact_count, byte_size: null, manifest, error: null, comment: null, created_by: null,
    created_at: manifest.taken_at, completed_at: manifest.taken_at, expires_at: null,
  };
  cached = { snapshotId: manifest.snapshot_id, snap, blobs };
  return cached;
}

/** Store a snapshot's files as the demo template (owner connection; used by scripts and tests). */
export async function storeTemplate(owner: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, blobs: BlobStore, snap: SnapshotRow) {
  const manifest = snap.manifest!;
  await owner.query('begin');
  await owner.query('delete from epm.demo_template');
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const put = (name: string, bytes: Uint8Array) => owner.query("insert into epm.demo_template (name, bytes) values ($1, decode($2, 'hex'))", [name, hex(bytes)]);
  await put('manifest.json', new TextEncoder().encode(JSON.stringify(manifest)));
  for (const f of manifest.files) {
    const bytes = await blobs.get(`${snap.storage_prefix}/${f.name}`);
    if (!bytes) throw new Error(`template file ${f.name} is missing`);
    await put(f.name, bytes);
  }
  await owner.query('commit');
  cached = null;
}

// ---------------------------------------------------------------------------
// Removing copies
// ---------------------------------------------------------------------------
/** Every stored file of a tenant (uploads, snapshots) lives under `<tenant>/`. */
export async function purgeTenantFiles(blobs: BlobStore, tenantIds: string[]): Promise<void> {
  for (const t of tenantIds) {
    if (!/^[0-9a-f-]{36}$/i.test(t)) continue;
    const keys = await blobs.list(`${t}/`);
    if (keys.length) await blobs.delete(keys);
  }
}

const SWEEP_BATCH = 25;

/**
 * The scheduled sweep: expired demo copies in small batches (each its own transaction; copies
 * another purge holds are skipped), then the files of every removed copy. A tenant stays on the
 * database's list of files to delete until that has succeeded, so a storage outage only delays it.
 */
export async function sweepDemoTenants(deps: SnapshotDeps, jobKey: string): Promise<string[]> {
  const removed: string[] = [];
  for (let round = 0; round < 40; round++) {
    const ids = await withoutSession(deps.db, async (c) =>
      (await c.query<{ tenant_id: string }>('select tenant_id from epm.sweep_demo_tenants($1, $2)', [jobKey, SWEEP_BATCH])).rows.map((r) => r.tenant_id));
    removed.push(...ids);
    if (ids.length < SWEEP_BATCH) break;
  }
  for (let round = 0; round < 20; round++) {
    const pending = await withoutSession(deps.db, async (c) =>
      (await c.query<{ tenant_id: string }>('select tenant_id from epm.demo_files_pending($1, 200)', [jobKey])).rows.map((r) => r.tenant_id));
    if (!pending.length) break;
    // One tenant at a time, so a file that cannot be deleted yet does not hold up the others.
    const cleared: string[] = [];
    let failure: unknown = null;
    for (const t of pending) {
      try {
        await purgeTenantFiles(deps.blobs, [t]);
        cleared.push(t);
      } catch (err) {
        failure ??= err;
      }
    }
    if (cleared.length) await withoutSession(deps.db, (c) => c.query('select epm.demo_files_cleared($1, $2::uuid[])', [jobKey, cleared]));
    if (failure) throw failure;
    if (pending.length < 200) break;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Guard rails for demo sessions
// ---------------------------------------------------------------------------
const BLOCKED: [string, RegExp][] = [
  ['POST', /^\/v1\/apps\/?$/],
  ['*', /^\/v1\/users(\/|$)/],
  ['*', /^\/v1\/groups(\/|$)/],
  ['*', /^\/v1\/apps\/[^/]+\/roles(\/|$)/],
];

/**
 * Refuse what a demo may not do (inviting people, roles, new applications, large uploads), and
 * every demo session once the demo has been turned off. Bodies sent without a length are
 * limited as they arrive (app.ts).
 */
export function demoGuard(c: Ctx, s: SessionContext, config: DemoConfig | undefined): void {
  if (!s.demo) return;
  if (!config?.enabled) throw new HttpError(401, 'the demo has ended');
  const method = c.req.method;
  const path = c.req.path;
  if (BLOCKED.some(([m, re]) => (m === '*' || m === method) && re.test(path)) && method !== 'GET') {
    throw new HttpError(403, 'this is not available in the demo');
  }
  const length = Number(c.req.header('content-length') ?? '0');
  if (length > DEMO_MAX_UPLOAD) throw new HttpError(413, 'uploads in the demo are limited to 1 MB');
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
function clientIp(c: Ctx): string | null {
  return c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

/**
 * What the limits count a visitor by: the IPv4 address, or the /64 of an IPv6 address (every
 * IPv6 host controls at least a /64). IPv4-mapped IPv6 addresses count as IPv4.
 */
export function networkOf(ip: string | null): string {
  if (!ip) return 'unknown';
  const a = ip.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!a.includes(':')) return a;
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (mapped) return mapped[1]!;
  const [head, tail] = a.includes('::') ? a.split('::', 2) as [string, string] : [a, null];
  // An embedded IPv4 tail stands for the last two groups (outside the /64 anyway).
  const v4tail = (parts: string[]) => (parts.length && parts[parts.length - 1]!.includes('.') ? [...parts.slice(0, -1), '0', '0'] : parts);
  const left = tail === null ? v4tail(head.split(':')) : head ? head.split(':') : [];
  const right = tail ? v4tail(tail.split(':')) : [];
  const groups = tail === null ? left : [...left, ...new Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return `bad:${a}`;
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

async function turnstileOk(config: DemoConfig, token: string | undefined, ip: string | null): Promise<boolean> {
  if (config.turnstileSiteKey && !config.turnstileSecret && !config.verifyTurnstile) {
    // The page would show a check that nothing verifies: refuse rather than run unprotected.
    console.error(JSON.stringify({ demo: 'TURNSTILE_SITE_KEY is set but TURNSTILE_SECRET is not; demo starts are refused' }));
    throw new HttpError(503, 'the demo is not available right now');
  }
  if (!config.turnstileSecret && !config.verifyTurnstile) return true;
  if (!token) return false;
  if (config.verifyTurnstile) return config.verifyTurnstile(token, ip);
  const form = new FormData();
  form.append('secret', config.turnstileSecret!);
  form.append('response', token);
  if (ip) form.append('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
  const data = (await res.json().catch(() => ({}))) as { success?: boolean };
  return data.success === true;
}

const personaOf = (email: string) => DEMO_PERSONAS.find((p) => p.email === email.toLowerCase()) ?? null;
const publicPersonas = () => DEMO_PERSONAS.map(({ key, label, description }) => ({ key, label, description }));

export function demoRoutes(app: App, deps: Deps, config: DemoConfig | undefined) {
  const off = () => new HttpError(404, 'the demo is not enabled here');

  // Start a demo (public). A demo session sent along ("Start over") is ended once the new copy
  // is ready; if the new one is refused or fails, the visitor keeps the old one.
  app.post('/v1/demo/session', async (c) => {
    if (!config?.enabled) throw off();
    const body = StartBody.parse(await readJson(c));
    const ip = clientIp(c);
    const old = c.req.header('authorization')
      // A phone's read-only session never ends or replaces the copy it is looking at.
      ? await sessionFromHeader(c.req.header('authorization'), deps.signer).then((x) => (x.demo && !x.readOnly ? x : null), () => null)
      : null;
    // "Start over" from inside a live copy has passed the browser check already (when that copy
    // was started); a token sent along is still always checked.
    const fromLiveCopy = old && !body.turnstile_token ? await isLive(deps, old) : false;
    if (!fromLiveCopy && !(await turnstileOk(config, body.turnstile_token, ip))) {
      throw new HttpError(403, 'the browser check did not pass; reload the page and try again');
    }

    const template = await loadTemplate(deps.db);
    const ipHash = await sha256Hex(new TextEncoder().encode(`${config.ipSalt}|${networkOf(ip)}`));
    const started = await withoutSession(deps.db, async (q) =>
      (await one<{ r: { tenant_id: string; expires_at: string; users: { email: string; user_id: string }[] } }>(
        q,
        "select epm.start_demo(decode($1, 'hex'), $2, $3, $4, $5, $6, $7) as r",
        [
          ipHash, config.maxLive, config.perIpHour, config.perIpLive ?? config.perIpHour, config.hours,
          JSON.stringify(DEMO_PERSONAS.map((p) => ({ email: p.email, display_name: p.display_name }))),
          old?.tenantId ?? null,
        ],
      )).r,
    );

    const admin: SessionContext = { userId: started.users[0]!.user_id, tenantId: started.tenant_id, demo: true };
    let appId: string;
    try {
      const loaded = await loadAsNewApp({ db: deps.db, blobs: template.blobs }, admin, template.snap, { name: DEMO_APP_NAME, access: 'copy' }, null);
      appId = loaded.app_id;
    } catch (err) {
      await endDemo(deps, admin).catch(() => undefined);
      throw err;
    }
    if (old) await endDemo(deps, old).catch(() => undefined);
    await tidy(deps);

    const ttl = Math.floor((new Date(started.expires_at).getTime() - Date.now()) / 1000);
    const s = await deps.signer.issue(admin, ttl);
    return c.json({
      session_token: s.token, expires_in: s.expiresIn, expires_at: started.expires_at, app_id: appId,
      persona: 'admin', personas: publicPersonas(),
    }, 201);
  });

  // Look at the same copy as another of its people.
  app.post('/v1/demo/persona', async (c) => {
    const s = c.get('session');
    if (!s?.demo) throw new HttpError(403, 'only a demo session can switch people');
    const body = PersonaBody.parse(await readJson(c));
    const persona = DEMO_PERSONAS.find((p) => p.key === body.persona)!;
    const row = await withSession(deps.db, s, (q) =>
      maybeOne<{ user_id: string; expires_at: string }>(
        q,
        `select u.user_id, t.demo_expires_at as expires_at from epm.app_user u join epm.tenant t on t.tenant_id = u.tenant_id
          where lower(u.email) = $1 and t.demo_expires_at is not null and u.status = 'active'`,
        [persona.email],
      ),
    );
    if (!row) throw new HttpError(404, 'that person is not in this demo');
    const ttl = Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000);
    if (ttl <= 0) throw new HttpError(401, 'this demo has ended');
    const issued = await deps.signer.issue({ userId: row.user_id, tenantId: s.tenantId, demo: true }, ttl);
    return c.json({ session_token: issued.token, expires_in: issued.expiresIn, expires_at: row.expires_at, persona: persona.key });
  });

  // End this demo now: its rows and files go.
  app.delete('/v1/demo/session', async (c) => {
    const s = c.get('session');
    if (!s?.demo) throw new HttpError(403, 'only a demo session can be ended');
    await endDemo(deps, s);
    return c.json({ ended: true });
  });

  // Public: whether the demo is on, the browser check to show, and who is in a copy.
  app.get('/v1/demo', (c) => c.json({
    enabled: !!config?.enabled,
    turnstile_site_key: config?.enabled ? (config.turnstileSiteKey ?? null) : null,
    hours: config?.hours ?? null,
    personas: publicPersonas(),
  }));
}

/** Whether a demo session's copy still exists and has not expired. */
async function isLive(deps: Deps, s: SessionContext): Promise<boolean> {
  return withSession(deps.db, s, async (c) => !!(await maybeOne(c, 'select 1 from epm.tenant where demo_expires_at > now()')))
    .catch(() => false);
}

/** After a successful start: remove up to two expired copies (never waiting on another purge). */
async function tidy(deps: Deps): Promise<void> {
  try {
    const ids = await withoutSession(deps.db, async (c) =>
      (await c.query<{ tenant_id: string }>('select tenant_id from epm.tidy_demo_tenants(2)')).rows.map((r) => r.tenant_id));
    await purgeTenantFiles(deps.blobs, ids);   // if this fails, the sweep retries the files
  } catch (err) {
    console.error(JSON.stringify({ demo: 'tidy', error: String((err as Error).message ?? err) }));
  }
}

async function endDemo(deps: Deps | SnapshotDeps, s: SessionContext): Promise<void> {
  const ended = await withSession(deps.db, s, (c) => one<{ ok: boolean }>(c, 'select epm.end_demo() as ok'));
  if (ended.ok) await purgeTenantFiles(deps.blobs, [s.tenantId]);
}

/** What /v1/me adds for a demo session. */
export async function demoInfo(c: Client, s: SessionContext, email: string) {
  if (!s.demo) return null;
  const row = await maybeOne<{ expires_at: string }>(c, 'select demo_expires_at as expires_at from epm.tenant where tenant_id = $1', [s.tenantId]);
  return row ? { expires_at: row.expires_at, persona: personaOf(email)?.key ?? null, personas: publicPersonas() } : null;
}
