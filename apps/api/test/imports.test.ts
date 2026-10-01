import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn } from './helpers.js';
import { writeXlsx } from './xlsx-writer.js';

// GL export from a fictional ERP: company code, cost center, GL account, product, month, amount.
const GL_CSV = `Company,Cost Center,GL Account,Product,Month,Amount
E01,S1,4000,Widgets,2026-01,"1,000.00"
E01,S1,4000,Widgets,2026-01,250.50
E01,S2,5000,Widgets,2026-01,(400.00)
E01,150,6100,Gadgets,2026-02,75
W01,S1,4000,Gadgets,2026-01,500
W01,S1,9100,Gadgets,2026-01,999
E01,S1,4000,Widgets,2026-03,0
E01,S1,4999,Widgets,2026-02,10
`;

const FORMAT = {
  cube: 'Plan',
  definition: {
    header_row: 1,
    dimensions: {
      Scenario: { value: 'Actual' },
      Version: { value: 'Working' },
      Years: { value: 'FY27' },
      Period: { column: 'Month' },
      Entity: { column: 'Company' },
      Account: { column: 'GL Account' },
      Department: { column: 'Cost Center' },
      Product: { column: 'Product' },
    },
    amount: { column: 'Amount' },
  },
};

const MAPPINGS = [
  { dimension: 'Entity', rule_type: 'explicit', source: 'E01', target: 'East' },
  { dimension: 'Entity', rule_type: 'explicit', source: 'W01', target: 'West' },
  { dimension: 'Account', rule_type: 'dataset', source: 'GL Map', target: 'Plan Account', options: { sheet: 'Accounts', key_column: 'GL' } },
  { dimension: 'Account', rule_type: 'like', source: '9*', target: '#skip', description: 'statistical GLs are not loaded' },
  { dimension: 'Department', rule_type: 'in', source: 'S1, S2', target: 'Sales' },
  { dimension: 'Department', rule_type: 'between', source: '100..199', target: 'Operations' },
  { dimension: 'Period', rule_type: 'like', source: '*-01', target: 'Jan' },
  { dimension: 'Period', rule_type: 'like', source: '*-02', target: 'Feb' },
  { dimension: 'Period', rule_type: 'like', source: '*-03', target: 'Mar' },
];

describe('file import with mapping rules', () => {
  let h: Harness;
  let admin: Api;
  let base: string;
  let fileId: string;

  const cell = (entity: string, account: string, period: string, dept = 'Sales', product = 'Widgets') => ({
    Scenario: 'Actual', Version: 'Working', Years: 'FY27', Entity: entity, Account: account, Period: period, Department: dept, Product: product,
  });
  async function value(entity: string, account: string, period: string, dept = 'Sales', product = 'Widgets') {
    const g = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: { Scenario: 'Actual', Version: 'Working', Years: 'FY27', Entity: entity, Department: dept, Product: product },
      rows: { dimension: 'Account', members: [account] },
      columns: { dimension: 'Period', members: [period] },
    }));
    return g.values[0][0];
  }

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Imports', null, 'admin@imp.test');
    admin = await signIn(h, 'admin@imp.test');
    base = `/v1/apps/${await seedPlanApp(admin)}`;
    // The GL crosswalk is maintained in Excel and published as a dataset.
    const crosswalk = writeXlsx([
      { name: 'Accounts', rows: [['GL', 'Description', 'Plan Account'], [4000, 'Product sales', 'Revenue'], [5000, 'Materials', 'COGS'], [6100, 'Office costs', 'Opex']] },
      { name: 'Notes', rows: [['Maintained by'], ['Controller']] },
    ]);
    const up = expectOk(await admin.upload(base, 'gl_crosswalk.xlsx', crosswalk, 'dataset'), 201);
    expectOk(await admin.put(`${base}/datasets/GL Map`, { file_id: up.file_id, description: 'GL to plan accounts' }));
    expectOk(await admin.put(`${base}/import-formats/GL Actuals`, FORMAT));
    expectOk(await admin.put(`${base}/import-formats/GL Actuals/mappings`, { rules: MAPPINGS }));
    fileId = expectOk(await admin.upload(base, 'gl_jan.csv', GL_CSV), 201).file_id;
  });
  afterAll(async () => h?.close());

  it('validates first and reports every line it cannot map, loading nothing', async () => {
    const run = expectOk(await admin.post(`${base}/import-formats/GL Actuals/run`, { file_id: fileId }));
    expect(run).toMatchObject({ status: 'failed', lines_read: 8, lines_rejected: 1, lines_skipped: 2, cells: 0, txn_id: null });
    expect(run.errors).toEqual([expect.objectContaining({ line: 9, error: 'Account: no mapping for "4999"' })]);
    expect(run.datasets_used).toEqual([{ dataset: 'GL Map', version: 1 }]);
    expect(await value('East', 'Revenue', 'Jan')).toBeNull();
  });

  it('loads once the mapping is fixed, summing lines that land on one cell', async () => {
    expectOk(await admin.put(`${base}/import-formats/GL Actuals/mappings`, {
      replace: false,
      rules: [{ dimension: 'Account', rule_type: 'explicit', source: '4999', target: 'Revenue' }],
    }));
    const dry = expectOk(await admin.post(`${base}/import-formats/GL Actuals/run`, { file_id: fileId, dry_run: true }));
    expect(dry).toMatchObject({ status: 'validated', lines_mapped: 6, cells: 0 });
    const run = expectOk(await admin.post(`${base}/import-formats/GL Actuals/run`, { file_id: fileId }));
    expect(run).toMatchObject({ status: 'loaded', lines_mapped: 6, lines_skipped: 2, lines_rejected: 0, cells: 5 });
    expect(await value('East', 'Revenue', 'Jan')).toBe(1250.5); // 1,000.00 + 250.50
    expect(await value('East', 'COGS', 'Jan')).toBe(-400); // (400.00) is negative
    expect(await value('East', 'Opex', 'Feb', 'Operations', 'Gadgets')).toBe(75); // cost center 150 is in 100..199
    expect(await value('West', 'Revenue', 'Jan', 'Sales', 'Gadgets')).toBe(500);
    const txns = expectOk(await admin.get(`${base}/txns?limit=1`));
    expect(txns.txns[0]).toMatchObject({ source: 'data_load', source_ref: 'GL Actuals', cell_count: 5 });
  });

  it('drills back from a cell to the file rows behind it', async () => {
    const drill = expectOk(await admin.post(`${base}/drill`, { cube: 'Plan', cell: cell('East', 'Revenue', 'Jan') }));
    expect(drill.lines.map((l: any) => [l.line_no, l.amount, l.file, l.format])).toEqual([
      [2, 1000, 'gl_jan.csv', 'GL Actuals'],
      [3, 250.5, 'gl_jan.csv', 'GL Actuals'],
    ]);
    expect(drill.lines[0].source).toMatchObject({ Company: 'E01', 'GL Account': '4000', Month: '2026-01' });
  });

  it('accumulates, replaces within the loaded scope, and undoes like any change', async () => {
    const acc = expectOk(await admin.post(`${base}/import-formats/GL Actuals/run`, { file_id: fileId, mode: 'accumulate' }));
    expect(acc.status).toBe('loaded');
    expect(await value('East', 'Revenue', 'Jan')).toBe(2501);

    // A corrected file for East, January only: replace clears East/Jan cells it no longer contains.
    const fix = expectOk(await admin.upload(base, 'gl_jan_fix.csv', 'Company,Cost Center,GL Account,Product,Month,Amount\nE01,S1,4000,Widgets,2026-01,900\n'), 201);
    const rep = expectOk(await admin.post(`${base}/import-formats/GL Actuals/run`, { file_id: fix.file_id, mode: 'replace' }));
    expect(rep).toMatchObject({ status: 'loaded', cells: 2 }); // Revenue set, COGS cleared
    expect(await value('East', 'Revenue', 'Jan')).toBe(900);
    expect(await value('East', 'COGS', 'Jan')).toBeNull();
    expect(await value('West', 'Revenue', 'Jan', 'Sales', 'Gadgets')).toBe(1000); // other entity untouched
    expect(await value('East', 'Opex', 'Feb', 'Operations', 'Gadgets')).toBe(150); // other period untouched

    const undo = expectOk(await admin.post(`${base}/txns/${rep.txn_id}/undo`, {}));
    expect(undo.cell_count).toBe(2);
    expect(await value('East', 'COGS', 'Jan')).toBe(-800);
  });

  it('can load the valid lines and leave the rejects in the report', async () => {
    const bad = expectOk(await admin.upload(base, 'gl_bad.csv', 'Company,Cost Center,GL Account,Product,Month,Amount\nE01,S1,4000,Widgets,2026-02,5\nZZ9,S1,4000,Widgets,2026-02,6\nE01,S1,4000,Widgets,2026-02,lots\n'), 201);
    const run = expectOk(await admin.post(`${base}/import-formats/GL Actuals/run`, { file_id: bad.file_id, load_valid_lines: true }));
    expect(run).toMatchObject({ status: 'loaded', lines_mapped: 1, lines_rejected: 2, cells: 1 });
    expect(run.errors.map((e: any) => e.error)).toEqual(['Entity: no mapping for "ZZ9"', 'amount "lots" is not a number']);
    const lines = expectOk(await admin.get(`${base}/imports/${run.run_id}/lines?errors=true`));
    expect(lines.lines).toHaveLength(2);
  });

  it('reads xlsx files, honoring the sheet and header row in the format', async () => {
    expectOk(await admin.put(`${base}/import-formats/Budget Sheet`, {
      cube: 'Plan',
      definition: {
        sheet: 'Upload',
        header_row: 2,
        dimensions: {
          Scenario: { value: 'Budget' }, Version: { value: 'Working' }, Years: { value: 'FY27' }, Entity: { value: 'East' },
          Department: { value: 'Sales' }, Product: { value: 'Widgets' }, Account: { column: 'A' }, Period: { column: 'Month' },
        },
        amount: { column: 'Value', scale: 1000 },
      },
    }));
    const book = writeXlsx([
      { name: 'Cover', rows: [['Budget upload, thousands']] },
      { name: 'Upload', rows: [['FY27 budget (USD thousands)'], ['Account', 'Month', 'Value'], ['Revenue', 'Mar', 12.5], ['COGS', 'Mar', 4]] },
    ]);
    const up = expectOk(await admin.upload(base, 'budget.xlsx', book), 201);
    const run = expectOk(await admin.post(`${base}/import-formats/Budget Sheet/run`, { file_id: up.file_id }));
    expect(run).toMatchObject({ status: 'loaded', cells: 2 });
    const g = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan',
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' },
      rows: { dimension: 'Account', members: ['Revenue', 'COGS', 'Gross Margin'] },
      columns: { dimension: 'Period', members: ['Mar'] },
    }));
    expect(g.values.map((r: any[]) => r[0])).toEqual([12500, 4000, 8500]);
  });

  it('imports from a dataset sheet instead of a file, with run-time values', async () => {
    const sheet = writeXlsx([{ name: 'Plan', rows: [['Account', 'Month', 'Value'], ['Revenue', 'Feb', 42]] }]);
    const up = expectOk(await admin.upload(base, 'driver_sheet.xlsx', sheet, 'dataset'), 201);
    expectOk(await admin.put(`${base}/datasets/Driver Sheet`, { file_id: up.file_id }));
    const run = expectOk(await admin.post(`${base}/import-formats/Budget Sheet/run`, {
      dataset: { name: 'Driver Sheet', sheet: 'Plan' },
      values: { Entity: 'West', Scenario: 'Actual' },
    }));
    expect(run).toMatchObject({ status: 'loaded', cells: 1 });
    const runs = expectOk(await admin.get(`${base}/imports`));
    expect(runs.runs[0].source_dataset).toEqual({ dataset: 'Driver Sheet', version: 1, sheet: 'Plan' });
  });

  it('keeps imports to power users and admins', async () => {
    for (const [email, role] of [['pln@imp.test', 'planner'], ['pwr@imp.test', 'power_user']] as const) {
      expectOk(await admin.post('/v1/users', { email }), 201);
      expectOk(await admin.post(`${base}/roles`, { email, role }));
    }
    const planner = await signIn(h, 'pln@imp.test');
    expect((await planner.upload(base, 'x.csv', 'a,b\n1,2\n')).status).toBe(403);
    expect((await planner.post(`${base}/import-formats/GL Actuals/run`, { file_id: fileId })).status).toBe(403);
    const power = await signIn(h, 'pwr@imp.test');
    expect((await power.put(`${base}/import-formats/GL Actuals/mappings`, { rules: [] })).status).toBe(403);
    // A power user can run loads, but still only into cells their grants allow.
    expect((await power.post(`${base}/import-formats/GL Actuals/run`, { file_id: fileId })).status).toBe(403);
  });

  it('rejects unsupported and broken files with a clear message', async () => {
    const xls = expectOk(await admin.upload(base, 'old.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])), 201);
    const res = await admin.post(`${base}/import-formats/Budget Sheet/run`, { file_id: xls.file_id });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/save as \.xlsx/);
    const broken = expectOk(await admin.upload(base, 'broken.xlsx', new TextEncoder().encode('not a zip')), 201);
    expect((await admin.post(`${base}/import-formats/Budget Sheet/run`, { file_id: broken.file_id })).body.message).toMatch(/not a valid \.xlsx/);
  });
});
