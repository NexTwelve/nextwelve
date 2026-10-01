import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from './helpers.js';

describe('dimension editing and deploy', () => {
  let h: Harness;
  let admin: Api;
  let appId: string;
  let base: string;

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Meta', null, 'admin@meta.test');
    admin = await signIn(h, 'admin@meta.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
  });
  afterAll(async () => h?.close());

  it('lists dimensions, cubes and deployed members in hierarchy order', async () => {
    const dims = expectOk(await admin.get(`${base}/dimensions`));
    expect(dims.dimensions.find((d: any) => d.name === 'Product')).toMatchObject({ type: 'custom', slot: 1 });
    expect(dims.cubes).toEqual([{ name: 'Plan', dimensions: ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account', 'Department', 'Product'] }]);
    const periods = expectOk(await admin.get(`${base}/dimensions/Period/members`));
    expect(periods.members.map((m: any) => m.name)).toEqual(['YearTotal', 'Q1', 'Jan', 'Feb', 'Mar', 'Q2', 'Apr', 'May', 'Jun']);
    expect(periods.members.every((m: any) => m.deployed)).toBe(true);
  });

  it('requires the six fixed dimensions in every cube', async () => {
    const res = await admin.post(`${base}/cubes`, { name: 'Partial', dimensions: ['Scenario', 'Version', 'Years', 'Period', 'Account', 'Product'] });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/entity/);
  });

  it('treats Department as a first-class dimension that a cube may leave out', async () => {
    const dims = expectOk(await admin.get(`${base}/dimensions`));
    expect(dims.dimensions.find((d: any) => d.name === 'Department')).toMatchObject({ type: 'department', slot: null });
    expect((await admin.post(`${base}/dimensions`, { name: 'Cost Center', type: 'department' })).status).toBe(409);

    // A revenue cube without Department: its grids and writes leave the department coordinate empty.
    expectOk(await admin.post(`${base}/cubes`, { name: 'Revenue', dimensions: ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account', 'Product'] }), 201);
    const pov = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Product: 'Widgets' };
    const g = expectOk(await admin.post(`${base}/grid/read`, { cube: 'Revenue', pov, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } }));
    expect(g.writable).toEqual([[true]]);
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[77]] }));
    const withDept = await admin.post(`${base}/grid/read`, { cube: 'Revenue', pov: { ...pov, Department: 'Sales' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } });
    expect(withDept.status).toBe(422);

    // In the Plan cube, Department rolls up like any hierarchy.
    const byDept = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Product: 'Widgets', Account: 'Revenue' },
      rows: { dimension: 'Department', members: ['@idescendants(All Departments)'] },
      columns: { dimension: 'Period', members: ['Feb'] },
    }));
    const values = byDept.values.map((r: unknown[]) => [...r]);
    values[1][0] = 5; // Sales
    values[2][0] = 7; // Operations
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: byDept.grid_session_id, values }));
    const after = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Product: 'Widgets', Account: 'Revenue' },
      rows: { dimension: 'Department', members: ['@idescendants(All Departments)'] },
      columns: { dimension: 'Period', members: ['Feb'] },
    }));
    expect(after.rows.members.map((m: any) => m.name)).toEqual(['All Departments', 'Sales', 'Operations']);
    expect(after.values.map((r: any[]) => r[0])).toEqual([12, 5, 7]);
  });

  it('assigns custom slots and stops at eight', async () => {
    for (let n = 2; n <= 8; n++) expectOk(await admin.post(`${base}/dimensions`, { name: `Custom${n}`, type: 'custom' }), 201);
    expect((await admin.post(`${base}/dimensions`, { name: 'Custom9', type: 'custom' })).status).toBe(422);
    expect((await admin.post(`${base}/dimensions`, { name: 'Entity2', type: 'entity' })).status).toBe(409);
  });

  it('treats member names case-insensitively', async () => {
    const res = expectOk(await admin.put(`${base}/dimensions/Entity/members`, { members: [{ name: 'east', alias: 'East Region' }] }));
    expect(res).toMatchObject({ inserted: 0, updated: 1 });
    const list = expectOk(await admin.get(`${base}/dimensions/Entity/members`));
    expect(list.members.find((m: any) => m.name === 'East').alias).toBe('East Region');
  });

  it('does not resolve members until they are deployed', async () => {
    expectOk(await admin.put(`${base}/dimensions/Period/members`, { members: [{ name: 'Q3', parent: 'YearTotal' }, { name: 'Jul', parent: 'Q3' }] }));
    const before = await admin.post(`${base}/grid/read`, planGrid(PLAN_POV, ['Revenue'], ['Jul']));
    expect(before.status).toBe(422);
    const deployed = expectOk(await admin.post(`${base}/deploy`));
    expect(deployed.metadata_rev).toBe(2);
    expectOk(await admin.post(`${base}/grid/read`, planGrid(PLAN_POV, ['Revenue'], ['Jul'])));
  });

  it('refuses a hierarchy cycle', async () => {
    expectOk(await admin.put(`${base}/dimensions/Period/members`, { members: [{ name: 'Q3', parent: 'Jul' }] }));
    const res = await admin.post(`${base}/deploy`);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/cycle/);
    expectOk(await admin.put(`${base}/dimensions/Period/members`, { members: [{ name: 'Q3', parent: 'YearTotal' }] }));
    expectOk(await admin.post(`${base}/deploy`));
  });

  it('protects members that hold data', async () => {
    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid()));
    const values = g.values.map((r: unknown[]) => [...r]);
    values[2][0] = 10;
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values }));

    // Widgets has data, so it cannot gain children or be deleted.
    expectOk(await admin.put(`${base}/dimensions/Product/members`, { members: [{ name: 'Blue Widgets', parent: 'Widgets' }] }));
    const deploy = await admin.post(`${base}/deploy`);
    expect(deploy.status).toBe(422);
    expect(deploy.body.details).toEqual(['Widgets']);
    expectOk(await admin.del(`${base}/dimensions/Product/members/Blue Widgets`));
    expect((await admin.del(`${base}/dimensions/Product/members/Widgets`)).status).toBe(422);
    expect((await admin.del(`${base}/dimensions/Product/members/All Products`)).status).toBe(422);
    expectOk(await admin.del(`${base}/dimensions/Product/members/Gadgets`));
    expectOk(await admin.post(`${base}/deploy`));
  });

  it('logs each deploy with a snapshot of the members', async () => {
    const su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    const res = await su.query<{ metadata_rev: number; summary: any }>(
      'select metadata_rev, summary from epm.metadata_change where app_id = $1 order by metadata_rev',
      [appId],
    );
    await su.end();
    expect(res.rows.map((r) => r.metadata_rev)).toEqual([1, 2, 3, 4]);
    const latest = res.rows.at(-1)!.summary;
    expect(latest.members.some((m: any) => m.dimension === 'Product' && m.name === 'Gadgets')).toBe(false);
    expect(latest.members.find((m: any) => m.name === 'COGS')).toMatchObject({ parent: 'Gross Margin', agg_op: '-' });
  });
});
