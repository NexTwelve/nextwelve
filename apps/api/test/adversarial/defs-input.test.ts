import { deflateSync, strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCsv } from '../../src/files/xlsx.js';
import { expectOk } from '../helpers.js';
import {
  BASIC_DEF, csvZip, DEF_HEADER, type DefsEnv, defRow, defsEnv, exportDefs, importDefs, LAYOUT_HEADER, layoutFor, type Rows, stored, workbook,
} from './defs-helpers.js';

/**
 * Adversarial: malformed, oversized and oddly shaped definition files. Each must either import
 * correctly or be refused with errors that point at the right sheet and row, writing nothing.
 */

/** A zip built by hand, so entries can carry any declared sizes. Data must be raw DEFLATE. */
function rawZip(entries: { name: string; deflated: Uint8Array; declaredSize: number }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = strToU8(e.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, e.deflated.length, true);
    lv.setUint32(22, e.declaredSize, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, e.deflated.length, true);
    cv.setUint32(24, e.declaredSize, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    parts.push(local, e.deflated);
    central.push(cd);
    offset += local.length + e.deflated.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const all = [...parts, ...central, eocd];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

const BASE_SETTINGS = { cube: 'Plan', folder: 'Base Folder', description: 'Base description', definition: { ...BASIC_DEF, instructions: 'Base instructions' } };

describe('definition import: malformed and hostile files', () => {
  let env: DefsEnv;
  type Err = { sheet: string; row: number | null; column?: string; message: string };
  const errorsOf = (body: any): Err[] => (body?.details?.errors ?? body?.errors ?? []) as Err[];
  const at = (errs: Err[], sheet: string, row: number) => errs.filter((e) => e.sheet === sheet && e.row === row).map((e) => e.message).join(' | ');
  const multipart = async (files: { name: string; data: Uint8Array | string }[], dryRun = false) => {
    const form = new FormData();
    for (const f of files) form.append('file', new Blob([(typeof f.data === 'string' ? strToU8(f.data) : f.data) as Uint8Array<ArrayBuffer>]), f.name);
    const r = await env.admin.raw('POST', `${env.base}/definitions/import${dryRun ? '?dry_run=true' : ''}`, form);
    return { status: r.status, body: r.json };
  };

  beforeAll(async () => {
    env = await defsEnv('Input', ['Café', 'Ünïcødé']);
    expectOk(await env.admin.put(`${env.base}/forms/Base Form`, BASE_SETTINGS));
  });
  afterAll(async () => env?.h.close());

  it('refuses corrupt, empty and unsupported files with 4xx (never 500)', async () => {
    const junk = new Uint8Array(4096).map((_, i) => (i * 7919) % 251);
    for (const [name, data] of [['x.xlsx', junk], ['x.zip', junk], ['x.xls', junk], ['x.pdf', junk], ['x.xlsx', zipSync({ 'hello.txt': strToU8('hi') })], ['x.zip', zipSync({ 'notes.txt': strToU8('hi') })], ['x.csv', junk]] as const) {
      const r = await importDefs(env.admin, env.base, name, data);
      expect([413, 422]).toContain(r.status);
    }
    expect((await importDefs(env.admin, env.base, 'x.csv', '')).status).toBe(422);
    expect((await importDefs(env.admin, env.base, 'x.csv', '"unterminated,quote\n')).status).toBe(422);
  });

  it('refuses a zip whose entries declare more than 20 MB uncompressed (413)', async () => {
    const tiny = deflateSync(strToU8('Type,Name\n'));
    const zip = rawZip([{ name: 'definitions.csv', deflated: tiny, declaredSize: 30 * 1024 * 1024 }]);
    expect((await importDefs(env.admin, env.base, 'big.zip', zip)).status).toBe(413);
  });

  it('refuses an upload over 5 MB (413)', async () => {
    const big = `${LAYOUT_HEADER.join(',')}\n${'Form,X,Rows,1,Account,Revenue\n'.repeat(200_000)}`;
    expect((await importDefs(env.admin, env.base, 'big.csv', big)).status).toBe(413);
  });

  it('FINDING: a zip whose entries understate their size is still inflated in full (CPU zip bomb)', async () => {
    // 60 entries of 10 MB of zeros each, every one declaring 100 bytes: ~600 KB on the wire,
    // ~600 MB of inflating. The declared-size budget never trips; a 5 MB upload buys ~5 GB of work.
    const zeros = deflateSync(new Uint8Array(10 * 1024 * 1024), { level: 9 });
    const zip = rawZip(Array.from({ length: 60 }, (_, i) => ({ name: `part${i}.csv`, deflated: zeros, declaredSize: 100 })));
    expect(zip.length).toBeLessThan(1024 * 1024);
    const t = Date.now();
    const r = await importDefs(env.admin, env.base, 'bomb.zip', zip, true);
    const ms = Date.now() - t;
    expect([413, 422]).toContain(r.status);
    expect(ms).toBeLessThan(1000);
  });

  it('FINDING: an .xlsx whose workbook lists one worksheet part hundreds of times is parsed hundreds of times (30 KB upload, ~150 MB heap)', async () => {
    // workbook.xml may name the same r:id for every <sheet>; readXlsx parses and keeps a full copy
    // of the part for each. A 5 MB upload can list ~100,000 of them: far past a Worker's 128 MB.
    const rows: Rows = [DEF_HEADER, ...Array.from({ length: 2000 }, (_, i) => defRow('Form', `F${i}`))];
    const files = unzipSync(workbook(rows, null));
    const refs = Array.from({ length: 150 }, (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="rId1"/>`).join('');
    files['xl/workbook.xml'] = strToU8(strFromU8(files['xl/workbook.xml']!).replace(/<sheets>.*<\/sheets>/, `<sheets>${refs}</sheets>`));
    const file = zipSync(files, { level: 9 });
    expect(file.length).toBeLessThan(40_000);
    const t = Date.now();
    const res = await importDefs(env.admin, env.base, 'many.xlsx', file, true);
    const ms = Date.now() - t;
    expect([413, 422]).toContain(res.status);
    expect(ms).toBeLessThan(1000);
  });

  it('refuses two Definitions sheets or two Layout files', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Base Form')];
    const both = await multipart([{ name: 'a.csv', data: writeCsv(defs as never) }, { name: 'definitions.csv', data: writeCsv(defs as never) }], true);
    expect(both.status).toBe(422);
    expect(both.body.message).toMatch(/one Definitions sheet/);
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Base Form', BASIC_DEF)];
    const two = await multipart([{ name: 'l1.csv', data: writeCsv(layout as never) }, { name: 'l2.csv', data: writeCsv(layout as never) }], true);
    expect(two.status).toBe(422);
  });

  it('accepts three files (definitions, layout and the README) in one multipart upload', async () => {
    const x = await exportDefs(env.admin, env.base, '?format=csv');
    const files = unzipSync(x.bytes);
    const res = await multipart(Object.entries(files).map(([name, data]) => ({ name, data })), true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ errors: [], updated: [], created: [], unchanged: [{ type: 'form', name: 'Base Form' }] });
  });

  it('refuses a Layout sheet without a Members column, naming it', async () => {
    const layout: Rows = [['Type', 'Name', 'Axis', 'Order', 'Dimension'], ['Form', 'Base Form', 'Rows', 1, 'Account']];
    const res = await importDefs(env.admin, env.base, 'layout.csv', writeCsv(layout as never), true);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Members column/);
  });

  it('FINDING: a Definitions sheet that lacks the Folder, Description and Instructions columns wipes them', async () => {
    // Someone deletes the columns they do not care about (or uses an older template). A missing
    // column is not a blank cell: the settings should be kept, or the file refused.
    const defs: Rows = [['Type', 'Name', 'Cube', 'Read Only'], ['Form', 'Base Form', 'Plan', 'No']];
    const before = await stored(env.h);
    const res = await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(defs as never));
    const form = expectOk(await env.admin.get(`${env.base}/forms/Base Form`));
    const outcome = res.status === 422 ? 'refused' : form.folder === 'Base Folder' && form.description === 'Base description' && form.definition.instructions === 'Base instructions' ? 'kept' : 'wiped';
    // Put it back for the other tests.
    if (outcome === 'wiped') expectOk(await env.admin.put(`${env.base}/forms/Base Form`, BASE_SETTINGS));
    expect(outcome === 'refused' ? (await stored(env.h)).versions === before.versions : true).toBe(true);
    expect(outcome).not.toBe('wiped');
  });

  it('extra, unknown columns are ignored; a definitions header in any column order works', async () => {
    const defs: Rows = [['Notes', 'Cube', 'Name', 'Type', 'Folder', 'Description', 'Instructions', 'Read Only'], ['ignore me', 'Plan', 'Base Form', 'Form', 'Base Folder', 'Base description', 'Base instructions', 'No']];
    const res = await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(defs as never), true);
    expect(res.body).toMatchObject({ errors: [], unchanged: [{ type: 'form', name: 'Base Form' }] });
  });

  it('FINDING: a Definitions sheet with a title row above its header is silently ignored', async () => {
    const defs: Rows = [
      ['Definitions edited by Pat for the Q3 review'],
      DEF_HEADER,
      defRow('Form', 'Base Form', 'Plan', { Folder: 'Base Folder', Description: 'CHANGED description', Instructions: 'Base instructions', 'Read Only': 'No' }),
    ];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Base Form', BASIC_DEF)];
    const res = await importDefs(env.admin, env.base, 'edited.xlsx', workbook(defs, layout), true);
    // Either the edit is seen (updated) or the file is refused; "unchanged" silently drops it.
    const outcome = res.status === 422 || res.body.errors?.length ? 'refused' : res.body.updated?.length ? 'applied' : 'ignored';
    expect(outcome).not.toBe('ignored');
  });

  it('FINDING: a semicolon-delimited definitions.csv (Excel in many European locales) next to a valid layout.csv is silently skipped', async () => {
    // The Delete in definitions.csv never happens, yet the import reports success.
    expectOk(await env.admin.put(`${env.base}/forms/Delete Me`, { cube: 'Plan', definition: BASIC_DEF }));
    const defs = `${DEF_HEADER.join(';')}\r\nForm;Delete Me;;;;;;;;;;;;Delete\r\n`;
    const layout = writeCsv([LAYOUT_HEADER, ...layoutFor('Form', 'Base Form', BASIC_DEF)] as never);
    const res = await multipart([{ name: 'definitions.csv', data: defs }, { name: 'layout.csv', data: layout }], true);
    const outcome = res.status === 422 || res.body.errors?.length ? 'refused' : res.body.deleted?.length ? 'applied' : 'ignored';
    expect(outcome).not.toBe('ignored');
  });

  it('finds the header below blank rows and points errors at the real xlsx rows', async () => {
    const defs: Rows = [[], [], DEF_HEADER, [], defRow('Form', 'Bad Bool', 'Plan', { 'Read Only': 'Maybe' })];
    const layout: Rows = [LAYOUT_HEADER, [], [], ...layoutFor('Form', 'Bad Bool', BASIC_DEF)];
    layout[4] = ['Form', 'Bad Bool', 'POV', 'first', 'Version', 'Working'];
    const res = await importDefs(env.admin, env.base, 'blank.xlsx', workbook(defs, layout));
    expect(res.status).toBe(422);
    const errs = errorsOf(res.body);
    expect(at(errs, 'Definitions', 5)).toMatch(/Read Only must be Yes or No/);
    expect(errs.find((e) => e.sheet === 'Layout' && e.row === 5)).toMatchObject({ column: 'Order', message: 'Order must be a number' });
  });

  it('FINDING: a blank line in a CSV shifts the row numbers in error messages', async () => {
    const csv = `${DEF_HEADER.join(',')}\r\n,,,,,,,,,,,,,\r\nWidget,X,Plan,,,,,,,,,,,\r\n`;
    const res = await importDefs(env.admin, env.base, 'definitions.csv', csv, true);
    const errs = errorsOf(res.body);
    expect(errs).toHaveLength(1);
    // Excel and any text editor show the bad row as row 3.
    expect(errs[0]).toMatchObject({ sheet: 'definitions', row: 3, column: 'Type' });
  });

  it('FINDING: an empty self-closing <row/> (as other spreadsheet tools write) shifts xlsx error rows', async () => {
    const defs: Rows = [DEF_HEADER, [], defRow('Form', 'Base Form', 'Plan', { 'Read Only': 'Maybe' })];
    const files = unzipSync(workbook(defs, null));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<row r="2"></row>');
    files['xl/worksheets/sheet1.xml'] = strToU8(sheet.replace('<row r="2"></row>', '<row r="2" ht="24" customHeight="1"/>'));
    const res = await importDefs(env.admin, env.base, 'formatted.xlsx', zipSync(files), true);
    const errs = errorsOf(res.body);
    expect(errs.map((e) => [e.sheet, e.row, e.column])).toEqual([['Definitions', 3, 'Read Only']]);
  });

  it('reads CSV with a BOM and CRLF, LF or bare CR line endings alike', async () => {
    const x = await exportDefs(env.admin, env.base, '?format=csv&name=Base Form');
    const files = unzipSync(x.bytes);
    // The export starts with a UTF-8 byte-order mark (strFromU8 drops it when decoding).
    expect([...files['definitions.csv']!.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const defs = strFromU8(files['definitions.csv']!);
    const layout = strFromU8(files['layout.csv']!);
    for (const eol of ['\r\n', '\n', '\r']) {
      const res = await multipart([
        { name: 'definitions.csv', data: `${String.fromCharCode(0xfeff)}${defs.replace(/\r\n/g, eol)}` },
        { name: 'layout.csv', data: layout.replace(/^\uFEFF/, '').replace(/\r\n/g, eol) },
      ], true);
      expect(res.body).toMatchObject({ errors: [], updated: [], unchanged: [{ type: 'form', name: 'Base Form' }] });
    }
  });

  it('FINDING: a CSV saved in Windows-1252 ("CSV (Comma delimited)") silently creates a duplicate with a mangled name', async () => {
    expectOk(await env.admin.put(`${env.base}/forms/Café Plan`, { cube: 'Plan', definition: { ...BASIC_DEF, page: { Product: ['Café', 'Ünïcødé'] } } }));
    const x = await exportDefs(env.admin, env.base, '?format=csv&name=Café Plan');
    const files = unzipSync(x.bytes);
    const latin1 = (b: Uint8Array) => new Uint8Array(Buffer.from(strFromU8(b).replace(/^\uFEFF/, ''), 'latin1'));
    // Products Café and Ünïcødé would not resolve; keep the layout's members ASCII so only the name is mangled.
    const layoutText = strFromU8(files['layout.csv']!).replace('"Café, Ünïcødé"', 'Widgets').replace('Café, Ünïcødé', 'Widgets');
    const before = await stored(env.h);
    const res = await multipart([
      { name: 'definitions.csv', data: latin1(files['definitions.csv']!) },
      { name: 'layout.csv', data: new Uint8Array(Buffer.from(layoutText.replace(/^\uFEFF/, ''), 'latin1')) },
    ]);
    const forms = expectOk(await env.admin.get(`${env.base}/forms`)).forms.map((f: { name: string }) => f.name);
    expect(forms.filter((n: string) => n.includes('�'))).toEqual([]);
    expect((await stored(env.h)).forms).toBe(before.forms);
    void res;
  });

  it('reads cells Excel stores as booleans or numbers (TRUE, 2027, 2.0, "1") as their text', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Base Form', 'Plan', { Folder: 'Base Folder', Description: 'Base description', Instructions: 'Base instructions', 'Read Only': 'READONLY' })];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Base Form', BASIC_DEF).map((r) => [r[0], r[1], r[2], String(r[3]), r[4], r[5]])];
    const files = unzipSync(workbook(defs, layout));
    const sheet1 = strFromU8(files['xl/worksheets/sheet1.xml']!);
    // Excel turns a typed TRUE into a boolean cell.
    files['xl/worksheets/sheet1.xml'] = strToU8(sheet1.replace(/<c r="F2" t="inlineStr"><is><t>READONLY<\/t><\/is><\/c>/, '<c r="F2" t="b"><v>0</v></c>'));
    expect(strFromU8(files['xl/worksheets/sheet1.xml']!)).toContain('t="b"');
    const res = await importDefs(env.admin, env.base, 'excel.xlsx', zipSync(files), true);
    expect(res.body).toMatchObject({ errors: [], unchanged: [{ type: 'form', name: 'Base Form' }] });
    // A new form whose name Excel stored as a number.
    const files2 = unzipSync(workbook([DEF_HEADER, defRow('Form', 'NUMNAME')], [LAYOUT_HEADER, ...layoutFor('Form', 'NUMNAME', BASIC_DEF)]));
    for (const k of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']) {
      files2[k] = strToU8(strFromU8(files2[k]!).replace(/<c r="(B\d+)" t="inlineStr"><is><t>NUMNAME<\/t><\/is><\/c>/g, '<c r="$1"><v>2027</v></c>'));
    }
    const res2 = await importDefs(env.admin, env.base, 'excel2.xlsx', zipSync(files2), true);
    expect(res2.body).toMatchObject({ errors: [], created: [{ type: 'form', name: '2027' }] });
  });

  it('checks Order: text is an error at its row; negative and decimal orders sort', async () => {
    const def = { ...BASIC_DEF, pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East' } };
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Ordered', { ...def, rows: [] })];
    layout.push(['Form', 'Ordered', 'Rows', 2.5, 'Account', 'Revenue'], ['Form', 'Ordered', 'Rows', -1, 'Department', 'Sales']);
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Ordered')];
    const res = await importDefs(env.admin, env.base, 'ordered.xlsx', workbook(defs, layout));
    expect(res.status).toBe(200);
    expect(expectOk(await env.admin.get(`${env.base}/forms/Ordered`)).definition.rows.map((s: { dimension: string }) => s.dimension)).toEqual(['Department', 'Account']);
  });

  it('refuses bad placements with the row that has them, and writes nothing', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Four On Rows'), defRow('Form', 'Twice'), defRow('Form', 'Two POV'), defRow('Form', 'Empty Page'), defRow('Report', 'Dup'), defRow('report', 'DUP')];
    const layout: Rows = [
      LAYOUT_HEADER,
      // 2-9: four dimensions on rows
      ['Form', 'Four On Rows', 'POV', 1, 'Scenario', 'Budget'], ['Form', 'Four On Rows', 'POV', 2, 'Version', 'Working'], ['Form', 'Four On Rows', 'POV', 3, 'Years', 'FY27'],
      ['Form', 'Four On Rows', 'Rows', 1, 'Entity', 'East'], ['Form', 'Four On Rows', 'Rows', 2, 'Account', 'Revenue'], ['Form', 'Four On Rows', 'Rows', 3, 'Department', 'Sales'],
      ['Form', 'Four On Rows', 'Rows', 4, 'Product', 'Widgets'], ['Form', 'Four On Rows', 'Columns', 1, 'Period', 'Jan'],
      // 10-11: the same dimension on rows and on columns (different case)
      ['Form', 'Twice', 'Rows', 1, 'Account', 'Revenue'], ['Form', 'Twice', 'Columns', 1, 'account', 'COGS'],
      // 12: POV with two members
      ['Form', 'Two POV', 'POV', 1, 'Scenario', 'Budget, Actual'],
      // 13: a page with no members
      ['Form', 'Empty Page', 'Page', 1, 'Product', '  '],
    ];
    const before = await stored(env.h);
    const res = await importDefs(env.admin, env.base, 'bad.xlsx', workbook(defs, layout));
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ error: 'invalid_request', details: { dry_run: false, created: [], updated: [], deleted: [] } });
    const errs = errorsOf(res.body);
    expect(at(errs, 'Definitions', 2)).toMatch(/more than 3 dimensions on Rows/);
    expect(errs.find((e) => e.sheet === 'Layout' && e.row === 11)).toMatchObject({ column: 'Dimension', message: expect.stringMatching(/placed twice/) });
    expect(at(errs, 'Layout', 12)).toMatch(/exactly one member/);
    expect(errs.find((e) => e.sheet === 'Layout' && e.row === 13)).toMatchObject({ column: 'Members' });
    expect(errs.find((e) => e.sheet === 'Definitions' && e.row === 7)).toMatchObject({ column: 'Name', message: expect.stringMatching(/more than once/) });
    expect(await stored(env.h)).toEqual(before);
  });

  it('FINDING: a POV function that resolves to several members is reported on the Definitions row, not the Layout row that has it', async () => {
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Base Form', { ...BASIC_DEF, pov: { ...BASIC_DEF.pov, Entity: '@children(Total Company)' } })];
    const povRow = layout.findIndex((r) => r[2] === 'POV' && r[4] === 'Entity') + 1;
    const res = await importDefs(env.admin, env.base, 'layout.csv', writeCsv(layout as never), true);
    const errs = errorsOf(res.body);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatchObject({ sheet: 'layout', row: povRow, column: 'Members' });
  });

  it('refuses more than 100,000 layout rows or 5,000 definitions before touching the database', async () => {
    const rows = `${LAYOUT_HEADER.join(',')}\n${'Form,X,Rows,1,Account,Revenue\n'.repeat(100_001)}`;
    const t = Date.now();
    const r1 = await importDefs(env.admin, env.base, 'layout.csv', rows, true);
    expect(r1.status).toBe(422);
    expect(r1.body.message).toMatch(/100000 layout rows/);
    const defs = `${DEF_HEADER.join(',')}\n${Array.from({ length: 5001 }, (_, i) => `Form,F${i},Plan`).join('\n')}`;
    const r2 = await importDefs(env.admin, env.base, 'definitions.csv', defs, true);
    expect(r2.status).toBe(422);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('a .zip of the CSVs and an .xlsx with the same content give the same result', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Form', 'Base Form', 'Plan', { Folder: 'Base Folder', Description: 'Base description', Instructions: 'Base instructions', 'Read Only': 'No' })];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Base Form', BASIC_DEF)];
    const a = await importDefs(env.admin, env.base, 'same.zip', csvZip(defs, layout), true);
    const b = await importDefs(env.admin, env.base, 'same.xlsx', workbook(defs, layout), true);
    expect(a.body).toEqual(b.body);
    expect(a.body.unchanged).toEqual([{ type: 'form', name: 'Base Form' }]);
  });
});
