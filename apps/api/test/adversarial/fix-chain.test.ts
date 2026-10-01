import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Second pass on change_txn.created_at: it is now clock_timestamp() taken under the per-application
 * chain lock, and the hash chain covers it. After a burst of every kind of concurrent writer -
 * grid submits, raw API writes, imports, undos, point-in-time and snapshot restores (in place and
 * into a new application) - every chain must verify, times must follow chain order, and the
 * history and change list must agree with each other and with "as of" lookups.
 */
describe('fix: the hash chain and change times under concurrent writers', () => {
  let h: Harness;
  let su: pg.Client;
  let admin: Api;
  let tenantId: string;
  let userId: string;
  let appId: string;
  let base: string;
  let ids: Record<string, Record<string, number>>;
  let cube: number;
  const statuses: Record<string, number[]> = {};

  const k = (entity: string, period: string, version = 'Working') => {
    const c = new Array<number>(16).fill(0);
    c[0] = cube; c[1] = ids.Scenario!.Budget!; c[2] = ids.Version![version]!; c[3] = ids.Years!.FY27!; c[4] = ids.Period![period]!;
    c[5] = ids.Entity![entity]!; c[6] = ids.Account!.Revenue!; c[7] = ids.Department!.Sales!; c[8] = ids.Product!.Widgets!;
    return c;
  };
  async function raw(cells: { k: number[]; v: string | null }[]) {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantId, userId]);
      const r = (await c.query('select epm.apply_changes($1::jsonb) as r', [JSON.stringify({ app_id: appId, source: 'api', cells })])).rows[0].r;
      await c.query('select pg_sleep(0.02)'); // hold the chain lock a moment, as a slow writer would
      await c.query('commit');
      return r.txn_id as number;
    } catch (e) {
      await c.query('rollback').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  const note = (what: string, status: number) => { (statuses[what] ??= []).push(status); };

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    tenantId = await provisionTenant(h.db, 'Chain Co', null, 'admin@ch.test');
    admin = await signIn(h, 'admin@ch.test');
    userId = (await su.query("select user_id from epm.app_user where email = 'admin@ch.test'")).rows[0].user_id;
    appId = await seedPlanApp(admin, 'Chain Plan');
    base = `/v1/apps/${appId}`;
    const r = await su.query<{ dim: string; name: string; member_id: number }>(
      'select d.name as dim, m.name, m.member_id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1', [appId]);
    ids = {};
    for (const x of r.rows) (ids[x.dim] ??= {})[x.name] = x.member_id;
    cube = (await su.query('select cube_id from epm.cube where app_id = $1', [appId])).rows[0].cube_id;
    expectOk(await admin.put(`${base}/import-formats/Simple`, { cube: 'Plan', definition: {
      header_row: 1,
      dimensions: {
        Scenario: { value: 'Budget' }, Version: { value: 'Working' }, Years: { value: 'FY27' }, Period: { column: 'Month' },
        Entity: { column: 'Entity' }, Account: { value: 'Revenue' }, Department: { value: 'Sales' }, Product: { value: 'Widgets' },
      },
      amount: { column: 'Amount' },
    } }));
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  it('every chain verifies after a burst of every kind of writer, with no 500s', async () => {
    const early: number[] = [];
    for (let i = 0; i < 4; i++) early.push(await raw([{ k: k('East', 'Jan'), v: String(i + 1) }, { k: k('West', 'Feb'), v: String(10 * (i + 1)) }]));
    const snap = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    const files = [];
    for (let i = 0; i < 2; i++) files.push(expectOk(await admin.upload(base, `load${i}.csv`, `Entity,Month,Amount\nEast,Mar,${i + 5}\nWest,Jan,${i + 7}\n`), 201).file_id);

    const grid = async (v: number, entity: string) => {
      const g = expectOk(await admin.post(`${base}/grid/read`, planGrid({ ...PLAN_POV, Entity: entity }, ['COGS'], ['Apr', 'May'])));
      const r = await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[v, v + 1]] });
      note('grid', r.status);
    };
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) ops.push(grid(100 + i, i % 2 ? 'East' : 'West'));
    for (let i = 0; i < 6; i++) ops.push(raw([{ k: k(i % 2 ? 'East' : 'West', ['Jan', 'Feb', 'Mar'][i % 3]!), v: String(200 + i) }]).then(() => note('raw', 200), () => note('raw', 409)));
    for (const f of files) ops.push(admin.post(`${base}/import-formats/Simple/run`, { file_id: f }).then((r) => note('import', r.status)));
    ops.push(admin.post(`${base}/txns/${early[1]}/undo`, { force: true }).then((r) => note('undo', r.status)));
    ops.push(admin.post(`${base}/txns/${early[2]}/undo`, { force: true }).then((r) => note('undo', r.status)));
    ops.push(admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: early[2] }).then((r) => note('pit', r.status)));
    ops.push(admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: early[3], into_version: 'Final' }).then((r) => note('pit-into', r.status)));
    ops.push(admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' }).then((r) => note('in-place', r.status)));
    ops.push(admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Chain Copy' }).then((r) => note('new-app', r.status)));
    await Promise.all(ops);

    const all = Object.values(statuses).flat();
    expect(all.filter((s) => s >= 500), JSON.stringify(statuses)).toEqual([]);
    expect(all.length).toBe(20);
    expect(statuses.grid!.filter((x) => x === 200).length, JSON.stringify(statuses)).toBeGreaterThan(0);
    const apps = (await su.query<{ app_id: string }>('select app_id from epm.application where tenant_id = $1', [tenantId])).rows;
    expect(apps.length).toBe(2);
    for (const a of apps) {
      const v = expectOk(await admin.post(`/v1/apps/${a.app_id}/audit/verify`));
      const n = Number((await su.query('select count(*)::int as n from epm.change_txn where app_id = $1', [a.app_id])).rows[0].n);
      expect({ ok: v.ok, checked: v.checked }).toEqual({ ok: true, checked: n });
    }
  });

  it('change times strictly follow chain order in every application, and are not before the audit rows they cover', async () => {
    const bad = await su.query(
      `select app_id, chain_seq from (
         select app_id, chain_seq, created_at, lag(created_at) over (partition by app_id order by chain_seq) as prev from epm.change_txn) t
        where prev is not null and created_at <= prev`,
    );
    expect(bad.rows).toEqual([]);
    const early = await su.query('select a.txn_id from epm.cell_audit a join epm.change_txn t on t.txn_id = a.txn_id where a.changed_at > t.created_at limit 5');
    expect(early.rows).toEqual([]);
  });

  it('history and the change list report the same times, and each reported time resolves to its own chain position', async () => {
    const txns = expectOk(await admin.get(`${base}/txns?limit=500`)).txns as { txn_id: number; chain_seq: number; created_at: string }[];
    const hist = expectOk(await admin.post(`${base}/history`, { cube: 'Plan', cell: { ...PLAN_POV, Entity: 'Total Company', Account: 'Revenue', Period: 'YearTotal', Department: 'Sales', Product: 'Widgets' }, limit: 1000 })).changes as { txn_id: number; changed_at: string }[];
    const byTxn = new Map(txns.map((t) => [t.txn_id, t.created_at]));
    expect(hist.filter((c) => byTxn.get(c.txn_id) !== c.changed_at)).toEqual([]);
    // "As of" each reported time is exactly that transaction (a dry run reports the point it resolved).
    for (const t of txns.slice(0, 12)) {
      const r = expectOk(await admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', at: t.created_at, dry_run: true }));
      expect([t.txn_id, r.as_of.chain_seq]).toEqual([t.txn_id, t.chain_seq]);
    }
  });
});
