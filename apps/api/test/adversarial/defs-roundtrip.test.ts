import { strFromU8, unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { joinMembers, splitMembers } from '../../src/definitions.js';
import { parseCsv } from '../../src/files/tables.js';
import { expectOk } from '../helpers.js';
import { asTenant, BASIC_DEF, type DefsEnv, defsEnv, exportDefs, importDefs, sheets, stored } from './defs-helpers.js';

/**
 * Adversarial: export -> import of an unchanged file must report nothing changed and write nothing,
 * whatever the names, members and settings look like.
 */
const TRICKY_PRODUCTS = ['Smith, John', '12" Pipe', 'Foo (old', 'Bar)', '=Weird', '-Adj', '@Home', 'Ünïcødé 📊', 'A "B" C', '(Paren) Co'];

describe('definitions export/import round trips', () => {
  let env: DefsEnv;
  const put = async (kind: 'forms' | 'reports', name: string, body: unknown) => expectOk(await env.admin.put(`${env.base}/${kind}/${name}`, body));
  /** Export (xlsx and csv zip), re-import each as a dry run; the named definitions must be unchanged. */
  const roundTrip = async (query: string) => {
    const out: { format: string; status: number; body: any }[] = [];
    for (const format of ['xlsx', 'csv']) {
      const r = await exportDefs(env.admin, env.base, `?format=${format}${query}`);
      expect(r.status).toBe(200);
      const res = await importDefs(env.admin, env.base, format === 'xlsx' ? 'defs.xlsx' : 'defs.zip', r.bytes, true);
      out.push({ format, ...res });
    }
    return out;
  };
  const expectUnchanged = (results: { format: string; status: number; body: any }[], n: number) => {
    for (const r of results) {
      expect({ format: r.format, status: r.status, errors: r.body?.errors, updated: r.body?.updated, created: r.body?.created })
        .toEqual({ format: r.format, status: 200, errors: [], updated: [], created: [] });
      expect(r.body.unchanged).toHaveLength(n);
    }
  };

  beforeAll(async () => {
    env = await defsEnv('Roundtrip', TRICKY_PRODUCTS);
  });
  afterAll(async () => env?.h.close());

  it('joinMembers/splitMembers: every single name survives on its own', () => {
    for (const m of TRICKY_PRODUCTS) expect(splitMembers(joinMembers([m]))).toEqual([m]);
    expect(splitMembers(joinMembers(['Smith, John', 'A "B" C', '(Paren) Co', '@idescendants(Total, All)']))).toEqual(['Smith, John', 'A "B" C', '(Paren) Co', '@idescendants(Total, All)']);
  });

  it('FINDING: joinMembers/splitMembers: a name with an unbalanced quote or parenthesis swallows the names after it', () => {
    // A product called 12" Pipe (inch mark) or "Foo (old" is valid; next to another member the
    // exported cell no longer splits back into the same list.
    expect(splitMembers(joinMembers(['12" Pipe', 'Gadgets']))).toEqual(['12" Pipe', 'Gadgets']);
    expect(splitMembers(joinMembers(['Foo (old', 'Gadgets']))).toEqual(['Foo (old', 'Gadgets']);
  });

  it('FINDING: a form whose page lists 12" Pipe and another product cannot be re-imported from its own export', async () => {
    await put('forms', 'Inch Marks', { cube: 'Plan', definition: { ...BASIC_DEF, page: { Product: ['12" Pipe', 'Widgets'] } } });
    const results = await roundTrip('&type=form&name=Inch Marks');
    expectUnchanged(results, 1);
  });

  it('FINDING: a form whose page lists "Foo (old" and another product cannot be re-imported from its own export', async () => {
    await put('forms', 'Open Paren', { cube: 'Plan', definition: { ...BASIC_DEF, page: { Product: ['Foo (old', 'Widgets'] } } });
    const results = await roundTrip('&type=form&name=Open Paren');
    expectUnchanged(results, 1);
  });

  it('member names with commas, quotes, balanced parentheses, a leading = - @ and emoji survive xlsx and csv', async () => {
    await put('forms', 'Tricky Members', {
      cube: 'Plan',
      definition: { ...BASIC_DEF, page: { Product: ['Smith, John', 'Bar)', '=Weird', '-Adj', '@Home', 'Ünïcødé 📊', 'A "B" C', '(Paren) Co', 'Widgets'] } },
    });
    await put('forms', 'POV With Comma', { cube: 'Plan', definition: { ...BASIC_DEF, pov: { ...BASIC_DEF.pov }, page: {}, rows: [{ dimension: 'Account', members: ['Revenue'] }, { dimension: 'Product', members: ['Smith, John', '=Weird'] }] } });
    await put('forms', 'POV Leading Dash', { cube: 'Plan', definition: { ...BASIC_DEF, page: {}, pov: { ...BASIC_DEF.pov, Product: '-Adj' } } });
    expectUnchanged(await roundTrip('&type=form&name=Tricky Members&name=POV With Comma&name=POV Leading Dash'), 3);
  });

  it('definition names with emoji, commas, quotes, parentheses and a leading = or - survive xlsx and csv', async () => {
    const names = ['Plan 📊 Ünïcødé', 'Smith, John Review', 'The "Big" One', '(Draft) Opex', '=SUM(A1)', '-Adjustments', '@risk', '+plus'];
    for (const name of names) await put('forms', name, { cube: 'Plan', definition: BASIC_DEF });
    const list = expectOk(await env.admin.get(`${env.base}/forms`)).forms.map((f: { name: string }) => f.name);
    for (const n of names) expect(list).toContain(n);
    // Other forms in this file may have their own problems: look only at these names.
    for (const format of ['xlsx', 'csv']) {
      const r = await exportDefs(env.admin, env.base, `?format=${format}&type=form`);
      const res = await importDefs(env.admin, env.base, format === 'xlsx' ? 'all.xlsx' : 'all.zip', r.bytes, true);
      expect(res.status).toBe(200);
      const unchanged = res.body.unchanged.map((u: { name: string }) => u.name);
      for (const n of names) expect(unchanged).toContain(n);
      expect(res.body.created.map((c: { name: string }) => c.name).filter((n: string) => names.includes(n))).toEqual([]);
      expect(res.body.updated.map((c: { name: string }) => c.name).filter((n: string) => names.includes(n))).toEqual([]);
    }
  });

  it('CSV export guards every formula-like text field and the import strips the guard again', async () => {
    await put('forms', 'Guarded', { cube: 'Plan', folder: '@folder', description: '+1 description', definition: { ...BASIC_DEF, instructions: '=HYPERLINK("http://x","y")', page: { Product: ['=Weird', '-Adj'] } } });
    const r = await exportDefs(env.admin, env.base, '?format=csv&type=form&name=Guarded');
    const files = unzipSync(r.bytes);
    const defs = parseCsv(strFromU8(files['definitions.csv']!)).rows;
    const layout = parseCsv(strFromU8(files['layout.csv']!)).rows;
    for (const row of [...defs, ...layout]) {
      for (const cell of row) expect(String(cell ?? '')).not.toMatch(/^[=+\-@\t\r]/);
    }
    expect(defs[1]).toContain("'=HYPERLINK(\"http://x\",\"y\")");
    expect(layout.find((l) => l[2] === 'Page')![5]).toBe("'=Weird, -Adj");
    const res = await importDefs(env.admin, env.base, 'guarded.zip', r.bytes, true);
    expect(res.body.unchanged).toEqual([{ type: 'form', name: 'Guarded' }]);
  });

  it('a form stored in the old single-axis shape (rows/columns as one object) re-imports as unchanged', async () => {
    await put('forms', 'Legacy Shape', { cube: 'Plan', definition: BASIC_DEF });
    await asTenant(env.h, env.tenantId,
      `update epm.form set definition = jsonb_set(jsonb_set(definition - 'read_only', '{rows}', definition->'rows'->0), '{columns}', definition->'columns'->0)
        where name = 'Legacy Shape'`);
    const before = await stored(env.h);
    const legacy = expectOk(await env.admin.get(`${env.base}/forms/Legacy Shape`));
    expect(Array.isArray(legacy.definition.rows)).toBe(false);
    expectUnchanged(await roundTrip('&type=form&name=Legacy Shape'), 1);
    // Applying (not a dry run) writes nothing either.
    const x = await exportDefs(env.admin, env.base, '?type=form&name=Legacy Shape');
    const applied = await importDefs(env.admin, env.base, 'legacy.xlsx', x.bytes);
    expect(applied.status).toBe(200);
    expect(applied.body.unchanged).toHaveLength(1);
    expect((await stored(env.h)).versions).toBe(before.versions);
  });

  it('a report saved with only the required fields (all defaults) re-imports as unchanged', async () => {
    await put('reports', 'Defaults Only', { cube: 'Plan', definition: { pov: BASIC_DEF.pov, rows: BASIC_DEF.rows, columns: BASIC_DEF.columns, page: BASIC_DEF.page } });
    await put('reports', 'All Options', {
      cube: 'Plan', folder: 'F', description: 'D',
      definition: { ...BASIC_DEF, title: '=Title', instructions: 'Read me', decimals: 6, scale: 1000000, labels: 'alias', suppress_missing_rows: false, suppress_missing_columns: true },
    });
    expectUnchanged(await roundTrip('&type=report'), 2);
  });

  it('FINDING: text settings are trimmed on import, so instructions ending in a newline come back "updated" and lose it', async () => {
    await put('forms', 'Trailing Newline', { cube: 'Plan', description: ' indented description', definition: { ...BASIC_DEF, instructions: 'Step 1: enter revenue.\nStep 2: submit.\n' } });
    const results = await roundTrip('&type=form&name=Trailing Newline');
    expectUnchanged(results, 1);
  });

  it('FINDING: a description saved as an empty string comes back "updated" (blank cell becomes null)', async () => {
    await put('forms', 'Empty Description', { cube: 'Plan', description: '', folder: '', definition: BASIC_DEF });
    expectUnchanged(await roundTrip('&type=form&name=Empty Description'), 1);
  });

  it("FINDING: a description that starts with an apostrophe and a dash loses the apostrophe on re-import", async () => {
    // "'-' marks a cell with no data" is ordinary prose; csvUnguard strips the apostrophe on import
    // (from xlsx too, where nothing was ever guarded), so the description is rewritten.
    await put('forms', 'Apostrophe', { cube: 'Plan', description: "'-' marks a cell with no data", definition: BASIC_DEF });
    expectUnchanged(await roundTrip('&type=form&name=Apostrophe'), 1);
  });

  it('FINDING: control characters in a description are silently dropped on export, so the re-import reports a change', async () => {
    // Fixed if PUT refuses such text, or if the round trip keeps it.
    const saved = await env.admin.put(`${env.base}/forms/Control Chars`, { cube: 'Plan', description: 'tab\tbell\u0007vt\u000bend', definition: BASIC_DEF });
    if (saved.status === 422) return;
    expect(saved.status).toBe(200);
    expectUnchanged(await roundTrip('&type=form&name=Control Chars'), 1);
  });

  it('FINDING: a form whose page offers more than 100 members (accepted by PUT) cannot be re-imported from its own export', async () => {
    // FormDefinition.page has no list limit; the import caps a Members cell at 100 selections.
    // (With thousands of members the cell would also pass Excel's 32,767-character cell limit.)
    const many = Array.from({ length: 120 }, (_, i) => `P${String(i).padStart(3, '0')}`);
    expectOk(await env.admin.put(`${env.base}/dimensions/Product/members`, { members: many.map((name) => ({ name, parent: 'All Products' })) }));
    expectOk(await env.admin.post(`${env.base}/deploy`));
    const saved = await env.admin.put(`${env.base}/forms/Big Page`, { cube: 'Plan', definition: { ...BASIC_DEF, page: { Product: many } } });
    if (saved.status === 422) return; // fixed by refusing it up front
    expect(saved.status).toBe(200);
    expectUnchanged(await roundTrip('&type=form&name=Big Page'), 1);
  });

  it('FINDING: a form whose name has leading/trailing spaces (accepted by PUT) is duplicated by re-importing its export', async () => {
    await put('forms', ' Padded Name ', { cube: 'Plan', definition: BASIC_DEF });
    const storedName = expectOk(await env.admin.get(`${env.base}/forms`)).forms.map((f: { name: string }) => f.name).find((n: string) => n.trim() === 'Padded Name');
    const before = (await stored(env.h)).forms;
    const x = await exportDefs(env.admin, env.base, `?type=form&name=${storedName}`);
    expect(sheets(x.bytes).Definitions).toHaveLength(2);
    const res = await importDefs(env.admin, env.base, 'padded.xlsx', x.bytes);
    expect(res.status).toBe(200);
    expect(res.body.created).toEqual([]);
    expect((await stored(env.h)).forms).toBe(before);
  });

  it('FINDING: a form named "Opex / Capex" (accepted by PUT) makes every export that includes it un-importable', async () => {
    const res0 = await env.h.app.request(`${env.base}/forms/Opex%20%2F%20Capex`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${env.admin.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ cube: 'Plan', definition: BASIC_DEF }),
    });
    if (res0.status === 422) return; // fixed by refusing the name up front
    expect(await res0.json()).toEqual({ name: 'Opex / Capex', version: 1 });
    const x = await exportDefs(env.admin, env.base, '?type=form&name=Opex / Capex');
    expect(sheets(x.bytes).Definitions![1]![1]).toBe('Opex / Capex');
    const res = await importDefs(env.admin, env.base, 'slash.xlsx', x.bytes, true);
    try {
      expect(res.body.errors).toEqual([]);
      expect(res.body.unchanged).toEqual([{ type: 'form', name: 'Opex / Capex' }]);
    } finally {
      await env.h.app.request(`${env.base}/forms/Opex%20%2F%20Capex`, { method: 'DELETE', headers: { authorization: `Bearer ${env.admin.token}` } });
    }
  });

  it('FINDING: a form name longer than 200 characters (accepted by PUT) makes every full export un-importable', async () => {
    const long = `Long ${'x'.repeat(200)}`;
    const saved = await env.admin.put(`${env.base}/forms/${long}`, { cube: 'Plan', definition: BASIC_DEF });
    if (saved.status === 422) return; // fixed by refusing the name up front
    expect(saved.status).toBe(200);
    const x = await exportDefs(env.admin, env.base, `?type=form&name=${long}`);
    expect(sheets(x.bytes).Definitions).toHaveLength(2);
    const res = await importDefs(env.admin, env.base, 'long.xlsx', x.bytes, true);
    try {
      expect(res.body.errors).toEqual([]);
    } finally {
      expectOk(await env.admin.del(`${env.base}/forms/${long}`));
    }
  });
});
