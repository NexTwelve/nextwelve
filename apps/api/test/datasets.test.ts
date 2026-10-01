import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLES_DIR } from '../scripts/sample.js';
import { parseAmount, parseCsv, readXlsx, toTable } from '../src/files/tables.js';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn } from './helpers.js';
import { writeXlsx } from './xlsx-writer.js';

describe('file readers', () => {
  it('reads a workbook written by Excel-compatible software (openpyxl)', () => {
    const sheets = readXlsx(new Uint8Array(readFileSync(join(SAMPLES_DIR, 'fernhollow', 'gl_crosswalk.xlsx'))));
    expect(sheets.map((s) => s.name)).toEqual(['GL Accounts', 'Cost Centers', 'Items']);
    const gl = toTable(sheets[0]!, 1);
    expect(gl.columns).toEqual(['GL Account', 'GL Description', 'Plan Account']);
    expect(gl.records[0]!.values).toEqual({ 'GL Account': 4000, 'GL Description': 'Product sales', 'Plan Account': 'Gross Sales' });
    expect(toTable(sheets[2]!, 1).records.find((r) => r.values.Item === 'ZAB-6')!.values.Product).toBe("Za'atar Blend");
  });

  it('parses quoted CSV fields, CRLF line ends and a byte-order mark', () => {
    const sheet = parseCsv('﻿Name,Note,Amount\r\n"Smith, J","said ""hi""\nthen left",12\r\nLee,,7\r\n');
    expect(sheet.rows).toEqual([['Name', 'Note', 'Amount'], ['Smith, J', 'said "hi"\nthen left', '12'], ['Lee', '', '7']]);
  });

  it('parses accounting-style amounts', () => {
    expect(['1,234.50', '(1,234.50)', '1234.50-', '$12', '-3', '', 'n/a'].map((v) => parseAmount(v))).toEqual([1234.5, -1234.5, -1234.5, 12, -3, null, NaN]);
  });

  it('names blank and duplicate headers predictably', () => {
    const t = toTable({ name: 'S', rows: [['Code', '', 'Code'], ['a', 'b', 'c']] }, 1);
    expect(t.columns).toEqual(['Code', 'B', 'Code (2)']);
  });
});

describe('datasets', () => {
  let h: Harness;
  let admin: Api;
  let base: string;

  const prices = (rows: [string, number][]) =>
    writeXlsx([{ name: 'Prices', rows: [['Product', 'Price', 'Currency'], ...rows.map(([p, v]) => [p, v, 'USD'])] }, { name: 'Read me', rows: [['FY27 price list']] }]);

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Datasets', null, 'admin@ds.test');
    admin = await signIn(h, 'admin@ds.test');
    base = `/v1/apps/${await seedPlanApp(admin)}`;
  });
  afterAll(async () => h?.close());

  it('publishes each upload as a new version with sheet summaries', async () => {
    const v1 = expectOk(await admin.upload(base, 'prices.xlsx', prices([['Widgets', 12.5], ['Gadgets', 30]]), 'dataset'), 201);
    expect(expectOk(await admin.put(`${base}/datasets/Price List`, { file_id: v1.file_id, description: 'FY27 list prices' }))).toEqual({
      name: 'Price List',
      version: 1,
      sheets: [{ name: 'Prices', columns: ['Product', 'Price', 'Currency'], rows: 2 }, { name: 'Read me', columns: ['FY27 price list'], rows: 0 }],
    });
    const v2 = expectOk(await admin.upload(base, 'prices.xlsx', prices([['Widgets', 13], ['Gadgets', 31], ['Gizmos', 8]]), 'dataset'), 201);
    expect(expectOk(await admin.put(`${base}/datasets/price list`, { file_id: v2.file_id })).version).toBe(2);

    const detail = expectOk(await admin.get(`${base}/datasets/Price List`));
    expect(detail.current_version).toBe(2);
    expect(detail.versions.map((v: any) => [v.version, v.file, v.uploaded_by])).toEqual([[2, 'prices.xlsx', 'admin@ds.test'], [1, 'prices.xlsx', 'admin@ds.test']]);
    const list = expectOk(await admin.get(`${base}/datasets`));
    expect(list.datasets).toEqual([expect.objectContaining({ name: 'Price List', description: 'FY27 list prices', current_version: 2 })]);
  });

  it('serves rows of any version, with simple column filters', async () => {
    const current = expectOk(await admin.get(`${base}/datasets/Price List/rows?sheet=Prices`));
    expect(current).toMatchObject({ version: 2, total: 3 });
    expect(current.rows.map((r: any) => r.data.Price)).toEqual([13, 31, 8]);
    const old = expectOk(await admin.get(`${base}/datasets/Price List/rows?version=1`));
    expect(old.rows.map((r: any) => r.data.Price)).toEqual([12.5, 30]);
    const one = expectOk(await admin.get(`${base}/datasets/Price List/rows?where.Product=Gizmos`));
    expect(one.rows).toEqual([{ row_no: 4, data: { Product: 'Gizmos', Price: 8, Currency: 'USD' } }]);
  });

  it('lets viewers read datasets but only power users publish them', async () => {
    for (const [email, role] of [['viv@ds.test', 'viewer'], ['pat@ds.test', 'planner']] as const) {
      expectOk(await admin.post('/v1/users', { email }), 201);
      expectOk(await admin.post(`${base}/roles`, { email, role }));
    }
    const viewer = await signIn(h, 'viv@ds.test');
    expectOk(await viewer.get(`${base}/datasets/Price List/rows`));
    const planner = await signIn(h, 'pat@ds.test');
    const f = expectOk(await admin.upload(base, 'p.xlsx', prices([['Widgets', 1]]), 'dataset'), 201);
    expect((await planner.put(`${base}/datasets/Price List`, { file_id: f.file_id })).status).toBe(403);
  });

  it('keeps datasets inside their tenant', async () => {
    await provisionTenant(h.db, 'Elsewhere', null, 'admin@else.test');
    const other = await signIn(h, 'admin@else.test');
    expect((await other.get(`${base}/datasets/Price List/rows`)).status).toBe(404);
    const res = await h.pool.query('select count(*)::int as n from epm.dataset_row');
    expect(res.rows[0].n).toBe(0); // no tenant in this session: RLS shows nothing
  });
});
