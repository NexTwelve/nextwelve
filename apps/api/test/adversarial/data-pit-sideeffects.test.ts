import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Cell, type Env, expectOk, rng, setupEnv, sorted } from './data-helpers.js';

/**
 * A point-in-time restore "into a new version, created on request" must only add that version and
 * write the target slice. Creating the version deploys metadata; any other pending (undeployed)
 * metadata edits must not ride along, because deploying them changes what every other slice adds up to.
 */
const TOTALS = {
  cube: 'Plan',
  rows: { dimension: 'Account', members: ['@idescendants(Net Income)'] },
  columns: { dimension: 'Period', members: ['Jan', 'Feb', 'Mar', 'Q1', 'Q2', 'YearTotal'] },
};
const ACTUAL = { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Entity: 'Total Company', Department: 'All Departments', Product: 'All Products' };

describe('side effects of a point-in-time restore', () => {
  let env: Env;
  let base: string;
  let firstTxn: number;
  const grid = async (pov: Record<string, string>) => expectOk(await env.admin.post(`${base}/grid/read`, { ...TOTALS, pov })).values;
  const metadataRev = async () => (await env.su.query<{ r: number }>('select metadata_rev as r from epm.application where app_id = $1', [env.appId])).rows[0]!.r;

  beforeAll(async () => {
    env = await setupEnv('pitside');
    base = env.base;
    const r = rng(5);
    const cells: Cell[] = [];
    for (const [sc, ve] of [['Budget', 'Working'], ['Actual', 'Final']]) {
      for (const e of ['East', 'West']) for (const a of ['Revenue', 'COGS', 'Opex']) for (const p of ['Jan', 'Feb', 'Mar', 'Apr']) {
        cells.push({ k: env.coord({ Scenario: sc, Version: ve, Entity: e, Account: a, Period: p }), v: String(1 + r.int(500)) });
      }
    }
    firstTxn = (await env.write(cells)).txn_id!;
    await env.write([{ k: env.coord({ Period: 'Mar' }), v: '1' }]);
  });
  afterAll(async () => env?.close());

  it('a dry run that would create the version leaves no trace', async () => {
    const rev = await metadataRev();
    const before = await env.allFacts();
    const r = expectOk(await env.admin.post(`${base}/restore`, {
      cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: firstTxn + 1, into_version: 'Probe', create_version: true, dry_run: true,
    }));
    expect(r).toMatchObject({ version_created: false, cells_set: 24 });
    expect(await metadataRev()).toBe(rev);
    expect((await env.su.query(`select 1 from epm.member where name = 'Probe'`)).rowCount).toBe(0);
    expect(sorted(await env.allFacts())).toEqual(sorted(before));
  });

  it('FINDING: creating the target version does not deploy unrelated pending metadata edits', async () => {
    const totalsBefore = await grid(ACTUAL);
    // An administrator is mid-way through reorganising periods: Mar moves to Q2, not deployed yet.
    expectOk(await env.admin.put(`${base}/dimensions/Period/members`, { members: [{ name: 'Mar', parent: 'Q2' }] }));
    expect(await grid(ACTUAL)).toEqual(totalsBefore); // pending: nothing changes yet

    expectOk(await env.admin.post(`${base}/restore`, {
      cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: firstTxn + 1, into_version: 'Sandbox', create_version: true,
    }));
    // Actual / Final was not part of the restore; its Q1 and Q2 must still add up the same way.
    expect(await grid(ACTUAL)).toEqual(totalsBefore);
  });
});
