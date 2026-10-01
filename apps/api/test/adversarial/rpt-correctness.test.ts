import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv, readXlsx } from '../../src/files/tables.js';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn, superQuery } from '../helpers.js';

/**
 * Values in multi-dimension grids and reports: where submitted values land, how parents on several
 * axes and parent POV members roll up with '-' and '~', display rounding, and compatibility with
 * grids, grid sessions and forms from before multi-dimension axes.
 *
 * Product gains Samples (agg '~', never rolls up) and Returns (agg '-') under All Products.
 */
const BASE_POV = { Scenario: 'Budget', Version: 'Working', Years: 'FY27' };
const SALES = { ...BASE_POV, Department: 'Sales' };
const names = (tuples: { name: string }[][]) => tuples.map((t) => t.map((m) => m.name).join('/'));

describe('rpt: multi-dimension values, rounding and compatibility', () => {
  let h: Harness;
  let admin: Api;
  let nobody: Api; // planner without any Entity grant
  let appId: string;
  let base: string;
  let tenantId: string;

  /** Rewrite a stored form as the superuser (the history trigger needs the tenant set). */
  async function storeFormDefinition(name: string, definition: unknown) {
    const su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    try {
      await su.query('begin');
      await su.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await su.query('update epm.form set definition = $3 where app_id = $1 and name = $2', [appId, name, definition]);
      await su.query('commit');
    } finally {
      await su.end();
    }
  }

  async function leafGrid(entity: string, product: string, department = 'Sales') {
    return expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: { ...BASE_POV, Entity: entity, Product: product, Department: department },
      rows: { dimension: 'Account', members: ['Revenue', 'COGS', 'Opex'] },
      columns: { dimension: 'Period', members: ['Jan', 'Feb', 'Mar'] },
    })).values;
  }

  beforeAll(async () => {
    h = await createHarness();
    tenantId = await provisionTenant(h.db, 'Calc', null, 'admin@calc.test');
    admin = await signIn(h, 'admin@calc.test');
    appId = await seedPlanApp(admin, 'Calc');
    base = `/v1/apps/${appId}`;
    expectOk(await admin.put(`${base}/dimensions/Product/members`, {
      members: [{ name: 'Samples', parent: 'All Products', agg_op: '~' }, { name: 'Returns', parent: 'All Products', agg_op: '-' }],
    }));
    expectOk(await admin.post(`${base}/deploy`));
    expectOk(await admin.post('/v1/users', { email: 'nobody@calc.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'nobody@calc.test', role: 'planner' }));
    nobody = await signIn(h, 'nobody@calc.test');

    // One submit through a grid with two dimensions on each axis.
    //   rows    Entity (East, West) x Product (Widgets, Gadgets, Samples, Returns)  i = 4e + p
    //   columns Account (Revenue, COGS, Opex) x Period (Jan, Feb, Mar)              j = 3a + m
    const g = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: SALES,
      rows: [{ dimension: 'Entity', members: ['East', 'West'] }, { dimension: 'Product', members: ['Widgets', 'Gadgets', 'Samples', 'Returns'] }],
      columns: [{ dimension: 'Account', members: ['Revenue', 'COGS', 'Opex'] }, { dimension: 'Period', members: ['Jan', 'Feb', 'Mar'] }],
    }));
    expect(g.writable.flat().every(Boolean)).toBe(true);
    const v: (number | null)[][] = g.values.map((r: unknown[]) => r.map(() => null));
    v[0]![0] = 100; v[0]![1] = 200; v[0]![3] = 30; v[0]![7] = 10; // East Widgets: Rev Jan, Rev Feb, COGS Jan, Opex Feb
    v[2]![0] = 5000; // East Samples Rev Jan
    v[3]![4] = 40; // East Returns COGS Feb
    v[5]![0] = 1000; v[5]![5] = 300; // West Gadgets: Rev Jan, COGS Mar
    expect(expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: v })).cell_count).toBe(8);
    // And one Operations value through an old-style single-dimension grid.
    const ops = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { ...BASE_POV, Entity: 'East', Product: 'Widgets', Department: 'Operations' },
      rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] },
    }));
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: ops.grid_session_id, values: [[7]] }));
  });
  afterAll(async () => h?.close());

  it('lands every value submitted through a two-by-two-dimension grid on its own coordinates', async () => {
    expect(await leafGrid('East', 'Widgets')).toEqual([[100, 200, null], [30, null, null], [null, 10, null]]);
    expect(await leafGrid('East', 'Samples')).toEqual([[5000, null, null], [null, null, null], [null, null, null]]);
    expect(await leafGrid('East', 'Returns')).toEqual([[null, null, null], [null, 40, null], [null, null, null]]);
    expect(await leafGrid('West', 'Gadgets')).toEqual([[1000, null, null], [null, null, 300], [null, null, null]]);
    expect((await leafGrid('East', 'Gadgets')).flat().every((x: unknown) => x === null)).toBe(true);
    expect((await leafGrid('West', 'Widgets')).flat().every((x: unknown) => x === null)).toBe(true);
    const facts = await superQuery(h, 'select count(*)::int as n from epm.fact where app_id = $1', [appId]);
    expect(facts[0].n).toBe(9);
  });

  it("rolls up parents on several axes and a parent POV member with '-' and '~' signs", async () => {
    // All Products = Widgets + Gadgets - Returns (+ 0 x Samples); COGS and Opex subtract.
    // East, all departments: Revenue 100+200+7 = 307; COGS 30; Returns COGS 40 (- x - = +40); Opex 10.
    const spec = {
      cube: 'Plan',
      pov: { ...BASE_POV, Department: 'All Departments' },
      rows: [{ dimension: 'Entity', members: ['Total Company', 'East'] }, { dimension: 'Account', members: ['Net Income', 'Gross Margin'] }],
      columns: [{ dimension: 'Product', members: ['All Products', 'Samples', 'Returns'] }, { dimension: 'Period', members: ['Q1', 'YearTotal'] }],
    };
    const g = expectOk(await admin.post(`${base}/grid/read`, spec));
    expect(names(g.rows.tuples)).toEqual(['Total Company/Net Income', 'Total Company/Gross Margin', 'East/Net Income', 'East/Gross Margin']);
    expect(g.values).toEqual([
      [1007, 1007, 5000, 5000, -40, -40],
      [1017, 1017, 5000, 5000, -40, -40],
      [307, 307, 5000, 5000, -40, -40],
      [317, 317, 5000, 5000, -40, -40],
    ]);
    expect(g.writable.flat().some(Boolean)).toBe(false);
    // The old single-dimension path agrees on one of those cells.
    const one = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { ...BASE_POV, Department: 'All Departments', Entity: 'Total Company', Product: 'All Products' },
      rows: { dimension: 'Account', members: ['Net Income', 'Gross Margin'] }, columns: { dimension: 'Period', members: ['Q1'] },
    }));
    expect(one.values).toEqual([[1007], [1017]]);
    // A report with the same layout shows the same numbers.
    expectOk(await admin.put(`${base}/reports/Same Layout`, {
      cube: 'Plan',
      definition: { pov: spec.pov, rows: spec.rows, columns: spec.columns, suppress_missing_rows: false },
    }));
    const r = expectOk(await admin.post(`${base}/reports/Same Layout/run`, {}));
    expect(r.values).toEqual(g.values);
  });

  it('collapses duplicate selections (Jan and @leaves(Q1)) on a multi-dimension axis', async () => {
    const g = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: { ...SALES, Entity: 'East', Account: 'Revenue' },
      rows: [{ dimension: 'Product', members: ['Widgets', '@ichildren(All Products)', 'widgets'] }],
      columns: [{ dimension: 'Period', members: ['Jan', '@leaves(Q1)', 'Q1', '@ichildren(Q1)'] }],
    }));
    // First occurrence wins; @ichildren lists in hierarchy (sort order) order.
    expect(g.rows.members.map((m: { name: string }) => m.name)).toEqual(['Widgets', 'All Products', 'Samples', 'Returns', 'Gadgets']);
    expect(g.columns.members.map((m: { name: string }) => m.name)).toEqual(['Jan', 'Feb', 'Mar', 'Q1']);
    expect(g.values[0]).toEqual([100, 200, null, 300]);
    expect(g.values[1]).toEqual([100, 200, null, 300]); // Samples is '~', so All Products = Widgets here
  });

  it('handles axes left empty by security in grids, submit and report exports', async () => {
    const onRows = expectOk(await nobody.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { ...SALES, Product: 'Widgets' },
      rows: [{ dimension: 'Entity', members: ['@idescendants(Total Company)'] }, { dimension: 'Account', members: ['Revenue'] }],
      columns: [{ dimension: 'Period', members: ['Jan', 'Feb'] }],
    }));
    expect({ tuples: onRows.rows.tuples, values: onRows.values, writable: onRows.writable }).toEqual({ tuples: [], values: [], writable: [] });
    expect(expectOk(await nobody.post(`${base}/grid/submit`, { grid_session_id: onRows.grid_session_id, values: [] })).cell_count).toBe(0);

    const onCols = expectOk(await nobody.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { ...SALES, Product: 'Widgets' },
      rows: [{ dimension: 'Account', members: ['Revenue', 'COGS'] }],
      columns: [{ dimension: 'Entity', members: ['East', 'West'] }, { dimension: 'Period', members: ['Jan'] }],
    }));
    expect({ cols: onCols.columns.tuples, values: onCols.values }).toEqual({ cols: [], values: [[], []] });
    expect(expectOk(await nobody.post(`${base}/grid/submit`, { grid_session_id: onCols.grid_session_id, values: [[], []] })).cell_count).toBe(0);

    expectOk(await admin.put(`${base}/reports/By Entity`, {
      cube: 'Plan',
      definition: {
        pov: { ...SALES, Product: 'Widgets', Account: 'Revenue' },
        rows: [{ dimension: 'Entity', members: ['@idescendants(Total Company)'] }],
        columns: [{ dimension: 'Period', members: ['Jan', 'Feb'] }],
        suppress_missing_rows: false,
      },
    }));
    const r = expectOk(await nobody.post(`${base}/reports/By Entity/run`, {}));
    expect({ rows: r.rows.tuples, values: r.values, suppressed: r.suppressed }).toEqual({ rows: [], values: [], suppressed: { rows: 0, columns: 0 } });
    const x = await nobody.raw('POST', `${base}/reports/By Entity/run?format=xlsx`, '{}', 'application/json');
    expect(x.status).toBe(200);
    expect(readXlsx(x.bytes)[0]!.rows[0]![0]).toBe('By Entity');
    const c = await nobody.raw('POST', `${base}/reports/By Entity/run?format=csv`, '{}', 'application/json');
    expect(parseCsv(new TextDecoder().decode(c.bytes)).rows.find((row) => row[0] === 'Entity')).toEqual(['Entity', 'Jan', 'Feb']);
  });

  it('suppresses every row and column of a report with no data, and still exports it', async () => {
    expectOk(await admin.put(`${base}/reports/Empty`, {
      cube: 'Plan',
      definition: {
        pov: { Scenario: 'Budget', Version: 'Final', Years: 'FY27', Department: 'Sales', Period: 'Jan' },
        rows: [{ dimension: 'Entity', members: ['East', 'West'] }, { dimension: 'Account', members: ['@idescendants(Net Income)'] }],
        columns: [{ dimension: 'Product', members: ['@ichildren(All Products)'] }],
        suppress_missing_rows: true,
        suppress_missing_columns: true,
      },
    }));
    const r = expectOk(await admin.post(`${base}/reports/Empty/run`, {}));
    expect({ rows: r.rows.tuples.length, cols: r.columns.tuples.length, values: r.values, suppressed: r.suppressed })
      .toEqual({ rows: 0, cols: 0, values: [], suppressed: { rows: 10, columns: 5 } });
    const x = await admin.raw('POST', `${base}/reports/Empty/run?format=xlsx`, '{}', 'application/json');
    expect(x.status).toBe(200);
    const sheet = readXlsx(x.bytes)[0]!;
    expect(sheet.rows.find((row) => row[0] === 'Entity')).toEqual(['Entity', 'Account']);
  });

  describe('display rounding', () => {
    beforeAll(async () => {
      // Actual / East / Widgets / Sales Revenue: Jan..Jun.
      const g = expectOk(await admin.post(`${base}/grid/read`, {
        cube: 'Plan', pov: { Scenario: 'Actual', Version: 'Working', Years: 'FY27', Entity: 'East', Product: 'Widgets', Department: 'Sales' },
        rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['@leaves(YearTotal)'] },
      }));
      expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[1500, -1500, 1005, -2500, 2500, -125]] }));
      const report = (name: string, decimals: number) => admin.put(`${base}/reports/${name}`, {
        cube: 'Plan',
        definition: {
          pov: { Scenario: 'Actual', Version: 'Working', Years: 'FY27', Entity: 'East', Product: 'Widgets', Department: 'Sales' },
          rows: [{ dimension: 'Account', members: ['Revenue'] }],
          columns: [{ dimension: 'Period', members: ['@leaves(YearTotal)'] }],
          scale: 1000,
          decimals,
        },
      });
      expectOk(await report('Thousands 0dp', 0));
      expectOk(await report('Thousands 2dp', 2));
    });

    it('rounds positive halves up and never shows -0', async () => {
      const r = expectOk(await admin.post(`${base}/reports/Thousands 0dp/run`, {}));
      expect(r.values[0][0]).toBe(2); // 1.5
      expect(r.values[0][4]).toBe(3); // 2.5
      expect(Object.is(r.values[0][5], -0)).toBe(false); // -0.125 -> 0, not -0
    });

    it('FINDING: negative halves round toward zero, so -1.5 shows as -1 while 1.5 shows as 2', async () => {
      // Math.round rounds .5 toward +infinity. Postgres numeric and Excel display both round half
      // away from zero, so a report's -1,500 in thousands should read -2 (and -2,500 -3).
      const r0 = expectOk(await admin.post(`${base}/reports/Thousands 0dp/run`, {}));
      const r2 = expectOk(await admin.post(`${base}/reports/Thousands 2dp/run`, {}));
      expect({ feb: r0.values[0][1], apr: r0.values[0][3], jun2dp: r2.values[0][5] }).toEqual({ feb: -2, apr: -3, jun2dp: -0.13 });
    });

    it('FINDING: binary floating point rounds exact .5 values down (1,005 in thousands at 2 decimals shows 1, not 1.01)', async () => {
      // 1005 / 1000 * 100 = 100.49999999999999 in binary floating point, so Math.round gives 100.
      const r2 = expectOk(await admin.post(`${base}/reports/Thousands 2dp/run`, {}));
      expect(r2.values[0][2]).toBe(1.01);
      const csv = await admin.raw('POST', `${base}/reports/Thousands 2dp/run?format=csv`, '{}', 'application/json');
      expect(parseCsv(new TextDecoder().decode(csv.bytes)).rows.find((row) => row[0] === 'Revenue')![3]).toBe('1.01');
    });

    it('keeps large values near the numeric(24,6) limit, and sums past it, at 6 decimals', async () => {
      const spec = {
        cube: 'Plan', pov: { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Entity: 'West', Product: 'Gadgets', Department: 'Sales' },
        rows: { dimension: 'Account', members: ['Revenue', 'COGS'] }, columns: { dimension: 'Period', members: ['Jan', 'Feb', 'Q1'] },
      };
      const g = expectOk(await admin.post(`${base}/grid/read`, spec));
      expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[9e17, 9e17, null], [123456789012.345678, -0.000001, null]] }));
      const grid = expectOk(await admin.post(`${base}/grid/read`, spec)).values;
      expect(grid[0]).toEqual([9e17, 9e17, 1.8e18]);
      expectOk(await admin.put(`${base}/reports/Big Numbers`, {
        cube: 'Plan',
        definition: {
          pov: { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Entity: 'West', Product: 'Gadgets', Department: 'Sales' },
          rows: [{ dimension: 'Account', members: ['Revenue', 'COGS'] }],
          columns: [{ dimension: 'Period', members: ['Jan', 'Feb', 'Q1'] }],
          decimals: 6,
        },
      }));
      const r = expectOk(await admin.post(`${base}/reports/Big Numbers/run`, {}));
      expect(r.values).toEqual(grid);
      const sheet = readXlsx((await admin.raw('POST', `${base}/reports/Big Numbers/run?format=xlsx`, '{}', 'application/json')).bytes)[0]!;
      expect(sheet.rows.find((row) => row[0] === 'Revenue')).toEqual(['Revenue', ...grid[0]]);
      expect(sheet.rows.find((row) => row[0] === 'COGS')).toEqual(['COGS', ...grid[1]]);
      // In millions at 6 decimals: -0.000001 becomes -1e-12 and must show as 0 (never -0).
      expectOk(await admin.put(`${base}/reports/Big Numbers M`, {
        cube: 'Plan',
        definition: {
          pov: { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Entity: 'West', Product: 'Gadgets', Department: 'Sales' },
          rows: [{ dimension: 'Account', members: ['Revenue', 'COGS'] }],
          columns: [{ dimension: 'Period', members: ['Jan', 'Feb', 'Q1'] }],
          decimals: 6,
          scale: 1000000,
        },
      }));
      const m = expectOk(await admin.post(`${base}/reports/Big Numbers M/run`, {}));
      expect(m.values).toEqual([[9e11, 9e11, 1.8e12], [123456.789012, 0, 123456.789012]]);
      const mx = readXlsx((await admin.raw('POST', `${base}/reports/Big Numbers M/run?format=xlsx`, '{}', 'application/json')).bytes)[0]!;
      expect(mx.rows.some((row) => row.includes('In millions'))).toBe(true);
      expect(Object.is(mx.rows.find((row) => row[0] === 'COGS')![2], -0)).toBe(false);
    });
  });

  describe('compatibility with single-dimension grids and older stored shapes', () => {
    const OLD_FORM = {
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' },
      page: {},
      rows: { dimension: 'Account', members: ['Revenue', 'COGS', 'Opex'] },
      columns: { dimension: 'Period', members: ['Jan', 'Feb'] },
      read_only: false,
    };

    it('keeps dimension, members and the old row/column layout on single-dimension grid responses', async () => {
      const g = expectOk(await admin.post(`${base}/grid/read`, {
        cube: 'Plan', pov: { ...SALES, Entity: 'East', Product: 'Widgets' },
        rows: { dimension: 'Account', members: ['Revenue', 'COGS'] }, columns: { dimension: 'Period', members: ['Jan', 'Feb'] },
      }));
      expect(g.rows.dimension).toBe('Account');
      expect(g.columns.dimension).toBe('Period');
      expect(g.rows.members).toEqual([
        { name: 'Revenue', alias: null, leaf: true, level: 2 },
        { name: 'COGS', alias: null, leaf: true, level: 2 },
      ]);
      expect(g.columns.members.map((m: { name: string }) => m.name)).toEqual(['Jan', 'Feb']);
      expect(g.values).toEqual([[100, 200], [30, null]]);
    });

    it('still submits a grid session stored with the old layout (plain member ids)', async () => {
      const spec = {
        cube: 'Plan', pov: { ...SALES, Entity: 'West', Product: 'Widgets' },
        rows: { dimension: 'Account', members: ['Revenue', 'COGS'] }, columns: { dimension: 'Period', members: ['Apr', 'May'] },
      };
      const g = expectOk(await admin.post(`${base}/grid/read`, spec));
      await superQuery(h, `
        update epm.grid_session
           set layout = jsonb_set(jsonb_set(layout, '{rows}', (select jsonb_agg(x->0) from jsonb_array_elements(layout->'rows') x)),
                                  '{cols}', (select jsonb_agg(x->0) from jsonb_array_elements(layout->'cols') x))
         where grid_session_id = $1`, [g.grid_session_id]);
      const stored = await superQuery(h, 'select layout from epm.grid_session where grid_session_id = $1', [g.grid_session_id]);
      expect(typeof stored[0].layout.rows[0]).toBe('number');
      const res = expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[11, null], [null, 22]] }));
      expect(res.cell_count).toBe(2);
      expect(expectOk(await admin.post(`${base}/grid/read`, spec)).values).toEqual([[11, null], [null, 22]]);
    });

    it('opens and exports a form stored in the old single-object axis shape', async () => {
      expectOk(await admin.put(`${base}/forms/Old Shape`, { cube: 'Plan', definition: { ...OLD_FORM, rows: [OLD_FORM.rows], columns: [OLD_FORM.columns] } }));
      await storeFormDefinition('Old Shape', OLD_FORM);
      const f = expectOk(await admin.post(`${base}/forms/Old Shape/open`, {}));
      expect(f.grid.rows.members.map((m: { name: string }) => m.name)).toEqual(['Revenue', 'COGS', 'Opex']);
      expect(f.grid.values).toEqual([[100, 200], [30, null], [null, 10]]);
      expect((await admin.raw('GET', `${base}/definitions/export?format=xlsx`)).status).toBe(200);
    });

    it('FINDING: a form saved with more than 100 selections before the cap existed no longer opens or exports', async () => {
      // The previous FormDefinition / GridSpec accepted any number of member selections per axis.
      // Such a form is still stored; now GridSpec.parse in openForm and axisOf in the definitions
      // export reject it with 422 "request body is invalid", for every user.
      const many = Array.from({ length: 101 }, (_, i) => ['Revenue', 'COGS', 'Opex', 'Gross Margin', 'Net Income'][i % 5]!);
      expectOk(await admin.put(`${base}/forms/Long Form`, { cube: 'Plan', definition: { ...OLD_FORM, rows: [OLD_FORM.rows], columns: [OLD_FORM.columns] } }));
      await storeFormDefinition('Long Form', { ...OLD_FORM, rows: { dimension: 'Account', members: many } });
      const open = await admin.post(`${base}/forms/Long Form/open`, {});
      const exported = await admin.raw('GET', `${base}/definitions/export?format=xlsx`);
      expect({ open: open.status, export: exported.status }).toEqual({ open: 200, export: 200 });
    });
  });
});
