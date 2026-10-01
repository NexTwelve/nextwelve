import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readXlsx } from '../../src/files/tables.js';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Size limits on multi-dimension grids and reports. The "Big" application adds 300 Product leaves
 * (under Many Products) and 200 Department leaves (under Many Departments), so two dimensions on
 * one axis make 60,000 combinations and three make hundreds of thousands.
 */
const N_PRODUCTS = 300;
const N_DEPTS = 200;
const PRODUCTS = { dimension: 'Product', members: ['@leaves(Many Products)'] };
const DEPTS = { dimension: 'Department', members: ['@leaves(Many Departments)'] };

describe('rpt: limits on multi-dimension grids and reports', () => {
  let h: Harness;
  let admin: Api;
  let vic: Api; // viewer, reads East only
  let base: string;

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Limits', null, 'admin@lim.test');
    admin = await signIn(h, 'admin@lim.test');
    base = `/v1/apps/${await seedPlanApp(admin, 'Big')}`;
    const products = [{ name: 'Many Products', parent: 'All Products' }, ...Array.from({ length: N_PRODUCTS }, (_, i) => ({ name: `P${i + 1}`, parent: 'Many Products' }))];
    const depts = [{ name: 'Many Departments', parent: 'All Departments' }, ...Array.from({ length: N_DEPTS }, (_, i) => ({ name: `D${i + 1}`, parent: 'Many Departments' }))];
    expectOk(await admin.put(`${base}/dimensions/Product/members`, { members: products }));
    expectOk(await admin.put(`${base}/dimensions/Department/members`, { members: depts }));
    expectOk(await admin.post(`${base}/deploy`));
    expectOk(await admin.post('/v1/users', { email: 'vic@lim.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'vic@lim.test', role: 'viewer' }));
    expectOk(await admin.put(`${base}/grants`, {
      grants: [{ principal: { user: 'vic@lim.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'read' }],
    }));
    vic = await signIn(h, 'vic@lim.test');
  }, 40_000);
  afterAll(async () => h?.close());

  it('refuses a grid whose rows x columns exceed MAX_GRID_CELLS', async () => {
    const r = await vic.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Period: 'Jan', Entity: 'East', Account: 'Revenue' },
      rows: [PRODUCTS],
      columns: [DEPTS],
    });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/60000 cells/);
  });

  it('FINDING: an empty axis switches the grid cell limit off, so the other axis is built without bound', async () => {
    const pov = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Period: 'Jan', Entity: 'East' };
    // One row by 300 x 200 = 60,000 column tuples is refused...
    const one = await vic.post(`${base}/grid/read`, { cube: 'Plan', pov, rows: [{ dimension: 'Account', members: ['Revenue'] }], columns: [PRODUCTS, DEPTS] });
    expect(one.status).toBe(422);
    // ...but with no rows (@children of a leaf, or every row member filtered out by security) the
    // check is 0 x 60,000 = 0, so all 60,000 column tuples are materialised, stored in the grid
    // session and returned. With a third dimension on columns this grows multiplicatively.
    const none = await vic.post(`${base}/grid/read`, { cube: 'Plan', pov, rows: [{ dimension: 'Account', members: ['@children(Revenue)'] }], columns: [PRODUCTS, DEPTS] });
    expect({ status: none.status, columns: none.body?.columns?.tuples?.length ?? 0 }).toEqual({ status: 422, columns: 0 });
  });

  it('FINDING: an axis emptied by security switches MAX_REPORT_CELLS off for that user', async () => {
    expectOk(await admin.put(`${base}/reports/West Wide`, {
      cube: 'Plan',
      definition: {
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Account: 'Revenue' },
        rows: [{ dimension: 'Entity', members: ['West'] }],
        columns: [PRODUCTS, DEPTS, { dimension: 'Period', members: ['@idescendants(YearTotal)'] }],
        suppress_missing_columns: true,
      },
    }));
    // 1 x 300 x 200 x 9 = 540,000 combinations: refused for the admin...
    const forAdmin = await admin.post(`${base}/reports/West Wide/run`, {});
    expect(forAdmin.status).toBe(422);
    // ...but the viewer cannot read West, so rows are empty, the check sees 0 cells and all 540,000
    // column tuples are built (and would all be returned without column suppression).
    const forViewer = await vic.post(`${base}/reports/West Wide/run`, {});
    expect(forViewer.status).toBe(422);
  });

  it('refuses a report over MAX_REPORT_CELLS before reading data', async () => {
    expectOk(await admin.put(`${base}/reports/Too Big`, {
      cube: 'Plan',
      definition: {
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Account: 'Revenue' },
        rows: [PRODUCTS, DEPTS],
        columns: [{ dimension: 'Period', members: ['@idescendants(YearTotal)'] }],
      },
    }));
    const r = await vic.post(`${base}/reports/Too Big/run`, {});
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/540000 cells before suppression/);
  });

  it('FINDING: exporting a report taller than ~125k rows (inside MAX_REPORT_CELLS) to xlsx fails with a 500', async () => {
    // 3 x 300 x 200 = 180,000 rows by one column = 180,000 cells, under the 250,000 limit.
    expectOk(await admin.put(`${base}/reports/Tall`, {
      cube: 'Plan',
      definition: {
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East' },
        rows: [{ dimension: 'Period', members: ['@leaves(Q1)'] }, PRODUCTS, DEPTS],
        columns: [{ dimension: 'Account', members: ['Revenue'] }],
        suppress_missing_rows: false,
      },
    }));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // reportSheet computes label widths with Math.max(12, ...rows.map(...)): spreading 180,000
      // arguments overflows the call stack (RangeError), so the export is a 500 (and the
      // report_exported event was already committed).
      const x = await admin.raw('POST', `${base}/reports/Tall/run?format=xlsx`, '{}', 'application/json');
      expect(x.status).toBe(200);
      const [sheet] = readXlsx(x.bytes);
      expect(sheet!.rows.length).toBeGreaterThan(180_000);
    } finally {
      quiet.mockRestore();
    }
  }, 40_000);

  it("FINDING: an xlsx export wider than Excel's 16,384 columns is written anyway", async () => {
    // 1 row by 300 x 200 = 60,000 columns (60,000 cells, well inside MAX_REPORT_CELLS).
    expectOk(await admin.put(`${base}/reports/Wide`, {
      cube: 'Plan',
      definition: {
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Period: 'Jan', Entity: 'East' },
        rows: [{ dimension: 'Account', members: ['Revenue'] }],
        columns: [PRODUCTS, DEPTS],
        suppress_missing_rows: false,
      },
    }));
    const x = await admin.raw('POST', `${base}/reports/Wide/run?format=xlsx`, '{}', 'application/json');
    expect([200, 422]).toContain(x.status);
    if (x.status === 200) {
      // Columns past XFD (16,384) make Excel refuse or "repair" the workbook.
      const widest = Math.max(...readXlsx(x.bytes)[0]!.rows.map((r) => r.length));
      expect(widest).toBeLessThanOrEqual(16_384);
    }
  });

  it('refuses zero segments, more than three, more than 1,000 selections and 401-character expressions', async () => {
    const pov = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' };
    const grid = (rows: unknown, columns: unknown = [{ dimension: 'Period', members: ['Jan'] }]) => vic.post(`${base}/grid/read`, { cube: 'Plan', pov, rows, columns });
    expect((await grid([])).status).toBe(422);
    expect((await grid({ dimension: 'Account', members: [] })).status).toBe(422);
    expect((await grid([{ dimension: 'Account', members: ['Revenue'] }], [])).status).toBe(422);
    const four = ['Account', 'Scenario', 'Version', 'Years'].map((d) => ({ dimension: d, members: ['@idescendants(x)'] }));
    expect((await vic.post(`${base}/grid/read`, { cube: 'Plan', pov: { Entity: 'East', Department: 'Sales', Product: 'Widgets' }, rows: four, columns: [{ dimension: 'Period', members: ['Jan'] }] })).status).toBe(422);
    expect((await grid([{ dimension: 'Account', members: Array(1001).fill('Revenue') }])).status).toBe(422);
    expect((await grid([{ dimension: 'Account', members: ['x'.repeat(401)] }])).status).toBe(422);
    const long = await grid([{ dimension: 'Account', members: [`@children(${'x'.repeat(386)})`] }]);
    expect(long.status).toBe(422);
    expect(long.body.message).toMatch(/no deployed member/);
    // The same dimension twice on one axis.
    expect((await grid([{ dimension: 'Account', members: ['Revenue'] }, { dimension: 'account', members: ['COGS'] }])).status).toBe(422);
    // And reports refuse the same shapes at save time.
    const report = (rows: unknown) => admin.put(`${base}/reports/Shape`, {
      cube: 'Plan',
      definition: { pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' }, rows, columns: [{ dimension: 'Period', members: ['Jan'] }] },
    });
    expect((await report([])).status).toBe(422);
    expect((await report([{ dimension: 'Account', members: Array(1001).fill('Revenue') }])).status).toBe(422);
    expect((await report([{ dimension: 'Account', members: ['x'.repeat(401)] }])).status).toBe(422);
  });

  it('refuses three dimensions x 100 expressions each without blowing up', async () => {
    const t0 = Date.now();
    const r = await vic.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: { Version: 'Working', Years: 'FY27', Entity: 'East', Account: 'Revenue' },
      rows: [
        { dimension: 'Product', members: Array(100).fill('@idescendants(All Products)') },
        { dimension: 'Department', members: Array(100).fill('@idescendants(All Departments)') },
        { dimension: 'Period', members: Array(100).fill('@idescendants(YearTotal)') },
      ],
      columns: [{ dimension: 'Scenario', members: Array(100).fill('Budget') }],
    });
    expect(r.status).toBe(422);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);
});
