import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, signIn } from '../helpers.js';
import { type Cell, type Env, expectOk, rng, setupEnv } from './data-helpers.js';

/**
 * Restore into a new application: everything the snapshot carries must come back as it was —
 * metadata (including what was not deployed yet), security, forms, imports, datasets and facts —
 * compared with the original through the API.
 */
const DIMS = ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account', 'Department', 'Product'];
const TOTALS = {
  cube: 'Plan',
  rows: { dimension: 'Account', members: ['@idescendants(Net Income)', '@idescendants(Statistics)'] },
  columns: { dimension: 'Period', members: ['Jan', 'Feb', 'Mar', 'Apr', 'Q1', 'Q2', 'YearTotal'] },
};
const POVS = [
  { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'Total Company', Department: 'All Departments', Product: 'All Products' },
  { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' },
  { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Entity: 'Total Company', Department: 'All Departments', Product: 'All Products' },
];

describe('restore into a new application', () => {
  let env: Env;
  let admin: Api;
  let base: string;

  const restoreNew = async (name: string) => {
    const snap = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    // Full fidelity includes access, which a copy only takes when asked (access: 'copy').
    const res = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name, access: 'copy' });
    return { snap, res };
  };
  const members = async (b: string, dim: string) => expectOk(await admin.get(`${b}/dimensions/${dim}/members`)).members;
  const grid = async (b: string, pov: Record<string, string>) => expectOk(await admin.post(`${b}/grid/read`, { ...TOTALS, pov })).values;
  const planWindows = async (appId: string) =>
    (await env.su.query(
      `select s.name as scenario, v.name as version, y.name as years, ps.name as start_period, pe.name as end_period, w.locked
         from epm.plan_window w join epm.member s on s.member_id = w.scenario_id join epm.member v on v.member_id = w.version_id
         join epm.member y on y.member_id = w.years_id left join epm.member ps on ps.member_id = w.start_period_id
         left join epm.member pe on pe.member_id = w.end_period_id
        where w.app_id = $1 order by 1, 2, 3`,
      [appId],
    )).rows;
  const roles = async (appId: string) =>
    (await env.su.query('select u.email, r.role from epm.user_role r join epm.app_user u on u.user_id = r.user_id where r.app_id = $1 order by 1', [appId])).rows;

  beforeAll(async () => {
    env = await setupEnv('fidelity');
    admin = env.admin;
    base = env.base;
    // Richer metadata: aliases, formulas, time balance, '~' aggregation, explicit sort orders.
    expectOk(await admin.put(`${base}/dimensions/Account/members`, { members: [
      { name: 'Statistics', agg_op: '~', sort_order: 900 },
      { name: 'Headcount', parent: 'Statistics', account_type: 'saved_assumption', time_balance: 'last', agg_op: '~', alias: 'HC' },
      { name: 'Avg Price', parent: 'Statistics', time_balance: 'average', formula: '[Revenue] / [Units]', alias: 'Price, avg' },
      { name: 'Units', parent: 'Statistics', time_balance: 'flow', sort_order: 5 },
    ] }));
    expectOk(await admin.put(`${base}/dimensions/Entity/members`, { members: [{ name: 'West', alias: 'Western Region', sort_order: 1 }] }));
    expectOk(await admin.post(`${base}/deploy`));
    await env.refreshIds();
    // Security, windows, forms, imports, datasets.
    for (const email of ['ann@fidelity.test', 'bob@fidelity.test']) expectOk(await admin.post('/v1/users', { email }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'ann@fidelity.test', role: 'planner' }));
    expectOk(await admin.post(`${base}/roles`, { email: 'bob@fidelity.test', role: 'viewer' }));
    expectOk(await admin.post('/v1/groups', { name: 'Readers' }), 201);
    expectOk(await admin.put('/v1/groups/Readers/members', { emails: ['bob@fidelity.test', 'ann@fidelity.test'] }));
    expectOk(await admin.put(`${base}/grants`, { grants: [
      { principal: { user: 'ann@fidelity.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' },
      { principal: { group: 'Readers' }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'read' },
      { principal: { user: 'bob@fidelity.test' }, dimension: 'Entity', member: 'West', scope: 'member', access: 'none' },
    ] }));
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', start_period: 'Feb', end_period: 'May' }));
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Actual', version: 'Final', years: 'FY27', locked: true }));
    expectOk(await admin.put(`${base}/forms/Rev Entry`, { cube: 'Plan', folder: 'Inputs', description: 'Revenue by month', definition: {
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Product: 'Widgets' },
      page: { Entity: ['East', 'West'] }, rows: { dimension: 'Account', members: ['Revenue', '@children(Statistics)'] },
      columns: { dimension: 'Period', members: ['@leaves(Q1)'] }, read_only: false, instructions: 'Enter "net" revenue.' } }));
    expectOk(await admin.put(`${base}/forms/Totals`, { cube: 'Plan', definition: {
      pov: { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Department: 'All Departments', Product: 'All Products', Entity: 'Total Company' },
      rows: { dimension: 'Account', members: ['@idescendants(Net Income)'] }, columns: { dimension: 'Period', members: ['YearTotal'] }, read_only: true } }));
    const f = expectOk(await admin.upload(base, 'codes.csv', 'Code,Member,Weight,Note\nR,Revenue,1.5,"a, quoted ""note"""\nO,Opex,-2,\nC,COGS,0,x\n', 'dataset'), 201);
    expectOk(await admin.put(`${base}/datasets/Codes`, { file_id: f.file_id, description: 'account codes' }));
    const f2 = expectOk(await admin.upload(base, 'codes2.csv', 'Code,Member,Weight,Note\nR,Revenue,1.25,v2\nO,Opex,-2,\nC,COGS,0,x\nU,Units,7,\n', 'dataset'), 201);
    expectOk(await admin.put(`${base}/datasets/Codes`, { file_id: f2.file_id }));
    expectOk(await admin.put(`${base}/import-formats/Loader`, { cube: 'Plan', definition: {
      dimensions: { Scenario: { value: 'Budget' }, Version: { value: 'Working' }, Years: { value: 'FY27' }, Period: { column: 'Month' },
        Entity: { value: 'East' }, Department: { value: 'Sales' }, Product: { value: 'Widgets' }, Account: { column: 'Code' } },
      amount: { column: 'Amount' } } }));
    expectOk(await admin.put(`${base}/import-formats/Loader/mappings`, { rules: [
      { dimension: 'Account', rule_type: 'dataset', source: 'Codes', target: 'Member', options: { key_column: 'Code' }, priority: 2 },
      { dimension: 'Account', rule_type: 'explicit', source: 'X', target: 'Opex', description: 'legacy code' },
      { dimension: 'Period', rule_type: 'like', source: 'Jan*', target: 'Jan', priority: 1 },
      { dimension: 'Period', rule_type: 'like', source: '*', target: '*', priority: 9 },
    ] }));
    // Facts in several slices, including the statistics accounts.
    const r = rng(99);
    const cells: Cell[] = [];
    for (const [sc, ve] of [['Budget', 'Working'], ['Actual', 'Final'], ['Budget', 'Final']]) {
      for (const e of ['East', 'West']) for (const a of ['Revenue', 'COGS', 'Opex', 'Headcount', 'Units']) for (const p of ['Jan', 'Feb', 'Mar', 'Apr'])
        for (const d of ['Sales', 'Operations']) for (const pr of ['Widgets', 'Gadgets']) {
          if (r.chance(0.5)) cells.push({ k: env.coord({ Scenario: sc, Version: ve, Entity: e, Account: a, Period: p, Department: d, Product: pr }), v: String(r.int(1_000_000) / 8) });
        }
    }
    await env.write(cells);
  });
  afterAll(async () => env?.close());

  it('brings back metadata, security, windows, forms, imports, datasets and facts as they were', async () => {
    const { snap, res } = await restoreNew('Fidelity Copy');
    const r = expectOk(res, 201);
    expect(r).toMatchObject({ cells: snap.fact_count, missing_users: [], missing_groups: [] });
    const nb = `/v1/apps/${r.app_id}`;
    expect(expectOk(await admin.get(`${nb}/dimensions`))).toEqual(expectOk(await admin.get(`${base}/dimensions`)));
    for (const d of DIMS) expect(await members(nb, d), d).toEqual(await members(base, d));
    expect(expectOk(await admin.get(`${nb}/grants`))).toEqual(expectOk(await admin.get(`${base}/grants`)));
    expect(await planWindows(r.app_id)).toEqual(await planWindows(env.appId));
    expect(await roles(r.app_id)).toEqual(await roles(env.appId));
    for (const name of ['Rev Entry', 'Totals']) {
      const a = expectOk(await admin.get(`${base}/forms/${name}`));
      const b = expectOk(await admin.get(`${nb}/forms/${name}`));
      for (const field of ['name', 'folder', 'description', 'cube', 'definition']) expect(b[field], `${name}.${field}`).toEqual(a[field]);
    }
    expect(expectOk(await admin.get(`${nb}/import-formats/Loader`)).definition).toEqual(expectOk(await admin.get(`${base}/import-formats/Loader`)).definition);
    expect(expectOk(await admin.get(`${nb}/import-formats/Loader/mappings`)).rules).toEqual(expectOk(await admin.get(`${base}/import-formats/Loader/mappings`)).rules);
    const rows = async (b: string) => { const x = expectOk(await admin.get(`${b}/datasets/Codes/rows`)); return { columns: x.columns, total: x.total, version: x.version, rows: x.rows }; };
    expect(await rows(nb)).toEqual(await rows(base));
    expect((await admin.get(`${nb}/datasets`)).body.datasets.map((d: any) => [d.name, d.description, d.current_version, d.sheets]))
      .toEqual((await admin.get(`${base}/datasets`)).body.datasets.map((d: any) => [d.name, d.description, d.current_version, d.sheets]));
    for (const pov of POVS) expect(await grid(nb, pov), JSON.stringify(pov)).toEqual(await grid(base, pov));
    // Security still bites in the copy: ann reads East, writes East only; bob sees no West.
    const ann = await signIn(env.h, 'ann@fidelity.test');
    const bob = await signIn(env.h, 'bob@fidelity.test');
    const eastPov = { ...POVS[1]!, Entity: 'East' };
    const westPov = { ...POVS[1]!, Entity: 'West' };
    for (const [u, pov] of [[ann, eastPov], [ann, westPov], [bob, eastPov], [bob, westPov]] as const) {
      const a = await u.post(`${base}/grid/read`, { ...TOTALS, pov });
      const b = await u.post(`${nb}/grid/read`, { ...TOTALS, pov });
      expect([b.status, b.body.values]).toEqual([a.status, a.body.values]);
    }
  });

  it('FINDING: members added but never deployed stay undeployed in the copy', async () => {
    expectOk(await admin.put(`${base}/dimensions/Entity/members`, { members: [{ name: 'North', parent: 'Total Company' }] }));
    const r = expectOk((await restoreNew('Pending Member Copy')).res, 201);
    const nb = `/v1/apps/${r.app_id}`;
    const north = (await members(nb, 'Entity')).find((m: any) => m.name === 'North');
    expect(north).toMatchObject({ name: 'North', parent: 'Total Company' });
    expect(north.deployed).toBe(false); // the copy deploys it
    expect(await members(nb, 'Entity')).toEqual(await members(base, 'Entity'));
  });

  it('FINDING: a parent change that was not deployed does not change the copy\'s totals', async () => {
    // Mar moves from Q1 to Q2 in the editor, but the application still rolls Mar into Q1.
    expectOk(await admin.put(`${base}/dimensions/Period/members`, { members: [{ name: 'Mar', parent: 'Q2' }] }));
    const r = expectOk((await restoreNew('Pending Move Copy')).res, 201);
    const nb = `/v1/apps/${r.app_id}`;
    for (const pov of POVS) expect(await grid(nb, pov), JSON.stringify(pov)).toEqual(await grid(base, pov));
  });

  it('FINDING: a snapshot whose pending metadata would make a data-holding leaf a parent can still be restored', async () => {
    // East holds data; a child is added under it but not deployed (deploy would refuse it).
    expectOk(await admin.put(`${base}/dimensions/Entity/members`, { members: [{ name: 'East North', parent: 'East' }] }));
    expect((await admin.post(`${base}/deploy`)).status).toBe(422);
    const { snap, res } = await restoreNew('Pending Parent Copy');
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const app = (await env.su.query<{ app_id: string; state: string }>(`select app_id, state from epm.application where name = 'Pending Parent Copy'`)).rows[0]!;
    expect(app.state).toBe('online');
    const n = (await env.su.query<{ n: number }>('select count(*)::int as n from epm.fact where app_id = $1', [app.app_id])).rows[0]!.n;
    expect(n).toBe(snap.fact_count);
  });
});
