import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, createAbuseHarness, cubeId, memberIds, superuser } from './abuse-helpers.js';

/**
 * Second pass on the NXRTY re-plan: restore_slice and restoreInPlace write, plan again under the
 * chain lock, and raise NXRTY when a concurrent writer got in between; the API retries 3 times.
 * A writer that commits into the slice during every attempt (livelock), and one that does so once.
 */
describe('fix: restores that re-plan and retry (NXRTY)', () => {
  let h: AbuseHarness;
  let su: pg.Client;
  let admin: Api;
  let tenantId: string;
  let userId: string;
  let appId: string;
  let base: string;
  let ids: Record<string, Record<string, number>>;
  let cube: number;
  const pending: Promise<unknown>[] = [];

  const k = (o: { scenario?: string; version?: string; entity?: string; period?: string } = {}) => {
    const c = new Array<number>(16).fill(0);
    c[0] = cube; c[1] = ids.Scenario![o.scenario ?? 'Budget']!; c[2] = ids.Version![o.version ?? 'Working']!; c[3] = ids.Years!.FY27!;
    c[4] = ids.Period![o.period ?? 'Jan']!; c[5] = ids.Entity![o.entity ?? 'East']!; c[6] = ids.Account!.Revenue!; c[7] = ids.Department!.Sales!; c[8] = ids.Product!.Widgets!;
    return c;
  };
  async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantId, userId]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  const write = (cells: { k: number[]; v: string | null }[]) =>
    tx(async (c) => (await c.query('select epm.apply_changes($1::jsonb) as r', [JSON.stringify({ app_id: appId, source: 'api', cells })])).rows[0].r.txn_id as number);
  /** A writer that has written (and holds the chain lock) but commits only after `ms`. */
  async function lateWriter(cells: { k: number[]; v: string }[], ms = 250) {
    const c = await h.pool.connect();
    await c.query('begin');
    await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantId, userId]);
    await c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: appId, source: 'api', cells })]);
    pending.push(new Promise((r) => setTimeout(r, ms)).then(() => c.query('commit')).finally(() => c.release()));
  }
  const val = async (key: number[]) => (await su.query<{ v: string }>(
    `select value::text as v from epm.fact where app_id = $1 and (cube_id, scenario_id, version_id, years_id, period_id, entity_id, account_id,
       department_id, c1) = ($2, $3, $4, $5, $6, $7, $8, $9, $10)`, [appId, ...key.slice(0, 9)])).rows[0]?.v ?? null;
  const vals = async (keys: number[][]) => { const out = []; for (const x of keys) out.push(await val(x)); return out; };
  const count = async (sql: string, params: unknown[] = []) => Number((await su.query(sql, params)).rows[0].n);

  beforeAll(async () => {
    h = await createAbuseHarness();
    su = await superuser(h.db);
    tenantId = await provisionTenant(h.db, 'Retry Co', null, 'admin@rt.test');
    admin = await signIn(h as any, 'admin@rt.test');
    userId = (await su.query("select user_id from epm.app_user where email = 'admin@rt.test'")).rows[0].user_id;
    appId = await seedPlanApp(admin, 'Retry Plan');
    base = `/v1/apps/${appId}`;
    ids = await memberIds(h.db, appId);
    cube = await cubeId(h.db, appId);
  });
  afterAll(async () => {
    await Promise.allSettled(pending);
    await su?.end();
    await h?.close();
  });

  it('point in time: a writer committing into the slice during every attempt ends in a clean 409 after 3 tries, nothing restored', async () => {
    // (A writer the restore overwrites anyway is absorbed in the same attempt; one that adds a new
    // cell to the slice each time is not.)
    const X = k({ scenario: 'Budget' });
    const news = ['Feb', 'Mar', 'Apr'].map((period) => k({ scenario: 'Budget', entity: 'West', period }));
    await write([{ k: X, v: '1' }]);
    const later = await write([{ k: X, v: '2' }]);
    const restoresBefore = await count("select count(*)::int as n from epm.change_txn where app_id = $1 and source = 'restore'", [appId]);
    let attempts = 0;
    h.queryHooks.push(async (sql) => {
      if (!sql.startsWith('select epm.restore_slice')) return;
      await lateWriter([{ k: news[attempts++]!, v: '7' }]);
    });
    let r;
    try {
      r = await admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: later });
    } finally {
      h.queryHooks.length = 0;
      await Promise.allSettled(pending);
    }
    expect([r.status, attempts]).toEqual([409, 3]);
    expect(r.body.message).toMatch(/run the restore again/);
    expect({ x: await val(X), news: await vals(news) }).toEqual({ x: '2.000000', news: ['7.000000', '7.000000', '7.000000'] });
    expect(await count("select count(*)::int as n from epm.change_txn where app_id = $1 and source = 'restore'", [appId])).toBe(restoresBefore);
    expect(await count("select count(*)::int as n from epm.security_event where app_id = $1 and event_type = 'point_in_time_restore'", [appId])).toBe(0);
    expect(h.unexpected).toEqual([]);
  });

  it('point in time: one interfering writer is absorbed by the retry and the slice ends exactly at the chosen point', async () => {
    const X = k({ scenario: 'Actual' }), Y = k({ scenario: 'Actual', entity: 'West' });
    await write([{ k: X, v: '1' }, { k: Y, v: '10' }]);
    const later = await write([{ k: X, v: '2' }]);
    const events = await count("select count(*)::int as n from epm.security_event where app_id = $1 and event_type = 'point_in_time_restore'", [appId]);
    let attempts = 0;
    h.queryHooks.push(async (sql) => {
      if (!sql.startsWith('select epm.restore_slice')) return;
      if (++attempts === 1) await lateWriter([{ k: Y, v: '99' }]);
    });
    let r;
    try {
      r = await admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Actual', version: 'Working', before_txn: later });
    } finally {
      h.queryHooks.length = 0;
      await Promise.allSettled(pending);
    }
    expect([r.status, attempts]).toEqual([200, 2]);
    expect({ x: await val(X), y: await val(Y), cells: r.body.cell_count }).toEqual({ x: '1.000000', y: '10.000000', cells: 2 });
    expect(await count("select count(*)::int as n from epm.security_event where app_id = $1 and event_type = 'point_in_time_restore'", [appId])).toBe(events + 1);
    expect(expectOk(await admin.post(`${base}/audit/verify`)).ok).toBe(true);
  });

  it('in place from a snapshot: a writer during every attempt ends in a clean 409 after 3 tries, with one pre-restore snapshot and nothing restored', async () => {
    const X = k({ version: 'Final' }), Y = k({ version: 'Final', entity: 'West' });
    const news = ['Feb', 'Mar', 'Apr'].map((period) => k({ version: 'Final', period }));
    await write([{ k: X, v: '1' }, { k: Y, v: '10' }]);
    const snap = expectOk(await admin.post(`${base}/snapshots`, { scope: { versions: ['Final'] } }), 201);
    await write([{ k: X, v: '2' }]);
    const preBefore = await count("select count(*)::int as n from epm.snapshot where app_id = $1 and kind = 'pre_restore'", [appId]);
    let attempts = 0;
    h.queryHooks.push(async (sql, params) => {
      if (!sql.startsWith('select epm.apply_changes($1::jsonb) as r') || !String(params?.[0]).includes(`snapshot:${snap.snapshot_id}`)) return;
      await lateWriter([{ k: news[attempts++]!, v: '5' }]);
    });
    let r;
    try {
      r = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', versions: ['Final'] });
    } finally {
      h.queryHooks.length = 0;
      await Promise.allSettled(pending);
    }
    expect([r.status, attempts]).toEqual([409, 3]);
    expect({ x: await val(X), y: await val(Y), news: await vals(news) }).toEqual({ x: '2.000000', y: '10.000000', news: ['5.000000', '5.000000', '5.000000'] });
    expect(await count("select count(*)::int as n from epm.snapshot where app_id = $1 and kind = 'pre_restore'", [appId])).toBe(preBefore + 1);
    expect(await count("select count(*)::int as n from epm.snapshot where app_id = $1 and status = 'running'", [appId])).toBe(0);
    expect(await count("select count(*)::int as n from epm.security_event where app_id = $1 and event_type = 'snapshot_restored'", [appId])).toBe(0);
    // Once the writer stops, the same request goes through.
    const again = expectOk(await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', versions: ['Final'] }));
    expect({ x: await val(X), y: await val(Y), news: await vals(news), cells: again.cell_count })
      .toEqual({ x: '1.000000', y: '10.000000', news: [null, null, null], cells: 4 });
    expect(expectOk(await admin.post(`${base}/audit/verify`)).ok).toBe(true);
  });
});
