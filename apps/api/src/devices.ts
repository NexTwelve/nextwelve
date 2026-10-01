import { encode } from 'uqr';
import { z } from 'zod';
import { maybeOne, one, type SessionContext, withoutSession, withSession } from './db.js';
import { HttpError } from './errors.js';
import { sha256Hex } from './files/hash.js';
import type { App, Ctx, Deps } from './routes/context.js';
import { readJson, sessionOf } from './routes/context.js';

/**
 * Read-only access from a phone, paired by QR code.
 *
 *   1. On the computer, a signed-in user asks for a code (POST /v1/devices/links). The QR code
 *      holds a one-time secret that is valid for two minutes, in the URL fragment so it is never
 *      sent to a server or logged.
 *   2. The phone opens /m/ and claims the code (POST /v1/devices/claim). The code cannot be used
 *      again. The phone is shown a two-digit number.
 *   3. The user types that number on the computer to approve (POST …/links/:id/approve). A code
 *      photographed by someone else is therefore useless: their phone shows them the number,
 *      not the user.
 *   4. The phone collects a read-only session once (POST /v1/devices/claim/poll). It acts as the
 *      same user, so member-level security still applies; it may call only the read routes listed
 *      below; its transactions are READ ONLY in Postgres; and each request checks that the link is
 *      still active, so revoking it (from either side) ends access at once.
 */

const PAIRING_SECONDS = 120;          // the QR code
const CLAIM_SECONDS = 300;            // a claimed code waiting for the number
const COLLECT_SECONDS = 300;          // an approved link waiting for the phone to collect its session
const PHONE_SESSION_HOURS = 8;
const MAX_ACTIVE_PER_USER = 5;
const MAX_NEW_PER_10_MIN = 10;
const MAX_MATCH_ATTEMPTS = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

// ---------------------------------------------------------------------------
// What a phone may do
// ---------------------------------------------------------------------------
const READ_ROUTES: [string, RegExp][] = [
  ['GET', /^\/v1\/me$/],
  ['GET', /^\/v1\/apps$/],
  ['GET', /^\/v1\/apps\/[^/]+\/(forms|reports)$/],
  ['GET', /^\/v1\/apps\/[^/]+\/(forms|reports)\/[^/]+$/],
  ['POST', /^\/v1\/apps\/[^/]+\/forms\/[^/]+\/open$/],
  ['POST', /^\/v1\/apps\/[^/]+\/reports\/[^/]+\/run$/],
  ['POST', /^\/v1\/apps\/[^/]+\/grid\/read$/],
  ['POST', /^\/v1\/apps\/[^/]+\/(history|drill)$/],
  ['GET', /^\/v1\/apps\/[^/]+\/dimensions$/],
  ['GET', /^\/v1\/apps\/[^/]+\/dimensions\/[^/]+\/members$/],
  ['GET', /^\/v1\/devices\/current$/],
  ['DELETE', /^\/v1\/devices\/current$/],
];

/** Refuse anything but the read routes to a phone session. */
export function readOnlyGuard(c: Ctx, s: SessionContext): void {
  if (!s.readOnly) return;
  const method = c.req.method;
  const path = c.req.path;
  const allowed = READ_ROUTES.some(([m, re]) => m === method && re.test(path));
  // Reports are read on the phone, not downloaded (a download is logged, which is a write).
  const download = /\/reports\/[^/]+\/run$/.test(path) && (c.req.query('format') ?? 'json') !== 'json';
  if (!allowed || download) throw new HttpError(403, 'this phone has read-only access');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function matchCode(): string {
  return String(10 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 90));
}

const hashOf = (secret: string) => sha256Hex(new TextEncoder().encode(secret));

/** A short description of the phone from its User-Agent, shown on the computer before approval. */
export function deviceLabel(ua: string | undefined): string {
  const s = ua ?? '';
  const device = /iPad/.test(s) ? 'iPad' : /iPhone/.test(s) ? 'iPhone' : /Android/.test(s) ? 'Android' : /Macintosh/.test(s) ? 'Mac'
    : /Windows/.test(s) ? 'Windows' : /Linux/.test(s) ? 'Linux' : 'Unknown device';
  const browser = /EdgA?\//.test(s) ? 'Edge' : /SamsungBrowser\//.test(s) ? 'Samsung Internet' : /Firefox\/|FxiOS\//.test(s) ? 'Firefox'
    : /CriOS\/|Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'a browser';
  return `${device} · ${browser}`;
}

/** The QR code as a compact SVG (one path of horizontal runs). */
export function qrSvg(text: string): string {
  const { data, size } = encode(text, { ecc: 'M', border: 2 });
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y]![x]) { x++; continue; }
      const start = x;
      while (x < size && data[y]![x]) x++;
      d += `M${start} ${y}h${x - start}v1h-${x - start}z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">`
    + `<rect width="${size}" height="${size}" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

/** "<tenant>.<link>.<secret>" from a QR code or a claim; anything malformed is simply not found. */
function parseRef(ref: string): { tenantId: string; linkId: string; secret: string } {
  const [tenantId, linkId, secret, extra] = ref.split('.');
  if (extra !== undefined || !tenantId || !linkId || !secret || !UUID.test(tenantId) || !UUID.test(linkId) || !SECRET.test(secret)) {
    throw new HttpError(404, 'this code is not valid; show a new one on your computer');
  }
  return { tenantId, linkId, secret };
}

interface LinkRow {
  link_id: string;
  user_id: string;
  status: string;
  code_hash: string;
  claim_hash: string | null;
  match_code: string | null;
  match_attempts: number;
  device_label: string | null;
  code_expires_at: string;
  claimed_at: string | null;
  approved_at: string | null;
  activated_at: string | null;
  session_expires_at: string | null;
  code_expired: boolean;
  claim_expired: boolean;
  collect_expired: boolean;
}

const LINK_COLUMNS = `link_id, user_id, status, encode(code_hash, 'hex') as code_hash, encode(claim_hash, 'hex') as claim_hash,
  match_code, match_attempts, device_label, code_expires_at, claimed_at, approved_at, activated_at, session_expires_at,
  code_expires_at < now() as code_expired,
  coalesce(claimed_at < now() - make_interval(secs => ${CLAIM_SECONDS}), false) as claim_expired,
  coalesce(approved_at < now() - make_interval(secs => ${COLLECT_SECONDS}), false) as collect_expired`;

/** The status a link has now, expiring it on the way when its time is up. */
async function current(c: { query: (sql: string, params?: unknown[]) => Promise<unknown> }, row: LinkRow): Promise<string> {
  const stale = (row.status === 'pending' && row.code_expired) || (row.status === 'claimed' && row.claim_expired)
    || (row.status === 'approved' && row.collect_expired);
  if (!stale) return row.status;
  await c.query(`update epm.device_link set status = 'expired' where link_id = $1`, [row.link_id]);
  return 'expired';
}

const ApproveBody = z.object({ match: z.string().regex(/^\d{2}$/, 'enter the two-digit number shown on the phone') });
const ClaimBody = z.object({ code: z.string().max(200) });
const PollBody = z.object({ claim: z.string().max(200) });

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
export function deviceRoutes(app: App, deps: Deps) {
  const { db, signer } = deps;

  // --- On the computer -------------------------------------------------------------------
  app.post('/v1/devices/links', async (hc) => {
    const s = sessionOf(hc);
    const secret = randomSecret();
    const codeHash = await hashOf(secret);
    const row = await withSession(db, s, async (c) => {
      const counts = await one<{ recent: number; active: number }>(
        c,
        `select count(*) filter (where created_at > now() - interval '10 minutes')::int as recent,
                count(*) filter (where status = 'active' and session_expires_at > now())::int as active
           from epm.device_link where user_id = $1`,
        [s.userId],
      );
      if (counts.recent >= MAX_NEW_PER_10_MIN) throw new HttpError(429, 'too many codes in the last few minutes; try again shortly');
      if (counts.active >= MAX_ACTIVE_PER_USER) throw new HttpError(409, `you have ${MAX_ACTIVE_PER_USER} phones connected; disconnect one first`);
      return one<{ link_id: string; code_expires_at: string }>(
        c,
        `insert into epm.device_link (tenant_id, user_id, code_hash, code_expires_at)
         values ($1, $2, decode($3, 'hex'), now() + make_interval(secs => ${PAIRING_SECONDS}))
         returning link_id, code_expires_at`,
        [s.tenantId, s.userId, codeHash],
      );
    });
    const origin = new URL(hc.req.url).origin;
    const url = `${origin}/m/#${s.tenantId}.${row.link_id}.${secret}`;
    return hc.json({ link_id: row.link_id, url, qr_svg: qrSvg(url), expires_at: row.code_expires_at, expires_in: PAIRING_SECONDS }, 201);
  });

  app.get('/v1/devices/links/:linkId', async (hc) => {
    const s = sessionOf(hc);
    const linkId = hc.req.param('linkId');
    if (!UUID.test(linkId)) throw new HttpError(404, 'no such code');
    return hc.json(await withSession(db, s, async (c) => {
      const row = await maybeOne<LinkRow>(c, `select ${LINK_COLUMNS} from epm.device_link where link_id = $1 and user_id = $2 for update`, [linkId, s.userId]);
      if (!row) throw new HttpError(404, 'no such code');
      const status = await current(c, row);
      return { link_id: row.link_id, status, device_label: row.device_label, expires_at: row.code_expires_at };
    }));
  });

  app.post('/v1/devices/links/:linkId/approve', async (hc) => {
    const s = sessionOf(hc);
    const linkId = hc.req.param('linkId');
    if (!UUID.test(linkId)) throw new HttpError(404, 'no such code');
    const body = ApproveBody.parse(await readJson(hc));
    // Not thrown inside the transaction: a wrong number must still be counted.
    const outcome = await withSession(db, s, async (c) => {
      const row = await maybeOne<LinkRow>(c, `select ${LINK_COLUMNS} from epm.device_link where link_id = $1 and user_id = $2 for update`, [linkId, s.userId]);
      if (!row) return { error: new HttpError(404, 'no such code') };
      const status = await current(c, row);
      if (status !== 'claimed') return { error: new HttpError(409, status === 'pending' ? 'no phone has scanned this code yet' : `this code is ${status}`) };
      if (body.match !== row.match_code) {
        const attempts = row.match_attempts + 1;
        const denied = attempts >= MAX_MATCH_ATTEMPTS;
        await c.query(`update epm.device_link set match_attempts = $2, status = case when $3 then 'denied' else status end where link_id = $1`, [linkId, attempts, denied]);
        return {
          error: denied
            ? new HttpError(409, 'that was the last try; show a new code to connect the phone')
            : new HttpError(422, 'that number does not match the one on the phone'),
        };
      }
      await c.query(`update epm.device_link set status = 'approved', approved_at = now() where link_id = $1`, [linkId]);
      await c.query(
        `insert into epm.security_event (tenant_id, user_id, event_type, detail) values ($1, $2, 'device_link_approved', $3)`,
        [s.tenantId, s.userId, { link_id: linkId, device: row.device_label }],
      );
      return { error: null };
    });
    if (outcome.error) throw outcome.error;
    return hc.json({ link_id: linkId, status: 'approved' });
  });

  app.post('/v1/devices/links/:linkId/deny', async (hc) => {
    const s = sessionOf(hc);
    const linkId = hc.req.param('linkId');
    if (!UUID.test(linkId)) throw new HttpError(404, 'no such code');
    await withSession(db, s, (c) =>
      c.query(`update epm.device_link set status = 'denied' where link_id = $1 and user_id = $2 and status in ('pending', 'claimed', 'approved')`, [linkId, s.userId]));
    return hc.json({ link_id: linkId, status: 'denied' });
  });

  // Phones connected to this user.
  app.get('/v1/devices', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => ({
      devices: (await c.query(
        `select link_id, device_label, activated_at, session_expires_at from epm.device_link
          where user_id = $1 and status = 'active' and session_expires_at > now() order by activated_at desc`,
        [s.userId],
      )).rows,
    })));
  });

  app.delete('/v1/devices/:linkId', async (hc) => {
    const s = sessionOf(hc);
    const linkId = hc.req.param('linkId');
    if (linkId === 'current') return endCurrent(hc, s);
    if (!UUID.test(linkId)) throw new HttpError(404, 'no such phone');
    const revoked = await revoke(s, linkId, 'computer');
    if (!revoked) throw new HttpError(404, 'no such phone');
    return hc.json({ link_id: linkId, status: 'revoked' });
  });

  // --- On the phone ------------------------------------------------------------------------
  // Claim a scanned code (public: the code is the credential).
  app.post('/v1/devices/claim', async (hc) => {
    const body = ClaimBody.parse(await readJson(hc));
    const ref = parseRef(body.code);
    const codeHash = await hashOf(ref.secret);
    const claimSecret = randomSecret();
    const claimHash = await hashOf(claimSecret);
    const match = matchCode();
    const label = deviceLabel(hc.req.header('user-agent')).slice(0, 120);
    const result = await withoutSession(db, async (c) => {
      await c.query(`select set_config('app.tenant_id', $1, true)`, [ref.tenantId]);
      const row = await maybeOne<LinkRow>(c, `select ${LINK_COLUMNS} from epm.device_link where link_id = $1 for update`, [ref.linkId]);
      if (!row || row.code_hash !== codeHash) return { error: new HttpError(404, 'this code is not valid; show a new one on your computer') };
      const status = await current(c, row);
      if (status === 'expired') return { error: new HttpError(410, 'this code has expired; show a new one on your computer') };
      if (status !== 'pending') return { error: new HttpError(410, 'this code has been used already; show a new one on your computer') };
      await c.query(
        `update epm.device_link set status = 'claimed', claimed_at = now(), claim_hash = decode($2, 'hex'), match_code = $3, device_label = $4
          where link_id = $1`,
        [ref.linkId, claimHash, match, label],
      );
      return { error: null };
    });
    if (result.error) throw result.error;
    return hc.json({ claim: `${ref.tenantId}.${ref.linkId}.${claimSecret}`, match, device_label: label, wait_seconds: CLAIM_SECONDS });
  });

  // Has the computer approved? If so, hand over the read-only session (once).
  app.post('/v1/devices/claim/poll', async (hc) => {
    const body = PollBody.parse(await readJson(hc));
    const ref = parseRef(body.claim);
    const claimHash = await hashOf(ref.secret);
    const out = await withoutSession(db, async (c) => {
      await c.query(`select set_config('app.tenant_id', $1, true)`, [ref.tenantId]);
      const row = await maybeOne<LinkRow>(c, `select ${LINK_COLUMNS} from epm.device_link where link_id = $1 for update`, [ref.linkId]);
      if (!row || !row.claim_hash || row.claim_hash !== claimHash) return { status: 'invalid' as const };
      const status = await current(c, row);
      if (status !== 'approved') return { status };
      const t = await one<{ demo_left: number | null }>(
        c,
        `select extract(epoch from demo_expires_at - now())::int as demo_left from epm.tenant where tenant_id = $1`,
        [ref.tenantId],
      );
      const isDemo = t.demo_left !== null;
      const ttl = Math.min(PHONE_SESSION_HOURS * 3600, isDemo ? Math.max(0, t.demo_left!) : Infinity);
      if (ttl < 60) return { status: 'expired' };
      const expires = await one<{ at: string }>(
        c,
        `update epm.device_link set status = 'active', activated_at = now(), session_expires_at = now() + make_interval(secs => $2)
          where link_id = $1 returning session_expires_at as at`,
        [ref.linkId, ttl],
      );
      const issued = await signer.issue(
        { userId: row.user_id, tenantId: ref.tenantId, readOnly: true, linkId: ref.linkId, ...(isDemo ? { demo: true } : {}) },
        ttl,
      );
      return { status: 'issued' as const, session_token: issued.token, expires_in: issued.expiresIn, expires_at: expires.at };
    });
    if (out.status === 'invalid') throw new HttpError(404, 'this phone is not waiting for approval; scan a new code');
    if (out.status === 'issued') return hc.json({ ...out, status: 'approved' });
    if (out.status === 'claimed') return hc.json({ status: 'waiting' });
    // Collected already (a session is handed out once), denied, revoked or expired.
    return hc.json({ status: out.status === 'active' ? 'used' : out.status }, 410);
  });

  // The phone itself: what it is connected as, and disconnecting.
  app.get('/v1/devices/current', async (hc) => {
    const s = sessionOf(hc);
    if (!s.readOnly) throw new HttpError(404, 'this is not a phone session');
    return hc.json(await withSession(db, s, async (c) =>
      one(c, `select l.link_id, l.device_label, l.session_expires_at, u.email, u.display_name
                from epm.device_link l join epm.app_user u on u.user_id = l.user_id where l.link_id = $1`, [s.linkId])));
  });

  async function endCurrent(hc: Ctx, s: SessionContext) {
    if (!s.readOnly || !s.linkId) throw new HttpError(404, 'this is not a phone session');
    await revoke(s, s.linkId, 'phone');
    return hc.json({ link_id: s.linkId, status: 'revoked' });
  }

  /** Revoke one of the user's links (a write, so it runs as an ordinary session of the same user). */
  async function revoke(s: SessionContext, linkId: string, by: 'computer' | 'phone'): Promise<boolean> {
    const writer: SessionContext = { userId: s.userId, tenantId: s.tenantId, ...(s.demo ? { demo: true } : {}) };
    return withSession(db, writer, async (c) => {
      const res = await c.query(
        `update epm.device_link set status = 'revoked', revoked_at = now()
          where link_id = $1 and user_id = $2 and status in ('pending', 'claimed', 'approved', 'active') returning device_label`,
        [linkId, s.userId],
      );
      if (!res.rowCount) return false;
      await c.query(
        `insert into epm.security_event (tenant_id, user_id, event_type, detail) values ($1, $2, 'device_link_revoked', $3)`,
        [s.tenantId, s.userId, { link_id: linkId, device: (res.rows[0] as { device_label: string | null }).device_label, by }],
      );
      return true;
    });
  }
}
