import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCsv } from '../../src/files/xlsx.js';
import { expectOk, superQuery } from '../helpers.js';
import {
  asTenant, BASIC_DEF, DEF_HEADER, type DefsEnv, defRow, defsEnv, exportDefs, importDefs, LAYOUT_HEADER, layoutFor, type Rows, sheets, stored, workbook,
} from './defs-helpers.js';

/**
 * Adversarial: what an import means. Delete vs layout rows, cube changes, case-insensitive names,
 * all-or-nothing writes, dry runs and the shape of the refusal.
 */
describe('definition import semantics', () => {
  let env: DefsEnv;
  type Err = { sheet: string; row: number | null; column?: string; definition?: string; message: string };
  const errorsOf = (body: any): Err[] => (body?.details?.errors ?? body?.errors ?? []) as Err[];
  const putForm = async (name: string, extra: Record<string, unknown> = {}, def: Record<string, unknown> = BASIC_DEF) =>
    expectOk(await env.admin.put(`${env.base}/forms/${name}`, { cube: 'Plan', ...extra, definition: def }));

  beforeAll(async () => {
    env = await defsEnv('Semantics');
    // A cube with the same eight dimensions, and one without Department and Product.
    const dims = ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account', 'Department', 'Product'];
    expectOk(await env.admin.post(`${env.base}/cubes`, { name: 'Plan Copy', dimensions: dims }), 201);
    expectOk(await env.admin.post(`${env.base}/cubes`, { name: 'Small', dimensions: dims.slice(0, 6) }), 201);
    await putForm('Keep Me', { folder: 'Folder A', description: 'Desc A' }, { ...BASIC_DEF, read_only: true, instructions: 'Instr A' });
  });
  afterAll(async () => env?.h.close());

  it('refuses Action=Delete together with Layout rows for the same definition, deleting nothing', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Keep Me', null, { Action: 'Delete' })];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Keep Me', BASIC_DEF)];
    const res = await importDefs(env.admin, env.base, 'del.xlsx', workbook(defs, layout));
    expect(res.status).toBe(422);
    expect(errorsOf(res.body)).toEqual([expect.objectContaining({ sheet: 'Definitions', row: 2, message: expect.stringMatching(/marked Delete but has Layout rows/) })]);
    expect((await env.admin.get(`${env.base}/forms/Keep Me`)).status).toBe(200);
  });

  it('refuses deleting a definition that does not exist, or of the other kind', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Ghost', null, { Action: 'delete' }), defRow('Report', 'Keep Me', null, { Action: 'DELETE' })];
    const res = await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(defs as never));
    expect(res.status).toBe(422);
    const errs = errorsOf(res.body);
    expect(errs.map((e) => e.row)).toEqual([2, 3]);
    expect((await env.admin.get(`${env.base}/forms/Keep Me`)).status).toBe(200);
  });

  it('a delete listed twice (Delete row and an update row for the same name) is refused', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Keep Me', null, { Action: 'Delete' }), defRow('Form', 'KEEP ME')];
    const res = await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(defs as never), true);
    expect(errorsOf(res.body)).toEqual([expect.objectContaining({ row: 3, column: 'Name', message: expect.stringMatching(/more than once/) })]);
  });

  it('a dry-run delete writes nothing; the real one writes a "deleted" history entry', async () => {
    await putForm('Doomed');
    const defs: Rows = [DEF_HEADER, defRow('Form', 'doomed', null, { Action: 'Delete' })];
    const before = await stored(env.h);
    const dry = await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(defs as never), true);
    expect(dry.body).toMatchObject({ dry_run: true, deleted: [{ type: 'form', name: 'Doomed' }], errors: [] });
    expect(await stored(env.h)).toEqual(before);
    const real = await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(defs as never));
    expect(real.body.deleted).toEqual([{ type: 'form', name: 'Doomed' }]);
    expect((await env.admin.get(`${env.base}/forms/Doomed`)).status).toBe(404);
    const hist = expectOk(await env.admin.get(`${env.base}/forms/Doomed/history`)).history;
    expect(hist[0]).toMatchObject({ deleted: true, version: 2, changed_by: 'admin@semantics.test' });
  });

  it('changing Cube while keeping the layout works when the new cube has the same dimensions', async () => {
    await putForm('Mover');
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Mover', 'plan copy', { 'Read Only': 'No' })];
    const res = await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(defs as never));
    expect(res.body).toMatchObject({ updated: [{ type: 'form', name: 'Mover', version: 2 }], errors: [] });
    const form = expectOk(await env.admin.get(`${env.base}/forms/Mover`));
    expect(form.cube).toBe('Plan Copy');
    expect(form.definition.rows).toEqual(BASIC_DEF.rows);
  });

  it('changing Cube to one that lacks placed dimensions is refused at the Definitions row', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Mover', 'Small')];
    const before = await stored(env.h);
    const res = await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(defs as never));
    expect(res.status).toBe(422);
    expect(errorsOf(res.body)).toEqual([expect.objectContaining({ sheet: 'definitions', row: 2, message: expect.stringMatching(/Department|Product/) })]);
    expect(await stored(env.h)).toEqual(before);
  });

  it('a Definitions row alone replaces settings but keeps the layout; Layout rows alone keep the settings', async () => {
    const onlyDefs: Rows = [DEF_HEADER, defRow('Form', 'Keep Me', null, { Folder: 'Folder B', Description: 'Desc A', Instructions: 'Instr A', 'Read Only': 'Yes' })];
    expectOk({ status: (await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(onlyDefs as never))).status, body: null });
    let form = expectOk(await env.admin.get(`${env.base}/forms/Keep Me`));
    expect(form).toMatchObject({ folder: 'Folder B', cube: 'Plan', definition: { read_only: true, instructions: 'Instr A', rows: BASIC_DEF.rows } });
    const onlyLayout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Keep Me', { ...BASIC_DEF, columns: [{ dimension: 'Period', members: ['Q1'] }] })];
    expectOk({ status: (await importDefs(env.admin, env.base, 'layout.csv', writeCsv(onlyLayout as never))).status, body: null });
    form = expectOk(await env.admin.get(`${env.base}/forms/Keep Me`));
    expect(form).toMatchObject({ folder: 'Folder B', description: 'Desc A', definition: { read_only: true, instructions: 'Instr A', columns: [{ dimension: 'Period', members: ['Q1'] }] } });
  });

  it('a name that differs only in case updates the existing definition and keeps its stored name', async () => {
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'KEEP me', BASIC_DEF)];
    const res = await importDefs(env.admin, env.base, 'layout.csv', writeCsv(layout as never));
    expect(res.body).toMatchObject({ created: [], updated: [{ type: 'form', name: 'Keep Me' }] });
    const names = expectOk(await env.admin.get(`${env.base}/forms`)).forms.map((f: { name: string }) => f.name);
    expect(names.filter((n: string) => n.toLowerCase() === 'keep me')).toEqual(['Keep Me']);
  });

  it('a form and a report may share a name; Type keeps them apart', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Report', 'Keep Me')];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Report', 'Keep Me', BASIC_DEF)];
    const res = await importDefs(env.admin, env.base, 'both.xlsx', workbook(defs, layout));
    expect(res.body).toMatchObject({ created: [{ type: 'report', name: 'Keep Me' }], updated: [], errors: [] });
    expect(expectOk(await env.admin.get(`${env.base}/forms/Keep Me`)).folder).toBe('Folder B');
  });

  it('one bad definition stops the whole file: nothing is written, the 422 carries the full result', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Good New'), defRow('Form', 'Bad New'), defRow('Form', 'Keep Me', null, { Description: 'would change' })];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Good New', BASIC_DEF), ...layoutFor('Form', 'Bad New', { ...BASIC_DEF, rows: [{ dimension: 'Account', members: ['Nope'] }] })];
    const before = await stored(env.h);
    const res = await importDefs(env.admin, env.base, 'mixed.xlsx', workbook(defs, layout));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: 'invalid_request',
      message: expect.stringMatching(/1 problem\(s\); nothing was imported/),
      details: { dry_run: false, created: [{ type: 'form', name: 'Good New' }], updated: [{ type: 'form', name: 'Keep Me' }], deleted: [], unchanged: [] },
    });
    const errs = errorsOf(res.body);
    expect(errs).toEqual([{ sheet: 'Layout', row: 16, column: 'Members', definition: 'Form Bad New', message: 'Account has no deployed member named Nope' }]);
    expect(await stored(env.h)).toEqual(before);
    expect((await env.admin.get(`${env.base}/forms/Good New`)).status).toBe(404);
  });

  it('a dry run with every kind of change writes nothing at all', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Brand New'), defRow('Form', 'Keep Me', null, { Description: 'dry' }), defRow('Form', 'Mover', null, { Action: 'Delete' })];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Brand New', BASIC_DEF)];
    const before = await stored(env.h);
    const events = await superQuery(env.h, 'select count(*)::int as n from epm.security_event');
    const res = await importDefs(env.admin, env.base, 'dry.xlsx', workbook(defs, layout), true);
    expect(res.body).toMatchObject({ dry_run: true, created: [{ name: 'Brand New' }], updated: [{ name: 'Keep Me' }], deleted: [{ name: 'Mover' }], errors: [] });
    expect(await stored(env.h)).toEqual(before);
    expect(await superQuery(env.h, 'select count(*)::int as n from epm.security_event')).toEqual(events);
  });

  it('FINDING: export ?name= misses names whose JavaScript and Postgres lower-casing differ (ΟΔΟΣ, İstanbul)', async () => {
    await putForm('ΟΔΟΣ Plan');
    await putForm('İstanbul Plan');
    for (const name of ['ΟΔΟΣ Plan', 'İstanbul Plan']) {
      const x = await exportDefs(env.admin, env.base, `?type=form&name=${name}`);
      expect(sheets(x.bytes).Definitions!.map((r) => r[1])).toEqual(['Name', name]);
    }
  });

  it('FINDING: a "new" definition whose name folds like an existing one (İ/i) is reported created but overwrites the existing one', async () => {
    await putForm('istanbul budget', { description: 'the original' });
    const defs: Rows = [DEF_HEADER, defRow('Form', 'İstanbul Budget', 'Plan', { Description: 'from the file' })];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'İstanbul Budget', BASIC_DEF)];
    const before = (await stored(env.h)).forms;
    const res = await importDefs(env.admin, env.base, 'tr.xlsx', workbook(defs, layout));
    const original = expectOk(await env.admin.get(`${env.base}/forms/istanbul budget`));
    const now = (await stored(env.h)).forms;
    // Either it is a new form (and the original is untouched) or it is reported as an update of the original.
    const honest = (res.body.created?.length === 1 && now === before + 1 && original.description === 'the original')
      || (res.body.updated?.length === 1 && res.body.created?.length === 0);
    expect({ created: res.body.created, updated: res.body.updated, formsAdded: now - before, original: original.description, honest })
      .toEqual({ created: expect.anything(), updated: expect.anything(), formsAdded: expect.anything(), original: expect.anything(), honest: true });
  });

  it('FINDING: duplicate Layout rows make the import resolve every member list again (cost grows rows x members, unbounded per definition)', async () => {
    // 40 extra rows placing Account again, each with 100 member functions: ~110 KB of CSV. Each row
    // is resolved (two queries per member) before "placed twice" is noticed; a 5 MB file holds ~1,800
    // such rows and keeps a database transaction busy for minutes.
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Keep Me', BASIC_DEF)];
    const members = Array.from({ length: 100 }, () => '@idescendants(Net Income)').join(', ');
    for (let i = 0; i < 40; i++) layout.push(['Form', 'Keep Me', 'Rows', i + 2, 'Account', members]);
    const csv = writeCsv(layout as never);
    expect(csv.length).toBeLessThan(120_000);
    const t = Date.now();
    const res = await importDefs(env.admin, env.base, 'layout.csv', csv, true);
    const ms = Date.now() - t;
    expect(errorsOf(res.body).length).toBeGreaterThan(0);
    expect(ms).toBeLessThan(1500);
  });

  it('FINDING: an application with more than 2,000 definitions exports a file its own import refuses', async () => {
    // Runs last: adds 2,001 forms (straight into the table, as many PUTs would).
    await asTenant(env.h, env.tenantId,
      `insert into epm.form (tenant_id, app_id, cube_id, name, definition)
       select $1, $2, cu.cube_id, 'Bulk ' || g, $3::jsonb from epm.cube cu, generate_series(1, 2001) g
        where cu.app_id = $2 and cu.name = 'Plan'`,
      [env.tenantId, env.appId, JSON.stringify({ ...BASIC_DEF, read_only: false })]);
    const x = await exportDefs(env.admin, env.base, '?type=form');
    expect(x.status).toBe(200);
    const res = await importDefs(env.admin, env.base, 'everything.xlsx', x.bytes, true);
    expect(res.status).toBe(200);
    expect(res.body.errors).toEqual([]);
  });
});
