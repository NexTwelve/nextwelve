import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinMembers, splitMembers } from '../src/definitions.js';
import { parseCsv, readXlsx } from '../src/files/tables.js';
import { csvUnguard, writeCsv, writeXlsx } from '../src/files/xlsx.js';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn, superQuery } from './helpers.js';

const FORM = {
  cube: 'Plan',
  folder: 'Revenue',
  description: '=SUM(A1) looks like a formula',
  definition: {
    pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales' },
    page: { Entity: ['@leaves(Total Company)'], Product: ['Widgets', 'Smith, John'] },
    rows: { dimension: 'Account', members: ['@idescendants(Gross Margin)'] },
    columns: { dimension: 'Period', members: ['@leaves(Q1)', 'Q1'] },
  },
};
const REPORT = {
  cube: 'Plan',
  definition: {
    pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Product: 'Widgets' },
    rows: [{ dimension: 'Entity', members: ['@ichildren(Total Company)'] }, { dimension: 'Account', members: ['Revenue'] }],
    columns: [{ dimension: 'Period', members: ['Q1', 'Q2'] }],
    decimals: 2,
    scale: 1000,
    labels: 'both',
  },
};

type Rows = (string | number | boolean | null)[][];

describe('form and report definitions as Excel and CSV', () => {
  let h: Harness;
  let admin: Api;
  let base: string;

  const exportXlsx = async (query = '') => {
    const r = await admin.raw('GET', `${base}/definitions/export${query}`);
    expect(r.status).toBe(200);
    return Object.fromEntries(readXlsx(r.bytes).map((s) => [s.name, s.rows])) as Record<string, Rows>;
  };
  const importFile = async (name: string, data: Uint8Array | string, dryRun = false) => {
    const r = await admin.raw('POST', `${base}/definitions/import?name=${name}${dryRun ? '&dry_run=true' : ''}`, data, 'application/octet-stream');
    return { status: r.status, body: r.json };
  };
  const workbook = (defs: Rows, layout: Rows) => writeXlsx([
    { name: 'Definitions', rows: defs as never },
    { name: 'Layout', rows: layout as never },
  ]);

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Defs', null, 'admin@defs.test');
    admin = await signIn(h, 'admin@defs.test');
    base = `/v1/apps/${await seedPlanApp(admin)}`;
    expectOk(await admin.put(`${base}/dimensions/Product/members`, { members: [{ name: 'Smith, John', parent: 'All Products' }] }));
    expectOk(await admin.post(`${base}/deploy`));
    expectOk(await admin.put(`${base}/forms/Revenue Entry`, FORM));
    expectOk(await admin.put(`${base}/reports/Entity Revenue`, REPORT));
  });
  afterAll(async () => h?.close());

  it('splits and joins member selections', () => {
    expect(splitMembers('@leaves(Q1), Q1 , "Smith, John", @Children("A, B")')).toEqual(['@leaves(Q1)', 'Q1', 'Smith, John', '@Children(A, B)']);
    expect(joinMembers(['@leaves(Q1)', 'Smith, John', '"Quoted"'])).toBe('@leaves(Q1), "Smith, John", """Quoted"""');
    for (const list of [['a', 'b'], ['x, y', '@idescendants(Total, All)'], ['"quoted"'], ['(open']]) expect(splitMembers(joinMembers(list))).toEqual(list);
  });

  it('exports definitions and layout as flat sheets', async () => {
    const wb = await exportXlsx();
    expect(Object.keys(wb)).toEqual(['Definitions', 'Layout', 'Read Me']);
    expect(wb.Definitions![0]).toEqual(['Type', 'Name', 'Cube', 'Folder', 'Description', 'Read Only', 'Instructions', 'Title',
      'Suppress Missing Rows', 'Suppress Missing Columns', 'Decimals', 'Scale', 'Labels', 'Action']);
    expect(wb.Definitions![1]!.slice(0, 6)).toEqual(['Form', 'Revenue Entry', 'Plan', 'Revenue', '=SUM(A1) looks like a formula', 'No']);
    expect(wb.Definitions![2]!.slice(0, 3)).toEqual(['Report', 'Entity Revenue', 'Plan']);
    expect(wb.Definitions![2]!.slice(8, 13)).toEqual(['Yes', 'No', 2, 'Thousands', 'Both']);
    const layout = wb.Layout!.filter((r) => r[1] === 'Revenue Entry').map((r) => r.slice(2));
    expect(layout).toEqual([
      ['POV', 1, 'Scenario', 'Budget'], ['POV', 2, 'Version', 'Working'], ['POV', 3, 'Years', 'FY27'], ['POV', 4, 'Department', 'Sales'],
      ['Page', 1, 'Entity', '@leaves(Total Company)'], ['Page', 2, 'Product', 'Widgets, "Smith, John"'],
      ['Rows', 1, 'Account', '@idescendants(Gross Margin)'], ['Columns', 1, 'Period', '@leaves(Q1), Q1'],
    ]);
    expect(wb.Layout!.filter((r) => r[1] === 'Entity Revenue' && r[2] === 'Rows').map((r) => [r[3], r[4]])).toEqual([[1, 'Entity'], [2, 'Account']]);
  });

  it('re-imports an unchanged export as unchanged', async () => {
    const r = await admin.raw('GET', `${base}/definitions/export`);
    const res = await importFile('defs.xlsx', r.bytes, true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ dry_run: true, created: [], updated: [], deleted: [], errors: [] });
    expect(res.body.unchanged).toHaveLength(2);
  });

  it('previews then applies edits made in the workbook', async () => {
    const wb = await exportXlsx();
    const defs = wb.Definitions!;
    const layout = wb.Layout!.map((r) => [...r]);
    // Two dimensions on the form's rows; a new report; the old report's title changed.
    const formRows = layout.findIndex((r) => r[1] === 'Revenue Entry' && r[2] === 'Rows');
    layout.splice(formRows, 1,
      ['Form', 'Revenue Entry', 'Rows', 2, 'Account', 'Revenue, COGS'],
      ['Form', 'Revenue Entry', 'Rows', 1, 'Department', 'Sales'],
    );
    layout.splice(layout.findIndex((r) => r[1] === 'Revenue Entry' && r[4] === 'Department' && r[2] === 'POV'), 1);
    defs[2]![7] = 'Revenue by entity';
    defs.push(['Report', 'Opex Summary', 'Plan', 'Expenses', null, null, null, null, 'No', 'No', 0, 'Units', 'Name', null]);
    layout.push(
      ['Report', 'Opex Summary', 'POV', 1, 'Scenario', 'Budget'], ['Report', 'Opex Summary', 'POV', 2, 'Version', 'Working'],
      ['Report', 'Opex Summary', 'POV', 3, 'Years', 'FY27'], ['Report', 'Opex Summary', 'POV', 4, 'Entity', 'Total Company'],
      ['Report', 'Opex Summary', 'POV', 5, 'Product', 'All Products'], ['Report', 'Opex Summary', 'Page', 1, 'Department', '@ichildren(All Departments)'],
      ['Report', 'Opex Summary', 'Rows', 1, 'Account', 'Opex'], ['Report', 'Opex Summary', 'Columns', 1, 'Period', '@ichildren(YearTotal)'],
    );
    const file = workbook(defs, layout);
    const preview = await importFile('edited.xlsx', file, true);
    expect(preview.body).toMatchObject({
      created: [{ type: 'report', name: 'Opex Summary' }],
      updated: [{ type: 'form', name: 'Revenue Entry', version: 2 }, { type: 'report', name: 'Entity Revenue', version: 2 }],
      errors: [],
    });
    expect((expectOk(await admin.get(`${base}/forms/Revenue Entry`))).version).toBe(1);

    const applied = await importFile('edited.xlsx', file);
    expect(applied.status).toBe(200);
    const form = expectOk(await admin.get(`${base}/forms/Revenue Entry`));
    expect(form.version).toBe(2);
    expect(form.definition.rows).toEqual([{ dimension: 'Department', members: ['Sales'] }, { dimension: 'Account', members: ['Revenue', 'COGS'] }]);
    expect(form.definition.pov).toEqual({ Scenario: 'Budget', Version: 'Working', Years: 'FY27' });
    expect(form.description).toBe('=SUM(A1) looks like a formula');
    expect(expectOk(await admin.get(`${base}/reports/Entity Revenue`)).definition.title).toBe('Revenue by entity');
    const opex = expectOk(await admin.post(`${base}/reports/Opex Summary/run`, { page: { Department: 'Sales' } }));
    expect(opex.page.Department.options).toEqual(['All Departments', 'Sales', 'Operations']);
    const events = await superQuery(h, "select detail from epm.security_event where event_type = 'definitions_imported'");
    expect(events).toHaveLength(1);
  });

  it('round-trips through the CSV zip, guarding formula-like text', async () => {
    const r = await admin.raw('GET', `${base}/definitions/export?format=csv&type=form`);
    expect(r.headers.get('content-type')).toBe('application/zip');
    const files = unzipSync(r.bytes);
    expect(Object.keys(files).sort()).toEqual(['README.txt', 'definitions.csv', 'layout.csv']);
    const defsCsv = strFromU8(files['definitions.csv']!);
    expect(defsCsv).toContain(`'=SUM(A1) looks like a formula`);
    expect(defsCsv.split('\r\n').filter(Boolean)).toHaveLength(2); // header + the one form

    // Edit layout.csv alone, as someone would in Excel: Period columns become Q1 and Q2.
    // Read as Excel would show it (the formula guard off), edited, and written back.
    const layout = parseCsv(strFromU8(files['layout.csv']!)).rows.map((row) => row.map((c) => (c === null ? null : csvUnguard(String(c)))));
    const cols = layout.findIndex((row) => row[2] === 'Columns');
    layout[cols]![5] = 'Q1, Q2';
    const res = await importFile('layout.csv', writeCsv(layout));
    expect(res.body).toMatchObject({ updated: [{ type: 'form', name: 'Revenue Entry', version: 3 }], errors: [] });
    const form = expectOk(await admin.get(`${base}/forms/Revenue Entry`));
    expect(form.definition.columns).toEqual([{ dimension: 'Period', members: ['Q1', 'Q2'] }]);
    expect(form.description).toBe('=SUM(A1) looks like a formula');

    // The whole zip back in: nothing changes.
    const again = await admin.raw('GET', `${base}/definitions/export?format=csv`);
    const same = await importFile('defs.zip', again.bytes, true);
    expect(same.body.updated).toEqual([]);
    expect(same.body.errors).toEqual([]);
  });

  it('reports every problem with its sheet and row, and imports nothing', async () => {
    const defs: Rows = [
      ['Type', 'Name', 'Cube', 'Folder', 'Description', 'Read Only', 'Instructions', 'Title', 'Suppress Missing Rows', 'Suppress Missing Columns', 'Decimals', 'Scale', 'Labels', 'Action'],
      ['Form', 'New Form', 'Plan', null, null, 'Maybe', null, null, null, null, null, null, null, null],
      ['Report', 'Bad Report', 'Plan', null, null, null, null, null, null, null, 9, 'Billions', null, null],
      ['Widget', 'X', 'Plan', null, null, null, null, null, null, null, null, null, null, null],
      ['Report', 'Missing', null, null, null, null, null, null, null, null, null, null, null, 'Delete'],
    ];
    const layout: Rows = [
      ['Type', 'Name', 'Axis', 'Order', 'Dimension', 'Members'],
      ['Form', 'New Form', 'POV', 1, 'Scenario', 'Budget, Actual'],
      ['Form', 'New Form', 'Rows', 1, 'Account', 'Revenue'],
      ['Form', 'New Form', 'Sideways', 1, 'Period', 'Jan'],
      ['Report', 'Bad Report', 'Rows', 1, 'Nope', 'x'],
      ['Form', 'Revenue Entry', 'Rows', 1, 'Account', 'No Such Member'],
      ['Form', 'Revenue Entry', 'Columns', 1, 'Period', 'Q1'],
    ];
    const before = await superQuery(h, 'select count(*)::int as n from epm.artifact_version');
    const res = await importFile('bad.xlsx', workbook(defs, layout));
    expect(res.status).toBe(422);
    const errs = res.body.details.errors as { sheet: string; row: number; column?: string; message: string }[];
    const at = (sheet: string, row: number) => errs.filter((e) => e.sheet === sheet && e.row === row).map((e) => e.message).join(' | ');
    expect(at('Definitions', 2)).toMatch(/Read Only must be Yes or No/);
    expect(at('Definitions', 3)).toMatch(/Decimals/);
    expect(at('Definitions', 3)).toMatch(/Scale/);
    expect(at('Definitions', 4)).toMatch(/Type must be Form or Report/);
    expect(at('Definitions', 5)).toMatch(/does not exist, so it cannot be deleted/);
    expect(at('Layout', 2)).toMatch(/exactly one member/);
    expect(at('Layout', 4)).toMatch(/Axis must be/);
    expect(at('Layout', 5)).toMatch(/no dimension Nope/);
    expect(at('Layout', 6)).toMatch(/No Such Member/);
    expect(at('Definitions', 2)).toMatch(/nothing on Columns/);
    expect(await superQuery(h, 'select count(*)::int as n from epm.artifact_version')).toEqual(before);
  });

  it('deletes a definition marked Delete', async () => {
    const defs: Rows = [['Type', 'Name', 'Cube', 'Action'], ['Report', 'Opex Summary', null, 'delete']];
    const res = await importFile('delete.csv', writeCsv(defs as never));
    expect(res.body.deleted).toEqual([{ type: 'report', name: 'Opex Summary' }]);
    expect((await admin.get(`${base}/reports/Opex Summary`)).status).toBe(404);
  });

  it('keeps every saved version and brings one back, even after a delete', async () => {
    const hist = expectOk(await admin.get(`${base}/forms/Revenue Entry/history`)).history;
    expect(hist.map((v: { version: number; current: boolean }) => [v.version, v.current])).toEqual([[3, true], [2, false], [1, false]]);
    const first = hist[2];
    expect(first.definition.rows).toEqual([{ dimension: 'Account', members: ['@idescendants(Gross Margin)'] }]);

    expectOk(await admin.del(`${base}/forms/Revenue Entry`));
    const afterDelete = expectOk(await admin.get(`${base}/forms/Revenue Entry/history`)).history;
    expect(afterDelete[0]).toMatchObject({ version: 4, deleted: true });

    const back = expectOk(await admin.post(`${base}/forms/Revenue Entry/history/restore`, { artifact_id: first.artifact_id, version: 1 }));
    expect(back).toMatchObject({ name: 'Revenue Entry', version: 5, created: true });
    const form = expectOk(await admin.get(`${base}/forms/Revenue Entry`));
    expect(form.form_id).toBe(first.artifact_id);
    expect(form.definition.rows).toEqual([{ dimension: 'Account', members: ['@idescendants(Gross Margin)'] }]);
    const latest = expectOk(await admin.get(`${base}/forms/Revenue Entry/history`)).history;
    expect(latest[0]).toMatchObject({ version: 5, current: true, deleted: false, changed_by: 'admin@defs.test' });
  });

  it('needs power_user to export or import', async () => {
    expectOk(await admin.post('/v1/users', { email: 'pat@defs.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'pat@defs.test', role: 'planner' }));
    const pat = await signIn(h, 'pat@defs.test');
    expect((await pat.raw('GET', `${base}/definitions/export`)).status).toBe(403);
    expect((await pat.raw('POST', `${base}/definitions/import?name=x.csv`, 'Type,Name\n', 'text/csv')).status).toBe(403);
  });

  it('accepts the two CSV files as one multipart upload', async () => {
    const r = await admin.raw('GET', `${base}/definitions/export?format=csv`);
    const files = unzipSync(r.bytes);
    const form = new FormData();
    form.append('definitions', new Blob([files['definitions.csv']! as Uint8Array<ArrayBuffer>]), 'definitions.csv');
    form.append('layout', new Blob([files['layout.csv']! as Uint8Array<ArrayBuffer>]), 'layout.csv');
    const res = await admin.raw('POST', `${base}/definitions/import?dry_run=true`, form);
    expect(res.status).toBe(200);
    expect(res.json.errors).toEqual([]);
    expect(res.json.unchanged.length).toBe(2);
    void zipSync; void strToU8;
  });
});
