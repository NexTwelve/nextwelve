import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv, readXlsx } from '../../src/files/tables.js';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Report files: xlsx read back by our own reader, hostile member names and aliases (XML specials,
 * control characters, emoji, formula-looking text), sheet names and Content-Disposition.
 */
const SPECIALS = [
  { name: `R&D <Lab> "Q" 'x'`, alias: 'Research & <Dev> ' },
  { name: '=HYPERLINK("http://x.test","y")', alias: '-2+3' },
  { name: 'Emoji 😀 line', alias: '@SUM(A1)' },
  { name: 'Bell\u0007Name', alias: '\u0001=cmd' },
];
// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
/** Excel: at most 31 UTF-16 code units, none of []:*?/\, not starting or ending with an apostrophe. */
const EXCEL_SHEET_NAME = /^(?!')[^[\]:*?/\\]{1,31}(?<!')$/;
/** RFC 8187 ext-value: charset'lang'value-chars, where value-chars are attr-char or %XX. */
const EXT_VALUE = /filename\*=UTF-8''((?:%[0-9A-Fa-f]{2}|[A-Za-z0-9!#$&+.^_`|~-])+)$/;

describe('rpt: report files', () => {
  let h: Harness;
  let admin: Api;
  let base: string;

  /** A request with a path the caller has already encoded (Api encodes again and cannot send '?'). */
  async function send(method: 'PUT' | 'POST', path: string, body: unknown) {
    const res = await h.app.request(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  const simple = (title?: string) => ({
    cube: 'Plan',
    definition: {
      pov: { Version: 'Working', Years: 'FY27', Entity: 'East', Account: 'Revenue', Department: 'Sales', Product: 'Widgets' },
      rows: [{ dimension: 'Period', members: ['Jan'] }],
      columns: [{ dimension: 'Scenario', members: ['Budget'] }],
      ...(title ? { title } : {}),
    },
  });

  async function exportSheetName(name: string): Promise<string> {
    expectOk(await admin.put(`${base}/reports/${name}`, simple()));
    const x = await admin.raw('POST', `${base}/reports/${name}/run?format=xlsx`, '{}', 'application/json');
    expect(x.status).toBe(200);
    return readXlsx(x.bytes)[0]!.name;
  }

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Files', null, 'admin@files.test');
    admin = await signIn(h, 'admin@files.test');
    base = `/v1/apps/${await seedPlanApp(admin, 'Files')}`;
    expectOk(await admin.put(`${base}/dimensions/Product/members`, { members: SPECIALS.map((m) => ({ ...m, parent: 'All Products' })) }));
    expectOk(await admin.post(`${base}/deploy`));
    const g = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Account: 'Revenue', Department: 'Sales' },
      rows: [{ dimension: 'Product', members: SPECIALS.map((m) => m.name) }], columns: [{ dimension: 'Period', members: ['Jan', 'Feb'] }],
    }));
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[-1234.5, 0.000001], [123456.789, 42], [1, 2], [3, 4]] }));

    expectOk(await admin.put(`${base}/reports/Specials [Q1]: a*b`, {
      cube: 'Plan',
      definition: {
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Account: 'Revenue', Department: 'Sales' },
        rows: [{ dimension: 'Product', members: [...SPECIALS.map((m) => m.name), 'All Products'] }],
        columns: [{ dimension: 'Period', members: ['Jan', 'Feb', 'Q1'] }],
        labels: 'both',
        decimals: 6,
        title: 'Out <&> "T"',
      },
    }));
    expectOk(await admin.put(`${base}/reports/Alias Labels`, {
      cube: 'Plan',
      definition: {
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Account: 'Revenue', Department: 'Sales' },
        rows: [{ dimension: 'Product', members: SPECIALS.map((m) => m.name) }],
        columns: [{ dimension: 'Period', members: ['Jan'] }],
        labels: 'alias',
        title: '=1+1',
      },
    }));
  });
  afterAll(async () => h?.close());

  it('writes an xlsx our reader opens, with escaped labels, stripped control characters and the same numbers as JSON', async () => {
    const json = expectOk(await admin.post(`${base}/reports/Specials [Q1]: a*b/run`, {}));
    const x = await admin.raw('POST', `${base}/reports/Specials [Q1]: a*b/run?format=xlsx`, '{}', 'application/json');
    expect(x.status).toBe(200);
    const [sheet] = readXlsx(x.bytes);
    expect(sheet!.name).toMatch(EXCEL_SHEET_NAME);
    expect(sheet!.name).toBe('Specials  Q1   a b');
    expect(sheet!.rows[0]![0]).toBe('Out <&> "T"');
    const labels = [...SPECIALS.map((m) => clean(`${m.name} - ${m.alias}`)), 'All Products'];
    const body = sheet!.rows.filter((r) => labels.includes(r[0] as string));
    expect(body.map((r) => r[0])).toEqual(labels);
    expect(body.map((r) => r.slice(1))).toEqual(json.values);
    expect(json.values[0]).toEqual([-1234.5, 0.000001, -1234.499999]);
    // No formulas, ever.
    const xml = strFromU8(unzipSync(x.bytes)['xl/worksheets/sheet1.xml']!);
    expect(xml).not.toMatch(/<f[ >]/);
    expect(xml).toContain('xml:space="preserve"'); // the alias with a trailing space
  });

  it('guards CSV labels, aliases and titles that Excel would run as formulas', async () => {
    const both = await admin.raw('POST', `${base}/reports/Specials [Q1]: a*b/run?format=csv`, '{}', 'application/json');
    expect(both.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const rows = parseCsv(new TextDecoder().decode(both.bytes)).rows;
    expect(rows.map((r) => r[0])).toContain(`'=HYPERLINK("http://x.test","y") - -2+3`);
    expect(rows.map((r) => r[0])).toContain('BellName - =cmd');
    expect(rows.find((r) => r[0] === 'Emoji 😀 line - @SUM(A1)')!.slice(1)).toEqual(['1', '2', '3']);
    expect(rows.find((r) => String(r[0]).startsWith('R&D'))!.slice(1)).toEqual(['-1234.5', '0.000001', '-1234.499999']);

    const alias = await admin.raw('POST', `${base}/reports/Alias Labels/run?format=csv`, '{}', 'application/json');
    const arows = parseCsv(new TextDecoder().decode(alias.bytes)).rows;
    expect(arows[0]![0]).toBe("'=1+1");
    expect(arows.slice(-4).map((r) => r[0])).toEqual(['Research & <Dev> ', "'-2+3", "'@SUM(A1)", "'=cmd"]);
    const x = await admin.raw('POST', `${base}/reports/Alias Labels/run?format=xlsx`, '{}', 'application/json');
    const sheet = readXlsx(x.bytes)[0]!;
    expect(sheet.rows[0]![0]).toBe('=1+1'); // plain text in xlsx: no guard needed, no formula written
    expect(strFromU8(unzipSync(x.bytes)['xl/worksheets/sheet1.xml']!)).not.toMatch(/<f[ >]/);
  });

  it('keeps quotes and line breaks in a report name out of the Content-Disposition header', async () => {
    const name = 'Q1 "final"\r\nX-Injected: yes';
    const put = await send('PUT', `/reports/${encodeURIComponent(name)}`, simple());
    expect(put.status).toBe(200);
    for (const format of ['csv', 'xlsx']) {
      const x = await send('POST', `/reports/${encodeURIComponent(name)}/run?format=${format}`, {});
      expect(x.status).toBe(200);
      const cd = x.headers.get('content-disposition')!;
      expect(cd).not.toMatch(/[\r\n]/);
      expect(cd).toMatch(/^attachment; filename="[\w.-]+"; filename\*=UTF-8''/);
      expect(decodeURIComponent(cd.split("''")[1]!)).toMatch(/^Q1 "final"\r\nX-Injected: yes \d{4}-\d{2}-\d{2}\./);
      expect(x.headers.get('x-injected')).toBeNull();
    }
    // A name with '?' (only reachable percent-encoded) also exports.
    expect((await send('PUT', `/reports/${encodeURIComponent('Why? Plan')}`, simple())).status).toBe(200);
    const q = await send('POST', `/reports/${encodeURIComponent('Why? Plan')}/run?format=xlsx`, {});
    expect(readXlsx(q.bytes)[0]!.name).toBe('Why  Plan');
  });

  it("FINDING: Content-Disposition's filename* leaves ' ( ) * unencoded, which RFC 8187 parsers reject", async () => {
    // encodeURIComponent keeps ' ( ) * ! as is, but ' is the ext-value delimiter and ( ) * are not
    // attr-chars; strict parsers (e.g. the content-disposition npm package) throw, and browsers
    // that split on ' fall back to the mangled ASCII name "CFO_s_draft_...".
    const name = "CFO's (draft) *v2*";
    expectOk(await admin.put(`${base}/reports/${name}`, simple()));
    const x = await admin.raw('POST', `${base}/reports/${name}/run?format=csv`, '{}', 'application/json');
    expect(x.status).toBe(200);
    expect(x.headers.get('content-disposition')).toMatch(EXT_VALUE);
  });

  it('cleans sheet names: forbidden characters, more than 31 characters, XML specials and leading apostrophes', async () => {
    expect(await exportSheetName('A [b] c:d*e')).toBe('A  b  c d e');
    const long = await exportSheetName('Quarterly Gross Margin by Entity and Product');
    expect(long).toBe('Quarterly Gross Margin by Entit');
    expect(long).toMatch(EXCEL_SHEET_NAME);
    expect(await exportSheetName('R&D <Plan> "x"')).toBe('R&D <Plan> "x"');
    expect(await exportSheetName("'Quoted'")).toBe('Quoted');
    expect(await exportSheetName('***')).toBe('Sheet');
  });

  it('FINDING: cutting a sheet name to 31 characters can leave a trailing apostrophe, which Excel rejects', async () => {
    // Apostrophes are stripped from the ends before the cut, so character 31 can be one.
    const name = await exportSheetName(`${'A'.repeat(30)}'s plan`);
    expect(name).toMatch(EXCEL_SHEET_NAME);
  });

  it("FINDING: sheet names are cut to 31 code points, not Excel's 31 UTF-16 units, so emoji names are too long", async () => {
    // 20 emoji + ' plan' = 25 code points but 45 UTF-16 units; Excel counts the latter.
    const name = await exportSheetName(`${'📊'.repeat(20)} plan`);
    expect(name.length).toBeLessThanOrEqual(31);
  });
});
