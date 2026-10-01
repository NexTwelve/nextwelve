import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from './helpers.js';

const REV = 2;
const JAN = 0;

describe('member-level security and plan windows', () => {
  let h: Harness;
  let admin: Api;
  let base: string;
  const users = ['una@sec.test', 'gil@sec.test', 'moe@sec.test', 'pia@sec.test'];
  const api: Record<string, Api> = {};

  async function entitiesFor(user: Api) {
    const res = expectOk(
      await user.post(`${base}/grid/read`, {
        cube: 'Plan',
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Period: 'Jan', Department: 'Sales', Product: 'Widgets' },
        rows: { dimension: 'Entity', members: ['@idescendants(Total Company)'] },
        columns: { dimension: 'Account', members: ['Revenue'] },
      }),
    );
    return Object.fromEntries(res.rows.members.map((m: any, i: number) => [m.name, res.writable[i][0] ? 'write' : 'read']));
  }

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Sec', null, 'admin@sec.test');
    admin = await signIn(h, 'admin@sec.test');
    base = `/v1/apps/${await seedPlanApp(admin)}`;
    for (const email of users) {
      expectOk(await admin.post('/v1/users', { email }), 201);
      expectOk(await admin.post(`${base}/roles`, { email, role: 'planner' }));
    }
    expectOk(await admin.post('/v1/groups', { name: 'Readers' }), 201);
    expectOk(await admin.post('/v1/groups', { name: 'Writers' }), 201);
    expectOk(await admin.put('/v1/groups/Readers/members', { emails: ['gil@sec.test', 'moe@sec.test'] }));
    expectOk(await admin.put('/v1/groups/Writers/members', { emails: ['moe@sec.test'] }));
    expectOk(
      await admin.put(`${base}/grants`, {
        grants: [
          // una: read on everything, but an explicit write on East (closer grant wins).
          { principal: { user: 'una@sec.test' }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'read' },
          { principal: { user: 'una@sec.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' },
          // gil: group read on everything, personal deny on West.
          { principal: { group: 'Readers' }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'read' },
          { principal: { user: 'gil@sec.test' }, dimension: 'Entity', member: 'West', scope: 'member', access: 'none' },
          // moe: two groups grant the same member; the most permissive wins.
          { principal: { group: 'Writers' }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'write' },
          // pia: a group deny and a personal read on the same member; the user grant wins.
          { principal: { group: 'Readers' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'none' },
          { principal: { user: 'pia@sec.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'read' },
        ],
      }),
    );
    expectOk(await admin.put('/v1/groups/Readers/members', { emails: ['gil@sec.test', 'moe@sec.test', 'pia@sec.test'] }));
    for (const email of users) api[email] = await signIn(h, email);
  });
  afterAll(async () => h?.close());

  it('lets a closer grant override an inherited one', async () => {
    expect(await entitiesFor(api['una@sec.test']!)).toEqual({ 'Total Company': 'read', East: 'write', West: 'read' });
  });

  it('applies an explicit none as a deny that hides the member', async () => {
    // gil: Readers read everything; the group's own deny on East is closer; his personal deny hides West.
    expect(await entitiesFor(api['gil@sec.test']!)).toEqual({ 'Total Company': 'read' });
  });

  it('takes the most permissive grant among groups at the same distance', async () => {
    // moe: Readers (read) and Writers (write) both cover West, so West is writable; East has Readers' deny, which is closer.
    // Total Company is a parent, so it is never writable in a grid.
    expect(await entitiesFor(api['moe@sec.test']!)).toEqual({ 'Total Company': 'read', West: 'write' });
  });

  it('lets a user grant beat a group grant on the same member', async () => {
    expect(await entitiesFor(api['pia@sec.test']!)).toEqual({ 'Total Company': 'read', East: 'read', West: 'read' });
  });

  it('enforces write access inside apply_changes, not only when building the grid', async () => {
    const su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    const ids = Object.fromEntries(
      (await su.query<{ name: string; member_id: number }>('select name, member_id from epm.member')).rows.map((r) => [r.name, r.member_id]),
    );
    const una = (await su.query("select user_id, tenant_id from epm.app_user where email = 'una@sec.test'")).rows[0];
    const cube = (await su.query("select cube_id, app_id from epm.cube where name = 'Plan'")).rows[0];
    await su.end();

    const cell = (entity: string) => ({
      k: [cube.cube_id, ids.Budget, ids.Working, ids.FY27, ids.Jan, ids[entity], ids.Revenue, ids.Sales, ids.Widgets, 0, 0, 0, 0, 0, 0, 0],
      v: 7,
    });
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [una.tenant_id, una.user_id]);
      await c.query('savepoint s');
      await expect(
        c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: cube.app_id, source: 'api', cells: [cell('West')] })]),
      ).rejects.toMatchObject({ code: 'NX403' });
      await c.query('rollback to savepoint s');
      // A parent member is never a valid write target, even for an allowed entity.
      const parent = { ...cell('East'), k: [...cell('East').k] };
      parent.k[5] = ids['Total Company'];
      await expect(
        c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: cube.app_id, source: 'api', cells: [parent] })]),
      ).rejects.toMatchObject({ code: 'NX422' });
      await c.query('rollback to savepoint s');
      // Planners can't use admin-only sources.
      await expect(
        c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: cube.app_id, source: 'restore', cells: [cell('East')] })]),
      ).rejects.toMatchObject({ code: 'NX403' });
      await c.query('rollback to savepoint s');
      const ok = await c.query('select epm.apply_changes($1::jsonb) as r', [
        JSON.stringify({ app_id: cube.app_id, source: 'api', cells: [cell('East')] }),
      ]);
      expect(ok.rows[0].r.cell_count).toBe(1);
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('closes cells outside the plan window and when the version is locked, for planners only', async () => {
    const una = api['una@sec.test']!;
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', start_period: 'Feb', end_period: 'Jun' }));
    let g = expectOk(await una.post(`${base}/grid/read`, planGrid()));
    expect(g.writable[REV]).toEqual([false, true, true, false]); // Jan closed, Feb and Mar open, Q1 is a parent

    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', locked: true }));
    g = expectOk(await una.post(`${base}/grid/read`, planGrid()));
    expect(g.writable.flat().some(Boolean)).toBe(false);

    const adminGrid = expectOk(await admin.post(`${base}/grid/read`, planGrid()));
    expect(adminGrid.writable[REV][JAN]).toBe(true);
    const values = adminGrid.values.map((r: unknown[]) => [...r]);
    values[REV][JAN] = 42;
    expect(expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: adminGrid.grid_session_id, values })).cell_count).toBe(1);
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', locked: false }));
  });

  it('only lets app admins manage grants, roles and metadata', async () => {
    const una = api['una@sec.test']!;
    expect((await una.put(`${base}/grants`, { grants: [] })).status).toBe(403);
    expect((await una.post(`${base}/roles`, { email: 'una@sec.test', role: 'app_admin' })).status).toBe(403);
    expect((await una.post(`${base}/deploy`)).status).toBe(403);
    expect((await una.put(`${base}/dimensions/Entity/members`, { members: [{ name: 'North' }] })).status).toBe(403);
    expect((await una.post('/v1/apps', { name: 'Mine' })).status).toBe(403);
    expect((await una.get(`${base}/grants`)).status).toBe(403);
  });

  it('refuses grants on dimensions that are not secured', async () => {
    const res = await admin.put(`${base}/grants`, {
      grants: [{ principal: { user: 'una@sec.test' }, dimension: 'Account', member: 'Revenue', access: 'write' }],
    });
    expect(res.status).toBe(422);
  });
});
