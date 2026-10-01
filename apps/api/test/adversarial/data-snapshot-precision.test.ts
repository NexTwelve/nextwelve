import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Env, expectOk, num6, setupEnv } from './data-helpers.js';

/**
 * Cell values are numeric(24,6): up to 18 integer digits and 6 decimals, exact. A snapshot is
 * supposed to be an exact copy; values travel through the snapshot files and back through
 * restoreInPlace / restoreToNewApp. These pin exactness at the edges of the type.
 */
describe('snapshot value precision', () => {
  let env: Env;
  let base: string;
  // Budget / Working
  const SMALL: [string, string][] = [
    ['Jan', '0'], ['Feb', '-0.5'], ['Mar', '0.000001'], ['Apr', '-0.000001'], ['May', '0.1'], ['Jun', '1234567890.123456'],
  ];
  const BIG = '123456789012.123456';       // Revenue / Jan / West: 18 significant digits
  const CLOSE = '10000000000.000001';      // COGS / Jan / West: the restore must tell it from ...002
  const CLOSE_NOW = '10000000000.000002';
  const MAX = '999999999999999999.999999'; // Actual / Final: the largest value a cell can hold
  let small: number[][];
  let big: number[];
  let close: number[];
  let max: number[];
  let working: any;
  let actualFinal: any;

  const val = async (k: number[]) =>
    (await env.su.query<{ v: string }>(
      `select value::text as v from epm.fact where app_id = $1 and array[cube_id, scenario_id, version_id, years_id, period_id,
         entity_id, account_id, department_id, c1, c2, c3, c4, c5, c6, c7, c8] = $2::int[]`,
      [env.appId, k],
    )).rows[0]?.v ?? null;

  beforeAll(async () => {
    env = await setupEnv('precision');
    base = env.base;
    small = SMALL.map(([p]) => env.coord({ Period: p }));
    big = env.coord({ Entity: 'West', Account: 'Revenue', Period: 'Jan' });
    close = env.coord({ Entity: 'West', Account: 'COGS', Period: 'Jan' });
    max = env.coord({ Scenario: 'Actual', Version: 'Final', Account: 'Opex' });
    await env.write([...SMALL.map(([, v], i) => ({ k: small[i]!, v })), { k: big, v: BIG }, { k: close, v: CLOSE }, { k: max, v: MAX }]);
    expect(await val(big)).toBe(BIG);
    expect(await val(max)).toBe(MAX);
    working = expectOk(await env.admin.post(`${base}/snapshots`, { scope: { versions: ['Working'] } }), 201);
    actualFinal = expectOk(await env.admin.post(`${base}/snapshots`, { scope: { scenarios: ['Actual'], versions: ['Final'] } }), 201);
    // Move every cell away from its snapshot value.
    await env.write([...small.map((k) => ({ k, v: '42' })), { k: big, v: '1' }, { k: close, v: CLOSE_NOW }, { k: max, v: '1' }]);
  });
  afterAll(async () => env?.close());

  it('small and ordinary values survive an in-place restore exactly', async () => {
    const r = expectOk(await env.admin.post(`${base}/snapshots/${working.snapshot_id}/restore`, { target: 'in_place', dry_run: true }));
    expect(r.cells_set).toBeGreaterThanOrEqual(SMALL.length);
    expectOk(await env.admin.post(`${base}/snapshots/${working.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'] }));
    for (const [i, [p, v]] of SMALL.entries()) expect(await val(small[i]!), p).toBe(num6(v));
  });

  it('point-in-time restore (the SQL path) is exact for the same values', async () => {
    const r = expectOk(await env.admin.post(`${base}/restore`, {
      cube: 'Plan', scenario: 'Actual', version: 'Final', before_txn: (await env.write([{ k: max, v: '2' }])).txn_id,
    }));
    expect(r.cells_set).toBe(1);
    expect(await val(max)).toBe('1.000000');
    const first = (await env.su.query<{ txn_id: string }>('select min(txn_id)::text as txn_id from epm.change_txn where app_id = $1', [env.appId])).rows[0]!.txn_id;
    const second = (await env.su.query<{ txn_id: string }>(
      'select txn_id::text from epm.change_txn where app_id = $1 and txn_id > $2 order by chain_seq limit 1', [env.appId, first],
    )).rows[0]!.txn_id;
    expectOk(await env.admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: Number(second), into_version: 'Exact', create_version: true }));
    await env.refreshIds();
    const exact = await env.facts({ scenario: 'Budget', version: 'Exact' }, true);
    expect([...exact.values()].sort()).toEqual([...SMALL.map(([, v]) => num6(v)), BIG, CLOSE].sort());
  });

  it('FINDING: an 18-digit value survives a snapshot and an in-place restore exactly', async () => {
    expectOk(await env.admin.post(`${base}/snapshots/${working.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'] }));
    expect(await val(big)).toBe(BIG); // stored as 123456789012.123460
  });

  it('FINDING: an in-place restore puts back a value that differs from the current one by 0.000001', async () => {
    await env.write([{ k: close, v: CLOSE_NOW }]);
    const dry = expectOk(await env.admin.post(`${base}/snapshots/${working.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'], dry_run: true }));
    expect(dry.cells_set).toBeGreaterThanOrEqual(1);
    expectOk(await env.admin.post(`${base}/snapshots/${working.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'] }));
    expect(await val(close)).toBe(CLOSE); // left at 10000000000.000002: judged "unchanged"
  });

  it('FINDING: the largest value a cell can hold survives a snapshot and an in-place restore', async () => {
    const res = await env.admin.post(`${base}/snapshots/${actualFinal.snapshot_id}/restore`, { target: 'in_place' });
    expect(res.status, JSON.stringify(res.body)).toBe(200); // 422 numeric field overflow: the snapshot cannot be restored
    expect(await val(max)).toBe(MAX);
  });

  it('FINDING: restoring into a new application keeps every value exactly', async () => {
    const r = expectOk(await env.admin.post(`${base}/snapshots/${working.snapshot_id}/restore`, { target: 'new_app', name: 'Precision copy' }), 201);
    const got = (await env.su.query<{ v: string }>('select value::text as v from epm.fact where app_id = $1', [r.app_id])).rows.map((x) => x.v).sort();
    expect(got).toEqual([...SMALL.map(([, v]) => num6(v)), BIG, CLOSE].sort());
  });

  it('FINDING: a snapshot holding the largest cell value can be restored into a new application', async () => {
    const res = await env.admin.post(`${base}/snapshots/${actualFinal.snapshot_id}/restore`, { target: 'new_app', name: 'Max copy' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const app = (await env.su.query<{ state: string; app_id: string }>(`select state, app_id from epm.application where name = 'Max copy'`)).rows[0];
    expect(app?.state).toBe('online');
    const got = (await env.su.query<{ v: string }>('select value::text as v from epm.fact where app_id = $1', [app?.app_id])).rows.map((x) => x.v);
    expect(got).toEqual([MAX]);
  });
});
