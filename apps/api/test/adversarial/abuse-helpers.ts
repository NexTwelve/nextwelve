/**
 * Shared helpers for the adversarial backup/restore suites: a harness whose blob store and
 * database can be told to misbehave, a superuser connection, and bulk writes through
 * epm.apply_changes as a signed-in user.
 */
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../../src/app.js';
import { createGoogleVerifier } from '../../src/auth/google.js';
import { createSessionSigner } from '../../src/auth/session.js';
import { type Database } from '../../src/db.js';
import { type BlobStore, memoryBlobStore } from '../../src/files/blobs.js';
import type { App } from '../../src/routes/context.js';
import { createTestDb, FakeGoogle, TEST_CLIENT_ID, type TestDb } from '../helpers.js';

export interface BlobHooks {
  /** Runs before a put is stored; throw to fail it. Return 'store-then-throw' to store and then fail. */
  beforePut?: (key: string, data: Uint8Array) => Promise<void | 'store-then-throw'> | void | 'store-then-throw';
  /** Rewrites what a get returns. */
  afterGet?: (key: string, data: Uint8Array | null) => Uint8Array | null;
}

export interface QueryHook {
  (sql: string, params: unknown[] | undefined): Promise<void> | void;
}

export interface AbuseHarness {
  db: TestDb;
  pool: pg.Pool;
  app: App;
  google: FakeGoogle;
  /** The real bytes, underneath the hooks. */
  store: ReturnType<typeof memoryBlobStore>;
  blobs: BlobStore;
  database: Database;
  blobHooks: BlobHooks;
  /** Called before every query the API runs (not the superuser helpers). */
  queryHooks: QueryHook[];
  /** Errors the API reported as unexpected (its 500 path). */
  unexpected: unknown[];
  close(): Promise<void>;
}

/** createHarness, but with a blob store and database that tests can make fail. */
export async function createAbuseHarness(): Promise<AbuseHarness> {
  const db = await createTestDb();
  const pool = new pg.Pool({ connectionString: db.appUrl, max: 12 });
  pool.on('error', () => undefined); // idle clients killed by the forced drop at teardown
  const google = await FakeGoogle.create();
  const store = memoryBlobStore();
  const blobHooks: BlobHooks = {};
  const queryHooks: QueryHook[] = [];
  const unexpected: unknown[] = [];

  const blobs: BlobStore = {
    async put(key, data, contentType) {
      const r = await blobHooks.beforePut?.(key, data);
      await store.put(key, data, contentType);
      if (r === 'store-then-throw') throw new Error(`storage timed out writing ${key}`);
    },
    async get(key) {
      const v = await store.get(key);
      return blobHooks.afterGet ? blobHooks.afterGet(key, v) : v;
    },
    async delete(keys) {
      await store.delete(keys);
    },
    async list(prefix) {
      return store.list(prefix);
    },
  };

  const database: Database = {
    async connect() {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      const proxy = new Proxy(client, {
        get(target, prop) {
          if (prop === 'query') {
            return async (...args: unknown[]) => {
              for (const h of queryHooks) await h(String(args[0]), args[1] as unknown[] | undefined);
              return query(...args);
            };
          }
          const v = Reflect.get(target, prop);
          return typeof v === 'function' ? v.bind(target) : v;
        },
      });
      return { client: proxy as unknown as pg.ClientBase, release: () => client.release() };
    },
  };

  const app = createApp({
    db: database,
    blobs,
    signer: createSessionSigner(randomBytes(32), 900),
    verifier: createGoogleVerifier({ audiences: [TEST_CLIENT_ID], keys: google.keys() }),
    onUnexpectedError: (err) => unexpected.push(err),
  });
  return {
    db, pool, app, google, store, blobs, database, blobHooks, queryHooks, unexpected,
    async close() {
      await pool.end();
      await db.drop();
    },
  };
}

/** A superuser connection to the test database (bypasses RLS). */
export async function superuser(db: TestDb): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: db.superUrl });
  await c.connect();
  return c;
}

/** Run fn in a transaction as the epm_app role with a tenant and user in the session. */
export async function asUser<T>(pool: pg.Pool, tenantId: string, email: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const user = (await c.query<{ user_id: string }>('select user_id from epm.app_user where lower(email) = lower($1)', [email])).rows[0]!.user_id;
    await c.query("select set_config('app.user_id', $1, true)", [user]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** member name -> id per dimension name, for one application (superuser read). */
export async function memberIds(db: TestDb, appId: string): Promise<Record<string, Record<string, number>>> {
  const su = await superuser(db);
  try {
    const res = await su.query<{ dim: string; name: string; member_id: number }>(
      `select d.name as dim, m.name, m.member_id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1`,
      [appId],
    );
    const out: Record<string, Record<string, number>> = {};
    for (const r of res.rows) (out[r.dim] ??= {})[r.name] = r.member_id;
    return out;
  } finally {
    await su.end();
  }
}

export async function cubeId(db: TestDb, appId: string, name = 'Plan'): Promise<number> {
  const su = await superuser(db);
  try {
    return (await su.query<{ cube_id: number }>('select cube_id from epm.cube where app_id = $1 and name = $2', [appId, name])).rows[0]!.cube_id;
  } finally {
    await su.end();
  }
}

/** Write cells straight through apply_changes, in batches; returns the txn ids. */
export async function bulkWrite(
  pool: pg.Pool, tenantId: string, email: string, appId: string, cells: { k: number[]; v: number | null }[], batch = 25_000,
): Promise<number[]> {
  const txns: number[] = [];
  for (let i = 0; i < cells.length; i += batch) {
    const r = await asUser(pool, tenantId, email, (c) =>
      c.query<{ r: { txn_id: number } }>('select epm.apply_changes($1::jsonb) as r', [
        JSON.stringify({ app_id: appId, source: 'api', cells: cells.slice(i, i + batch) }),
      ]),
    );
    txns.push(r.rows[0]!.r.txn_id);
  }
  return txns;
}

/** Keys currently stored under a snapshot's prefix. */
export function keysUnder(h: AbuseHarness, prefix: string): string[] {
  return h.store.keys().filter((k) => k.startsWith(prefix));
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A Plan app with `products` extra Product leaves and products x 6 months x 2 entities x 3 accounts cells
 * in Budget/Working (108,000 for 3,000 products), written in bulk after an empty snapshot is taken.
 */
export async function buildBigApp(
  h: AbuseHarness, admin: { post: (u: string, b?: unknown) => Promise<{ status: number; body: any }> },
  tenantId: string, email: string, appId: string, products: number,
): Promise<{ emptySnap: any; txns: number[]; total: number }> {
  const base = `/v1/apps/${appId}`;
  const su = await superuser(h.db);
  await su.query(
    `insert into epm.member (tenant_id, dim_id, name, parent_id, sort_order)
     select d.tenant_id, d.dim_id, 'P' || g, p.member_id, 100 + g
       from epm.dimension d join epm.member p on p.dim_id = d.dim_id and p.name = 'All Products', generate_series(0, $2 - 1) g
      where d.app_id = $1 and d.name = 'Product'`,
    [appId, products],
  );
  await su.end();
  const dep = await admin.post(`${base}/deploy`);
  if (dep.status !== 200) throw new Error(`deploy failed: ${JSON.stringify(dep.body)}`);
  const snap = await admin.post(`${base}/snapshots`, { comment: 'before any data' });
  if (snap.status !== 201) throw new Error(`snapshot failed: ${JSON.stringify(snap.body)}`);

  const ids = await memberIds(h.db, appId);
  const cube = await cubeId(h.db, appId);
  const cells: { k: number[]; v: number }[] = [];
  for (let p = 0; p < products; p++) for (const month of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']) for (const e of ['East', 'West']) for (const a of ['Revenue', 'COGS', 'Opex']) {
    const k = new Array<number>(16).fill(0);
    k[0] = cube; k[1] = ids.Scenario!.Budget!; k[2] = ids.Version!.Working!; k[3] = ids.Years!.FY27!; k[4] = ids.Period![month]!;
    k[5] = ids.Entity![e]!; k[6] = ids.Account![a]!; k[7] = ids.Department!.Sales!; k[8] = ids.Product![`P${p}`]!;
    cells.push({ k, v: 1 + (cells.length % 997) });
  }
  const txns = await bulkWrite(h.pool, tenantId, email, appId, cells, 36_000);
  return { emptySnap: snap.body, txns, total: cells.length };
}
