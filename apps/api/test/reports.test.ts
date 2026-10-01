import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readXlsx, parseCsv } from '../src/files/tables.js';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, provisionTenant, seedPlanApp, signIn, superQuery } from './helpers.js';

const REPORT = {
  cube: 'Plan',
  folder: 'Management',
  description: 'Gross margin by entity and product',
  definition: {
    pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales' },
    page: {},
    rows: [
      { dimension: 'Entity', members: ['@ichildren(Total Company)'] },
      { dimension: 'Account', members: ['@idescendants(Gross Margin)'] },
    ],
    columns: [
      { dimension: 'Product', members: ['Widgets', 'Gadgets'] },
      { dimension: 'Period', members: ['Jan', 'Feb', 'Q1'] },
    ],
    decimals: 1,
    scale: 1000,
  },
};

describe('multi-dimension grids and reports', () => {
  let h: Harness;
  let admin: Api;
  let base: string;

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Reports', null, 'admin@reports.test');
    admin = await signIn(h, 'admin@reports.test');
    base = `/v1/apps/${await seedPlanApp(admin)}`;
    expectOk(await admin.post('/v1/users', { email: 'wes@reports.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'wes@reports.test', role: 'planner' }));
    expectOk(await admin.put(`${base}/grants`, {
      grants: [{ principal: { user: 'wes@reports.test' }, dimension: 'Entity', member: 'West', scope: 'member', access: 'write' }],
    }));
  });
  afterAll(async () => h?.close());

  it('reads and writes a grid with two dimensions on columns', async () => {
    const spec = {
      cube: 'Plan',
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales' },
      rows: [{ dimension: 'Account', members: ['Revenue', 'COGS', 'Gross Margin'] }],
      columns: [{ dimension: 'Product', members: ['Widgets', 'Gadgets'] }, { dimension: 'Period', members: ['Jan', 'Feb'] }],
    };
    const g = expectOk(await admin.post(`${base}/grid/read`, spec));
    expect(g.columns.dimensions).toEqual(['Product', 'Period']);
    expect(g.columns.tuples.map((t: { name: string }[]) => t.map((m) => m.name).join('/'))).toEqual(['Widgets/Jan', 'Widgets/Feb', 'Gadgets/Jan', 'Gadgets/Feb']);
    expect(g.columns.members).toBeUndefined();
    expect(g.rows.members.map((m: { name: string }) => m.name)).toEqual(['Revenue', 'COGS', 'Gross Margin']);
    expect(g.writable[2]).toEqual([false, false, false, false]);
    const values = [[1000, 1100, 2000, 2100], [400, 450, 900, 950], [null, null, null, null]];
    expect(expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).cell_count).toBe(8);

    // Each value landed on its own coordinates: read back one product at a time.
    const gadgets = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { ...PLAN_POV, Product: 'Gadgets' },
      rows: { dimension: 'Account', members: ['Revenue', 'COGS', 'Gross Margin'] },
      columns: { dimension: 'Period', members: ['Jan', 'Feb', 'Q1'] },
    }));
    expect(gadgets.values).toEqual([[2000, 2100, 4100], [900, 950, 1850], [1100, 1150, 2250]]);
    // The rollup across both products sums the two-dimension writes.
    const both = expectOk(await admin.post(`${base}/grid/read`, {
      ...spec, columns: [{ dimension: 'Product', members: ['All Products'] }, { dimension: 'Period', members: ['Q1'] }],
    }));
    expect(both.values.map((r: number[]) => r[0])).toEqual([6200, 2700, 3500]);
  });

  it('refuses a dimension on both axes and more than three per axis', async () => {
    const bad = await admin.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Product: 'Widgets' },
      rows: [{ dimension: 'Entity', members: ['East'] }, { dimension: 'Account', members: ['Revenue'] }],
      columns: [{ dimension: 'Period', members: ['Jan'] }, { dimension: 'Entity', members: ['East'] }],
    });
    expect(bad.status).toBe(422);
    const four = await admin.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { Scenario: 'Budget', Version: 'Working', Department: 'Sales', Product: 'Widgets' },
      rows: ['Entity', 'Account', 'Years', 'Period'].map((d) => ({ dimension: d, members: ['@ichildren(x)'] })),
      columns: [{ dimension: 'Period', members: ['Jan'] }],
    });
    expect(four.status).toBe(422);
  });

  it('saves a form with two dimensions on rows and opens it', async () => {
    expectOk(await admin.put(`${base}/forms/Margin by Entity`, {
      cube: 'Plan',
      definition: {
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Product: 'Widgets' },
        rows: [{ dimension: 'Entity', members: ['East', 'West'] }, { dimension: 'Account', members: ['Revenue', 'COGS'] }],
        columns: { dimension: 'Period', members: ['Jan', 'Feb'] },
      },
    }));
    const f = expectOk(await admin.post(`${base}/forms/Margin by Entity/open`, {}));
    expect(f.grid.rows.tuples.map((t: { name: string }[]) => t.map((m) => m.name).join('/'))).toEqual(['East/Revenue', 'East/COGS', 'West/Revenue', 'West/COGS']);
    expect(f.grid.values[0]).toEqual([1000, 1100]);
    // A planner with West only sees West rows.
    const wes = await signIn(h, 'wes@reports.test');
    const w = expectOk(await wes.post(`${base}/forms/Margin by Entity/open`, {}));
    expect(w.grid.rows.tuples.map((t: { name: string }[]) => t[0]!.name)).toEqual(['West', 'West']);
    expect(w.grid.writable).toEqual([[true, true], [true, true]]);
  });

  it('runs a report with suppression, scale and decimals', async () => {
    expectOk(await admin.put(`${base}/reports/Margin Review`, REPORT));
    const r = expectOk(await admin.post(`${base}/reports/Margin Review/run`, {}));
    expect(r.report).toMatchObject({ name: 'Margin Review', title: 'Margin Review', version: 1 });
    expect(r.rows.dimensions).toEqual(['Entity', 'Account']);
    // Total Company and East have data; West has none and is suppressed.
    expect(r.rows.tuples.map((t: { name: string }[]) => t.map((m) => m.name).join('/'))).toEqual([
      'Total Company/Gross Margin', 'Total Company/Revenue', 'Total Company/COGS',
      'East/Gross Margin', 'East/Revenue', 'East/COGS',
    ]);
    expect(r.suppressed).toEqual({ rows: 3, columns: 0 });
    // In thousands with one decimal: Widgets Jan revenue 1000 -> 1.0, Q1 gross margin 3200 -> 1.3 (1300).
    expect(r.values[1].slice(0, 3)).toEqual([1, 1.1, 2.1]);
    expect(r.values[0].slice(0, 3)).toEqual([0.6, 0.7, 1.3]);
    expect(r.display).toEqual({ decimals: 1, scale: 1000, labels: 'name' });
  });

  it('downloads a report as an Excel workbook and as CSV', async () => {
    const x = await admin.raw('POST', `${base}/reports/Margin Review/run?format=xlsx`, '{}', 'application/json');
    expect(x.status).toBe(200);
    expect(x.headers.get('content-disposition')).toContain('Margin%20Review');
    const [sheet] = readXlsx(x.bytes);
    expect(sheet!.name).toBe('Margin Review');
    expect(sheet!.rows[0]![0]).toBe('Margin Review');
    expect(sheet!.rows.some((r) => r.includes('In thousands'))).toBe(true);
    const header = sheet!.rows.find((r) => r[0] === 'Entity')!;
    expect(header.slice(0, 2)).toEqual(['Entity', 'Account']);
    const east = sheet!.rows.findIndex((r) => r[0] === 'East');
    expect(sheet!.rows[east]!.slice(0, 5)).toEqual(['East', 'Gross Margin', 0.6, 0.7, 1.3]);
    expect(sheet!.rows[east + 1]!.slice(0, 3)).toEqual([null, 'Revenue', 1]);

    const csv = await admin.raw('POST', `${base}/reports/Margin Review/run?format=csv`, '{}', 'application/json');
    const rows = parseCsv(new TextDecoder().decode(csv.bytes)).rows;
    expect(rows[0]![0]).toBe('Margin Review');
    expect(rows.find((r) => r[0] === 'East')!.slice(0, 3)).toEqual(['East', 'Gross Margin', '0.6']);
    const events = await superQuery(h, "select count(*)::int as n from epm.security_event where event_type = 'report_exported'");
    expect(events[0].n).toBe(2);
  });

  it('shows a planner only the members they can read', async () => {
    const wes = await signIn(h, 'wes@reports.test');
    const r = expectOk(await wes.post(`${base}/reports/Margin Review/run`, {}));
    expect(r.rows.tuples).toEqual([]); // West has no data and Total Company is not readable
    expect((await wes.put(`${base}/reports/Margin Review`, REPORT)).status).toBe(403);
  });

  it('refuses a report that does not place every dimension', async () => {
    const bad = await admin.put(`${base}/reports/Broken`, { ...REPORT, definition: { ...REPORT.definition, pov: { Scenario: 'Budget' } } });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/does not place/);
  });
});
