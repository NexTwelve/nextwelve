/**
 * Shared helpers for the adversarial suites on the public demo: a harness with the demo turned on
 * whose session secret is known (to forge tokens) and whose blob store and database can be told
 * to misbehave, a small template like the sample's, and a way to start demos from any address.
 */
import { randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { createGoogleVerifier } from '../../src/auth/google.js';
import { createSessionSigner, type SessionSigner } from '../../src/auth/session.js';
import { createSnapshot } from '../../src/backup/snapshots.js';
import { type Database, poolDatabase } from '../../src/db.js';
import { DEMO_PERSONAS, type DemoConfig, storeTemplate } from '../../src/demo.js';
import { memoryBlobStore } from '../../src/files/blobs.js';
import { Api, createTestDb, expectOk, FakeGoogle, type Harness, PLAN_POV, provisionTenant, seedPlanApp, signIn, TEST_CLIENT_ID } from '../helpers.js';

export const [ADMIN, PLANNER, VIEWER] = DEMO_PERSONAS as [typeof DEMO_PERSONAS[number], typeof DEMO_PERSONAS[number], typeof DEMO_PERSONAS[number]];
export const DEMO: DemoConfig = { enabled: true, maxLive: 50, perIpHour: 50, hours: 24, ipSalt: 'adversarial-salt' };

export interface DemoBlobHooks {
  beforePut?: (key: string) => Promise<void> | void;
  beforeDelete?: (keys: string[]) => Promise<void> | void;
}
export type DemoQueryHook = (sql: string, params: unknown[] | undefined) => Promise<void> | void;

export interface DemoHarness extends Harness {
  secret: Uint8Array;
  signer: SessionSigner;
  store: ReturnType<typeof memoryBlobStore>;
  blobHooks: DemoBlobHooks;
  queryHooks: DemoQueryHook[];
  unexpected: unknown[];
}

/** createHarness with the demo on, a known session secret, and hookable storage and queries. */
export async function createDemoHarness(demo: DemoConfig | undefined = DEMO): Promise<DemoHarness> {
  const db = await createTestDb();
  const pool = new pg.Pool({ connectionString: db.appUrl, max: 12 });
  pool.on('error', () => undefined);
  const google = await FakeGoogle.create();
  const store = memoryBlobStore();
  const blobHooks: DemoBlobHooks = {};
  const queryHooks: DemoQueryHook[] = [];
  const unexpected: unknown[] = [];
  const blobs: ReturnType<typeof memoryBlobStore> = {
    async put(key, data, contentType) {
      await blobHooks.beforePut?.(key);
      await store.put(key, data, contentType);
    },
    get: (key) => store.get(key),
    async delete(keys) {
      await blobHooks.beforeDelete?.(keys);
      await store.delete(keys);
    },
    list: (prefix) => store.list(prefix),
    keys: () => store.keys(),
  };
  const base = poolDatabase(pool);
  const database: Database = {
    async connect() {
      const conn = await base.connect();
      const client = conn.client;
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      const proxy = new Proxy(client, {
        get(target, prop) {
          if (prop === 'query') {
            return async (...args: unknown[]) => {
              for (const hook of queryHooks) await hook(String(args[0]), args[1] as unknown[] | undefined);
              return query(...args);
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      return { client: proxy as unknown as pg.ClientBase, release: conn.release };
    },
  };
  const secret = new Uint8Array(randomBytes(32));
  const signer = createSessionSigner(secret, 900);
  const app = createApp({
    db: database,
    blobs,
    signer,
    verifier: createGoogleVerifier({ audiences: [TEST_CLIENT_ID], keys: google.keys() }),
    onUnexpectedError: (err) => unexpected.push(err),
    demo,
  });
  return {
    db, pool, app, google, blobs, secret, signer, store, blobHooks, queryHooks, unexpected,
    async close() {
      await pool.end();
      await db.drop();
    },
  };
}

export const FORM = {
  cube: 'Plan',
  folder: 'Revenue',
  description: 'Revenue by account and month',
  definition: {
    pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales' },
    page: { Entity: ['@leaves(Total Company)'], Product: ['Widgets', 'Gadgets'] },
    rows: { dimension: 'Account', members: ['@idescendants(Gross Margin)'] },
    columns: { dimension: 'Period', members: ['@leaves(Q1)', 'Q1'] },
  },
};

export const IMPORT_FORMAT = {
  cube: 'Plan',
  definition: {
    header_row: 1,
    dimensions: {
      Scenario: { value: 'Actual' }, Version: { value: 'Working' }, Years: { value: 'FY27' },
      Period: { column: 'Month' }, Entity: { column: 'Company' }, Account: { column: 'Account' },
      Department: { value: 'Sales' }, Product: { value: 'Widgets' },
    },
    amount: { column: 'Amount' },
  },
};
export const MAPPINGS = [
  { dimension: 'Entity', rule_type: 'explicit', source: 'E01', target: 'East' },
  { dimension: 'Entity', rule_type: 'explicit', source: 'W01', target: 'West' },
];

/**
 * A small template like the sample's: the plan app with data, a report, a form, an import format,
 * a planner who may write East and a viewer of everything. The build tenant is removed after.
 */
export async function buildTemplate(h: DemoHarness): Promise<{ snapshotId: string }> {
  const tenantId = await provisionTenant(h.db, 'Template build', null, ADMIN.email);
  const admin = await signIn(h, ADMIN.email);
  const appId = await seedPlanApp(admin, 'Fernhollow Operating Plan');
  const base = `/v1/apps/${appId}`;
  for (const [p, role] of [[PLANNER, 'planner'], [VIEWER, 'viewer']] as const) {
    expectOk(await admin.post('/v1/users', { email: p.email }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: p.email, role }));
  }
  expectOk(await admin.put(`${base}/grants`, {
    grants: [
      { principal: { user: PLANNER.email }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' },
      { principal: { user: VIEWER.email }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'read' },
    ],
  }));
  const g = expectOk(await admin.post(`${base}/grid/read`, { cube: 'Plan', pov: PLAN_POV, rows: { dimension: 'Account', members: ['Revenue', 'COGS'] }, columns: { dimension: 'Period', members: ['Jan', 'Feb'] } }));
  expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[100, 110], [40, 44]] }));
  expectOk(await admin.put(`${base}/reports/Margin`, {
    cube: 'Plan',
    definition: { pov: { ...PLAN_POV }, rows: [{ dimension: 'Account', members: ['Revenue', 'COGS'] }], columns: [{ dimension: 'Period', members: ['Jan', 'Feb'] }] },
  }));
  expectOk(await admin.put(`${base}/forms/Revenue Entry`, FORM));
  expectOk(await admin.put(`${base}/import-formats/GL`, IMPORT_FORMAT));
  expectOk(await admin.put(`${base}/import-formats/GL/mappings`, { rules: MAPPINGS }));
  const me = expectOk(await admin.get('/v1/me'));
  const snap = await createSnapshot({ db: poolDatabase(h.pool), blobs: h.store }, { userId: me.user_id, tenantId }, appId, { kind: 'manual' });
  const owner = new pg.Client({ connectionString: h.db.ownerUrl });
  await owner.connect();
  try {
    await storeTemplate(owner, h.store, snap);
    await owner.query("update epm.tenant set demo_expires_at = now() + interval '1 hour' where tenant_id = $1", [tenantId]);
    await owner.query('select epm.purge_tenant($1)', [tenantId]);
  } finally {
    await owner.end();
  }
  for (const k of await h.store.list(`${tenantId}/`)) await h.store.delete([k]);
  return { snapshotId: snap.snapshot_id };
}

export interface Started {
  status: number;
  body: any;
  api: Api;
  token: string;
}

/** POST /v1/demo/session as a visitor from `ip` (CF-Connecting-IP unless headers say otherwise). */
export async function startDemo(
  h: Harness, ip: string | null, opts: { token?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Started> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(ip ? { 'cf-connecting-ip': ip } : {}), ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const r = await h.app.request('/v1/demo/session', { method: 'POST', headers, body: JSON.stringify(opts.body ?? {}) });
  const text = await r.text();
  const body = text ? JSON.parse(text) : undefined;
  const token = body?.session_token ?? '';
  return { status: r.status, body, api: new Api(h.app, token || null), token };
}

/** Start a demo that must succeed; returns the admin Api, its app id and tenant id. */
export async function startOk(h: Harness, ip: string): Promise<{ api: Api; appId: string; tenantId: string; token: string; body: any }> {
  const r = await startDemo(h, ip);
  if (r.status !== 201) throw new Error(`demo start failed: ${r.status} ${JSON.stringify(r.body)}`);
  const payload = JSON.parse(Buffer.from(r.token.split('.')[1]!, 'base64url').toString('utf8')) as { tid: string };
  return { api: r.api, appId: r.body.app_id, tenantId: payload.tid, token: r.token, body: r.body };
}

/** A session token signed with the harness's secret, with any claims (to test what the server trusts). */
export async function forgeToken(h: DemoHarness, claims: Record<string, unknown>, sub: string, expiresIn = '1h'): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuer('nextwelve')
    .setAudience('nextwelve-api')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(h.secret);
}

/** One query as the database superuser (no row-level security). */
export async function su<T = any>(h: Harness, sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: h.db.superUrl });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

/** Every epm table (not partitions) with a tenant_id column. */
export async function tenantTables(h: Harness): Promise<string[]> {
  const rows = await su<{ relname: string }>(h, `
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'epm' and c.relkind in ('r', 'p') and not c.relispartition
       and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
     order by 1`);
  return rows.map((r) => r.relname);
}

/** Rows left for a tenant, per table that still has any. */
export async function leftovers(h: Harness, tenantId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of await tenantTables(h)) {
    const [r] = await su<{ n: number }>(h, `select count(*)::int as n from epm.${t} where tenant_id = $1`, [tenantId]);
    if (r!.n > 0) out[t] = r!.n;
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A body the server cannot size up front (no Content-Length), as a chunked upload arrives. */
export function streamed(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let pos = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pos >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(pos, pos + 64 * 1024));
      pos += 64 * 1024;
    },
  });
}
