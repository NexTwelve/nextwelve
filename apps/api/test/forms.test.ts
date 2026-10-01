import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn } from './helpers.js';

const REVENUE_FORM = {
  cube: 'Plan',
  folder: 'Revenue',
  description: 'Revenue by account and month',
  definition: {
    pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales' },
    page: { Entity: ['@leaves(Total Company)'], Product: ['Widgets', 'Gadgets'] },
    rows: { dimension: 'Account', members: ['@idescendants(Gross Margin)'] },
    columns: { dimension: 'Period', members: ['@leaves(Q1)', 'Q1'] },
  },
};

describe('saved forms', () => {
  let h: Harness;
  let admin: Api;
  let base: string;

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Forms', null, 'admin@forms.test');
    admin = await signIn(h, 'admin@forms.test');
    base = `/v1/apps/${await seedPlanApp(admin)}`;
    for (const [email, role] of [['pam@forms.test', 'planner'], ['vin@forms.test', 'viewer'], ['pow@forms.test', 'power_user']]) {
      expectOk(await admin.post('/v1/users', { email }), 201);
      expectOk(await admin.post(`${base}/roles`, { email, role }));
    }
    expectOk(
      await admin.put(`${base}/grants`, {
        grants: [
          { principal: { user: 'pam@forms.test' }, dimension: 'Entity', member: 'West', scope: 'member', access: 'write' },
          { principal: { user: 'vin@forms.test' }, dimension: 'Entity', member: 'Total Company', access: 'read' },
        ],
      }),
    );
  });
  afterAll(async () => h?.close());

  it('saves a form and lists it', async () => {
    expect(expectOk(await admin.put(`${base}/forms/Revenue Entry`, REVENUE_FORM))).toEqual({ name: 'Revenue Entry', version: 1 });
    // Saving the same definition again is not a new version; a change is.
    expect(expectOk(await admin.put(`${base}/forms/Revenue Entry`, REVENUE_FORM)).version).toBe(1);
    expect(expectOk(await admin.put(`${base}/forms/Revenue Entry`, { ...REVENUE_FORM, description: 'Revenue by product' })).version).toBe(2);
    const list = expectOk(await admin.get(`${base}/forms`));
    expect(list.forms).toEqual([expect.objectContaining({ name: 'Revenue Entry', folder: 'Revenue', cube: 'Plan', read_only: false })]);
  });

  it('rejects definitions that do not cover the cube exactly once', async () => {
    const missing = structuredClone(REVENUE_FORM);
    delete (missing.definition.pov as any).Department;
    expect((await admin.put(`${base}/forms/Bad`, missing)).body.message).toMatch(/does not place Department/);

    const twice = structuredClone(REVENUE_FORM);
    (twice.definition.pov as any).Product = 'Widgets';
    expect((await admin.put(`${base}/forms/Bad`, twice)).body.message).toMatch(/Product is placed twice/);

    const unknown = structuredClone(REVENUE_FORM);
    unknown.definition.rows.members = ['@idescendants(Nope)'];
    expect((await admin.put(`${base}/forms/Bad`, unknown)).status).toBe(422);

    const parentPov = structuredClone(REVENUE_FORM);
    parentPov.definition.pov.Department = '@children(All Departments)';
    expect((await admin.put(`${base}/forms/Bad`, parentPov)).body.message).toMatch(/single member/);
  });

  it('opens with page choices limited to what the user can read', async () => {
    const pam = await signIn(h, 'pam@forms.test');
    const opened = expectOk(await pam.post(`${base}/forms/Revenue Entry/open`, {}));
    expect(opened.page).toEqual({
      Entity: { selected: 'West', options: ['West'] },
      Product: { selected: 'Widgets', options: ['Widgets', 'Gadgets'] },
    });
    expect(opened.grid.rows.members.map((m: any) => [m.name, m.level])).toEqual([['Gross Margin', 1], ['Revenue', 2], ['COGS', 2]]);
    expect(opened.grid.writable[1]).toEqual([true, true, true, false]);

    const gadgets = expectOk(await pam.post(`${base}/forms/Revenue Entry/open`, { page: { product: 'gadgets' } }));
    expect(gadgets.grid.pov).toMatchObject({ Entity: 'West', Product: 'Gadgets' });
    expect((await pam.post(`${base}/forms/Revenue Entry/open`, { page: { Entity: 'East' } })).status).toBe(422);
  });

  it('saves through the form grid like any grid', async () => {
    const pam = await signIn(h, 'pam@forms.test');
    const opened = expectOk(await pam.post(`${base}/forms/Revenue Entry/open`, {}));
    const values = opened.grid.values.map((r: unknown[]) => [...r]);
    values[1][0] = 300;
    values[2][0] = 120;
    expect(expectOk(await pam.post(`${base}/grid/submit`, { grid_session_id: opened.grid.grid_session_id, values })).cell_count).toBe(2);
    const again = expectOk(await pam.post(`${base}/forms/Revenue Entry/open`, {}));
    expect(again.grid.values[0][0]).toBe(180);
    expect(again.grid.values[1][3]).toBe(300);
  });

  it('locks every cell on a read-only form', async () => {
    const report = structuredClone(REVENUE_FORM);
    (report.definition as any).read_only = true;
    expectOk(await admin.put(`${base}/forms/Revenue Report`, report));
    const opened = expectOk(await admin.post(`${base}/forms/Revenue Report/open`, {}));
    expect(opened.form.read_only).toBe(true);
    expect(opened.grid.writable.flat().some(Boolean)).toBe(false);
    const res = expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: opened.grid.grid_session_id, values: opened.grid.values.map((r: any[]) => r.map(() => 1)) }));
    expect(res.cell_count).toBe(0);
  });

  it('lets power users manage forms but not planners or viewers', async () => {
    const pow = await signIn(h, 'pow@forms.test');
    expectOk(await pow.put(`${base}/forms/Power Form`, REVENUE_FORM));
    const pam = await signIn(h, 'pam@forms.test');
    expect((await pam.put(`${base}/forms/Pam Form`, REVENUE_FORM)).status).toBe(403);
    const vin = await signIn(h, 'vin@forms.test');
    expect((await vin.del(`${base}/forms/Power Form`)).status).toBe(403);
    const opened = expectOk(await vin.post(`${base}/forms/Revenue Entry/open`, { page: { Entity: 'East' } }));
    expect(opened.grid.writable.flat().some(Boolean)).toBe(false);
    expectOk(await pow.del(`${base}/forms/Power Form`));
    expect((await pow.get(`${base}/forms/Power Form`)).status).toBe(404);
  });
});
