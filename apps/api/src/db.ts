import pg from 'pg';
import { fromPgError, HttpError } from './errors.js';

// bigint (txn ids) and numeric (cell values) come back as JS numbers.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

/** Anything that runs queries: a pooled client in Node or a per-request client over Hyperdrive. */
export type Client = pg.ClientBase;

export interface DbConnection {
  client: Client;
  release(): Promise<void> | void;
}

/** Where connections come from. Node uses a pool; Workers open one client per use through Hyperdrive. */
export interface Database {
  connect(): Promise<DbConnection>;
}

export function poolDatabase(pool: pg.Pool): Database {
  return {
    async connect() {
      const client = await pool.connect();
      return { client, release: () => client.release() };
    },
  };
}

/**
 * Hyperdrive keeps the real connection pool next to the database, so a Worker opens a
 * fresh client for each use and closes it when done. Hyperdrive pools per transaction and
 * resets session state, which is why every request runs inside one transaction that sets
 * the tenant and user with set_config(..., true).
 */
export function hyperdriveDatabase(connectionString: string): Database {
  return {
    async connect() {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return { client, release: () => client.end() };
    },
  };
}

export interface SessionContext {
  userId: string;
  tenantId: string;
  /** A public demo session: a sandbox tenant, with some actions blocked (see demo.ts). */
  demo?: boolean;
  /**
   * A phone paired by QR code (devices.ts): only read routes are allowed, its transactions are
   * READ ONLY in Postgres, and each one checks that its device link is still active.
   */
  readOnly?: boolean;
  linkId?: string;
}

export interface TxOptions {
  /**
   * One consistent view of the data for the whole transaction (snapshot exports). Writes
   * through apply_changes need the default READ COMMITTED.
   */
  snapshot?: boolean;
  /** A READ ONLY transaction (phone sessions): Postgres refuses any write. */
  readOnly?: boolean;
}

async function inTransaction<T>(db: Database, setup: (c: Client) => Promise<void>, fn: (c: Client) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  const conn = await db.connect();
  const c = conn.client;
  try {
    await c.query(opts.snapshot ? 'begin isolation level repeatable read read only' : opts.readOnly ? 'begin read only' : 'begin');
    await setup(c);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw fromPgError(err) ?? err;
  } finally {
    await conn.release();
  }
}

/**
 * Run fn in one READ COMMITTED transaction with the tenant and user set for RLS.
 * The user must still be active: disabling a user cuts off their next request.
 */
export function withSession<T>(db: Database, ctx: SessionContext, fn: (c: Client) => Promise<T>, opts?: TxOptions): Promise<T> {
  if (ctx.readOnly) {
    // A phone: read only in Postgres too, and only while its device link is active.
    return inTransaction(
      db,
      async (c) => {
        await c.query(
          `select epm.require_active_user(), epm.require_device_link($3::uuid)
             from (select set_config('app.tenant_id', $1, true) as t, set_config('app.user_id', $2, true) as u) s`,
          [ctx.tenantId, ctx.userId, ctx.linkId ?? null],
        );
      },
      fn,
      { ...opts, readOnly: true },
    );
  }
  return inTransaction(
    db,
    async (c) => {
      // One round trip: the subquery sets the context before the active-user check reads it.
      await c.query(
        `select epm.require_active_user()
           from (select set_config('app.tenant_id', $1, true) as t, set_config('app.user_id', $2, true) as u) s`,
        [ctx.tenantId, ctx.userId],
      );
    },
    fn,
    opts,
  );
}

/**
 * Who a background job acts for: a signed-in user (manual actions) or a tenant with no user
 * (scheduled jobs). With no user, RLS still confines every query to the tenant, and functions
 * that need a user (apply_changes, deploy) refuse to run.
 */
export type Actor = SessionContext | { tenantId: string; userId: null };

export function withActor<T>(db: Database, actor: Actor, fn: (c: Client) => Promise<T>, opts?: TxOptions): Promise<T> {
  if (actor.userId !== null) return withSession(db, actor as SessionContext, fn, opts);
  return inTransaction(
    db,
    async (c) => {
      await c.query("select set_config('app.tenant_id', $1, true)", [actor.tenantId]);
    },
    fn,
    opts,
  );
}

/** A transaction with no tenant context (used only for login). */
export function withoutSession<T>(db: Database, fn: (c: Client) => Promise<T>): Promise<T> {
  return inTransaction(db, async () => undefined, fn);
}

export async function one<T extends pg.QueryResultRow>(c: Client, sql: string, params: unknown[] = [], notFound = 'not found'): Promise<T> {
  const res = await c.query<T>(sql, params);
  const row = res.rows[0];
  if (!row) throw new HttpError(404, notFound);
  return row;
}

export async function maybeOne<T extends pg.QueryResultRow>(c: Client, sql: string, params: unknown[] = []): Promise<T | undefined> {
  const res = await c.query<T>(sql, params);
  return res.rows[0];
}

export const ROLE_RANK: Record<string, number> = {
  service_admin: 5,
  app_admin: 4,
  power_user: 3,
  planner: 2,
  viewer: 1,
};

/** The caller's role in an application (or tenant-wide when appId is null); throws 403 below min. */
export async function requireRole(c: Client, appId: string | null, min: keyof typeof ROLE_RANK): Promise<string> {
  const row = await maybeOne<{ role: string | null }>(c, 'select epm.user_app_role($1) as role', [appId]);
  const role = row?.role ?? null;
  if ((ROLE_RANK[role ?? ''] ?? 0) < ROLE_RANK[min]!) {
    throw new HttpError(403, `requires role ${min} or higher`);
  }
  return role!;
}

/** The tenant-only actor for work done on behalf of a job or a failed request (marking, cleanup). */
export const systemActor = (tenantId: string): Actor => ({ tenantId, userId: null });

/**
 * Run fn again when the database says the data moved under it (SQLSTATE NXRTY, raised by the
 * restore checks); other errors pass straight through.
 */
export async function retrying<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let n = 1; ; n++) {
    try {
      return await fn();
    } catch (err) {
      if (n >= attempts || !(err instanceof HttpError) || err.code !== 'NXRTY') throw err;
    }
  }
}
