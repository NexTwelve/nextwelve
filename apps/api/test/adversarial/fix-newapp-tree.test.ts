import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, PLAN_POV, planGrid, seedPlanApp } from '../helpers.js';
import { type Env, expectOk, setupEnv } from './data-helpers.js';
import { rewriteSnapshot, snapshotMeta, TO_FORMAT_1 } from './fix-helpers.js';

/**
 * Second pass on format 2 snapshots: a restore into a new application rebuilds the hierarchy as it
 * was DEPLOYED (deployed_parent_id / deployed_agg_op / tree_ordinal), loads facts, then re-applies
 * the saved-but-undeployed edits. And format 1 snapshots (every backup taken before the upgrade)
 * must still restore.
 */
const DIMS = ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account', 'Department', 'Product'];
const TOTALS = {
  cube: 'Plan',
  rows: { dimension: 'Account', members: ['@idescendants(Net Income)'] },
  columns: { dimension: 'Period', members: ['@idescendants(YearTotal)'] },
};
const POVS = [
  { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'Total Company', Department: 'All Departments', Product: 'All Products' },
  { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' },
];

async function members(admin: Api, b: string, dim: string) {
  return expectOk(await admin.get(`${b}/dimensions/${dim}/members`)).members;
}
async function totals(admin: Api, b: string) {
  const out: unknown[] = [];
  for (const pov of POVS) out.push(expectOk(await admin.post(`${b}/grid/read`, { ...TOTALS, pov })).values);
  return out;
}
async function cell(admin: Api, b: string, pov: Record<string, string>, account = 'Revenue', period = 'Jan') {
  return expectOk(await admin.post(`${b}/grid/read`, planGrid(pov, [account], [period]))).values[0][0];
}
async function setCell(admin: Api, b: string, pov: Record<string, string>, v: number) {
  const g = expectOk(await admin.post(`${b}/grid/read`, planGrid(pov, ['Revenue'], ['Jan'])));
  expectOk(await admin.post(`${b}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[v]] }));
}

describe('fix: the deployed hierarchy of a restored copy', () => {
  let env: Env;
  let admin: Api;

  beforeAll(async () => {
    env = await setupEnv('tree', 'Tree Plan');
    admin = env.admin;
  });
  afterAll(async () => env?.close());

  it('FINDING: a member whose deployed parent was deleted (not yet deployed) still rolls up as deployed in the copy', async () => {
    const b = env.base;
    // Deployed: Total Company > Region X > East ; Total Company > West.
    expectOk(await admin.put(`${b}/dimensions/Entity/members`, { members: [{ name: 'Region X', parent: 'Total Company' }, { name: 'East', parent: 'Region X' }] }));
    expectOk(await admin.post(`${b}/deploy`));
    await env.refreshIds();
    await env.write([{ k: env.coord({ Entity: 'East' }), v: 10 }, { k: env.coord({ Entity: 'West' }), v: 5 }]);
    // Saved, not deployed: East moves back under Total Company, and the emptied Region X is deleted.
    expectOk(await admin.put(`${b}/dimensions/Entity/members`, { members: [{ name: 'East', parent: 'Total Company' }] }));
    expectOk(await admin.del(`${b}/dimensions/Entity/members/Region X`));
    const tc = { ...PLAN_POV, Entity: 'Total Company' };
    expect(await cell(admin, b, tc)).toBe(15); // the source, as deployed: East still counts under Total Company

    const snap = expectOk(await admin.post(`${b}/snapshots`, {}), 201);
    const east = (await snapshotMeta(env.h.blobs, env.su, snap.snapshot_id)).members.find((m: any) => m.name === 'East');
    const copy = expectOk(await admin.post(`${b}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Tree Copy' }), 201);
    const cb = `/v1/apps/${copy.app_id}`;
    expect({ total: await cell(admin, cb, tc), east: await cell(admin, cb, PLAN_POV) },
      `East's deployed parent #${east.deployed_parent_id} is not in the snapshot`).toEqual({ total: 15, east: 10 });
    // The saved hierarchy came back as it was.
    expect(await members(admin, cb, 'Entity')).toEqual(await members(admin, b, 'Entity'));
  });
});

describe('fix: saved-but-undeployed edits re-applied to a restored copy', () => {
  let env: Env;
  let admin: Api;
  let b: string;
  let copyBase: string;

  beforeAll(async () => {
    env = await setupEnv('pending', 'Pending Plan');
    admin = env.admin;
    b = env.base;
    await env.write([
      { k: env.coord({}), v: '100.5' },
      { k: env.coord({ Account: 'COGS' }), v: '40.25' },
      { k: env.coord({ Product: 'Gadgets' }), v: '7' },
      { k: env.coord({ Period: 'Feb' }), v: '3' },
      { k: env.coord({ Account: 'Opex', Entity: 'West' }), v: '-2' },
    ]);
    // Edits saved but not deployed, of every kind the loader re-applies:
    expectOk(await admin.put(`${b}/dimensions/Product/members`, { members: [
      { name: 'Hardware', parent: 'All Products', sort_order: 5 }, // a new parent ...
      { name: 'Widgets', parent: 'Hardware' }, //                       ... that a deployed, data-holding member moves under
    ] }));
    expectOk(await admin.put(`${b}/dimensions/Account/members`, { members: [{ name: 'COGS', agg_op: '+' }, { name: 'Opex', sort_order: 1 }] }));
    expectOk(await admin.put(`${b}/dimensions/Period/members`, { members: [{ name: 'Jan', sort_order: 999 }, { name: 'Q3', parent: 'YearTotal', agg_op: '~' }] }));
    // Deleted, then created again under the same name.
    expectOk(await admin.del(`${b}/dimensions/Department/members/Operations`));
    expectOk(await admin.put(`${b}/dimensions/Department/members`, { members: [{ name: 'Operations', parent: 'All Departments', sort_order: 1 }] }));
    const snap = expectOk(await admin.post(`${b}/snapshots`, {}), 201);
    const copy = expectOk(await admin.post(`${b}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Pending Copy' }), 201);
    copyBase = `/v1/apps/${copy.app_id}`;
  });
  afterAll(async () => env?.close());

  it('the copy reads exactly like the source as deployed (totals with the old aggregation and tree)', async () => {
    expect(await totals(admin, copyBase)).toEqual(await totals(admin, b));
  });

  it('the copy holds the same saved metadata as the source, deployed flags included', async () => {
    for (const d of DIMS) expect(await members(admin, copyBase, d), d).toEqual(await members(admin, b, d));
  });

  it('deploying both gives the same tree and the same totals', async () => {
    expectOk(await admin.post(`${b}/deploy`));
    expectOk(await admin.post(`${copyBase}/deploy`));
    for (const d of DIMS) expect(await members(admin, copyBase, d), d).toEqual(await members(admin, b, d));
    expect(await totals(admin, copyBase)).toEqual(await totals(admin, b));
  });
});

describe('fix: format 1 snapshots (taken before the upgrade) still restore', () => {
  let env: Env;
  let admin: Api;

  beforeAll(async () => {
    env = await setupEnv('legacy', 'Legacy Plan');
    admin = env.admin;
  });
  afterAll(async () => env?.close());

  it('a format 1 snapshot restores into a new application and in place, values exact', async () => {
    const b = `/v1/apps/${await seedPlanApp(admin, 'Legacy Simple')}`;
    await setCell(admin, b, PLAN_POV, 123.456789);
    await setCell(admin, b, { ...PLAN_POV, Entity: 'West' }, -0.000001);
    const snap = expectOk(await admin.post(`${b}/snapshots`, {}), 201);
    await rewriteSnapshot(env.h.blobs, env.su, snap.snapshot_id, TO_FORMAT_1);
    const before = await totals(admin, b);

    const copy = await admin.post(`${b}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Legacy Copy' });
    expect([copy.status, copy.body.message]).toEqual([201, undefined]);
    expect(await totals(admin, `/v1/apps/${copy.body.app_id}`)).toEqual(before);

    await setCell(admin, b, PLAN_POV, 5);
    const back = await admin.post(`${b}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' });
    expect([back.status, back.body.cell_count]).toEqual([200, 1]);
    expect(await cell(admin, b, PLAN_POV)).toBe(123.456789);
    expect(await totals(admin, b)).toEqual(before);
  });

  it('FINDING: a format 1 snapshot taken while a data-holding leaf was getting (undeployed) children restores into a new application', async () => {
    const b = `/v1/apps/${await seedPlanApp(admin, 'Legacy Weekly')}`;
    await setCell(admin, b, PLAN_POV, 100);
    // Someone has started splitting January into weeks but not deployed: Jan still holds data and is a leaf.
    expectOk(await admin.put(`${b}/dimensions/Period/members`, { members: [{ name: 'Jan W1', parent: 'Jan' }] }));
    const snap = expectOk(await admin.post(`${b}/snapshots`, {}), 201);
    // The same snapshot restores fine as format 2 ...
    const v2 = await admin.post(`${b}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Weekly v2' });
    expect(v2.status).toBe(201);
    // ... and as format 1 (format 1 kept each member's "deployed" flag).
    await rewriteSnapshot(env.h.blobs, env.su, snap.snapshot_id, TO_FORMAT_1);
    expect((await snapshotMeta(env.h.blobs, env.su, snap.snapshot_id)).members.find((m: any) => m.name === 'Jan W1').deployed).toBe(false);
    const v1 = await admin.post(`${b}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Weekly v1' });
    expect([v1.status, v1.body.message]).toEqual([201, undefined]);
    expect(await cell(admin, `/v1/apps/${v1.body.app_id}`, PLAN_POV)).toBe(100);
  });
});
