import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCsv } from '../../src/files/xlsx.js';
import { expectOk } from '../helpers.js';
import { asTenant, BASIC_DEF, DEF_HEADER, type DefsEnv, defRow, defsEnv, exportDefs, importDefs, LAYOUT_HEADER, layoutFor, type Rows, stored, workbook } from './defs-helpers.js';

/**
 * Adversarial: definition history. Versions go up only on change, history is newest first,
 * numbering continues across deletes and restores, and restores cannot resurrect the wrong thing.
 */
type Entry = { artifact_id: string; version: number; deleted: boolean; current: boolean; name: string; description: string | null; definition: any };

describe('definition history and restore', () => {
  let env: DefsEnv;
  const hist = async (kind: 'forms' | 'reports', name: string): Promise<Entry[]> => expectOk(await env.admin.get(`${env.base}/${kind}/${name}/history`)).history;
  const restore = (kind: 'forms' | 'reports', name: string, artifact_id: string, version: number) => env.admin.post(`${env.base}/${kind}/${name}/history/restore`, { artifact_id, version });
  const put = async (kind: 'forms' | 'reports', name: string, body: Record<string, unknown>) => expectOk(await env.admin.put(`${env.base}/${kind}/${name}`, { cube: 'Plan', definition: BASIC_DEF, ...body }));

  beforeAll(async () => {
    env = await defsEnv('History');
  });
  afterAll(async () => env?.h.close());

  it('a save that changes nothing keeps the version, the timestamp and the history', async () => {
    const a = await put('forms', 'Steady', { description: 'x' });
    const first = expectOk(await env.admin.get(`${env.base}/forms/Steady`));
    const before = await stored(env.h);
    // The same definition, in the old single-axis shape and with defaults spelled out.
    const b = await put('forms', 'Steady', { description: 'x', definition: { ...BASIC_DEF, rows: BASIC_DEF.rows[0], columns: BASIC_DEF.columns[0], read_only: false } });
    expect([a.version, b.version]).toEqual([1, 1]);
    const again = expectOk(await env.admin.get(`${env.base}/forms/Steady`));
    expect(again).toEqual(first);
    // Re-importing its export, applied, also changes nothing.
    const x = await exportDefs(env.admin, env.base, '?name=Steady');
    expect((await importDefs(env.admin, env.base, 's.xlsx', x.bytes)).body.unchanged).toEqual([{ type: 'form', name: 'Steady' }]);
    expect((await stored(env.h)).versions).toBe(before.versions);
    expect((await hist('forms', 'Steady')).map((e) => e.version)).toEqual([1]);
  });

  it('lists history newest first with exactly one current entry', async () => {
    for (const d of ['one', 'two', 'three']) await put('reports', 'Changing', { description: d });
    const h = await hist('reports', 'Changing');
    expect(h.map((e) => [e.version, e.description, e.current])).toEqual([[3, 'three', true], [2, 'two', false], [1, 'one', false]]);
  });

  it('numbering continues across delete (by import) and restore, and later edits continue from there', async () => {
    await put('forms', 'Phoenix', { description: 'v1' });
    await put('forms', 'Phoenix', { description: 'v2' });
    const id = (await hist('forms', 'Phoenix'))[0]!.artifact_id;
    const del: Rows = [DEF_HEADER, defRow('Form', 'Phoenix', null, { Action: 'Delete' })];
    expect((await importDefs(env.admin, env.base, 'definitions.csv', writeCsv(del as never))).body.deleted).toHaveLength(1);
    expect((await hist('forms', 'Phoenix'))[0]).toMatchObject({ version: 3, deleted: true, current: false });
    expect(expectOk(await restore('forms', 'Phoenix', id, 1))).toEqual({ name: 'Phoenix', version: 4, created: true });
    await put('forms', 'Phoenix', { description: 'v5' });
    expectOk(await env.admin.del(`${env.base}/forms/Phoenix`));
    expect(expectOk(await restore('forms', 'Phoenix', id, 5))).toEqual({ name: 'Phoenix', version: 7, created: true });
    const h = await hist('forms', 'Phoenix');
    expect(h.map((e) => [e.version, e.deleted, e.current, e.description])).toEqual([
      [7, false, true, 'v5'], [6, true, false, 'v5'], [5, false, false, 'v5'], [4, false, false, 'v1'], [3, true, false, 'v2'], [2, false, false, 'v2'], [1, false, false, 'v1'],
    ]);
    const form = expectOk(await env.admin.get(`${env.base}/forms/Phoenix`));
    expect([form.form_id, form.version]).toEqual([id, 7]);
  });

  it('refuses to restore an entry that records a deletion, a version that never existed, or another artifact under this name', async () => {
    const h = await hist('forms', 'Phoenix');
    const deleted = h.find((e) => e.deleted)!;
    expect((await restore('forms', 'Phoenix', deleted.artifact_id, deleted.version)).status).toBe(422);
    expect((await restore('forms', 'Phoenix', deleted.artifact_id, 99)).status).toBe(404);
    const steady = (await hist('forms', 'Steady'))[0]!;
    expect((await restore('forms', 'Phoenix', steady.artifact_id, 1)).status).toBe(404);
    expect((await restore('reports', 'Phoenix', deleted.artifact_id, 1)).status).toBe(404);
  });

  it('restoring the current version is a no-op', async () => {
    const top = (await hist('forms', 'Phoenix'))[0]!;
    expect(expectOk(await restore('forms', 'Phoenix', top.artifact_id, top.version))).toEqual({ name: 'Phoenix', version: top.version, created: false });
    expect((await hist('forms', 'Phoenix'))[0]!.version).toBe(top.version);
  });

  it('restoring an old entry while a different definition now holds the name updates that one, keeping a single definition', async () => {
    await put('forms', 'Reused', { description: 'old A' });
    const a = (await hist('forms', 'Reused'))[0]!;
    expectOk(await env.admin.del(`${env.base}/forms/Reused`));
    await put('forms', 'REUSED', { description: 'new B' });
    const b = expectOk(await env.admin.get(`${env.base}/forms/Reused`));
    expect(b.form_id).not.toBe(a.artifact_id);
    const res = expectOk(await restore('forms', 'Reused', a.artifact_id, 1));
    expect(res).toEqual({ name: 'REUSED', version: 2, created: false });
    const now = expectOk(await env.admin.get(`${env.base}/forms/Reused`));
    expect([now.form_id, now.description, now.version]).toEqual([b.form_id, 'old A', 2]);
    const h = await hist('forms', 'Reused');
    expect(h.filter((e) => e.current)).toEqual([expect.objectContaining({ artifact_id: b.form_id, version: 2 })]);
    expect((await stored(env.h)).forms).toBe(expectOk(await env.admin.get(`${env.base}/forms`)).forms.length);
  });

  it('a restore re-validates against today\'s metadata (a placed dimension removed from the cube is refused)', async () => {
    await put('reports', 'Old Layout', { description: 'v1' });
    const v1 = (await hist('reports', 'Old Layout'))[0]!;
    // History rows are written by the database: tamper with v1's definition as only the owner could,
    // so it no longer places Product; the restore must notice rather than save an invalid report.
    await asTenant(env.h, env.tenantId, `update epm.report set description = 'v2' where name = 'Old Layout'`);
    const su = await asTenant(env.h, env.tenantId, `select definition from epm.artifact_version where artifact_id = $1 and version = 1`, [v1.artifact_id]);
    expect(su[0].definition.page.Product).toEqual(['Widgets', 'Gadgets']);
    const broken = { ...BASIC_DEF, page: {} };
    await asTenant(env.h, env.tenantId, `update epm.artifact_version set definition = $2 where artifact_id = $1 and version = 1`, [v1.artifact_id, JSON.stringify(broken)]);
    const res = await restore('reports', 'Old Layout', v1.artifact_id, 1);
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/does not place Product/);
    expect(expectOk(await env.admin.get(`${env.base}/reports/Old Layout`)).description).toBe('v2');
  });

  it('an import that changes three definitions writes exactly three history rows, all by the importer', async () => {
    for (const n of ['H1', 'H2', 'H3']) await put('forms', n, {});
    const before = (await stored(env.h)).versions;
    const defs: Rows = [DEF_HEADER, ...['H1', 'H2', 'H3', 'Steady'].map((n) => defRow('Form', n, 'Plan', { Description: n === 'Steady' ? 'x' : `changed ${n}`, 'Read Only': 'No' }))];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Form', 'Steady', BASIC_DEF)];
    const res = await importDefs(env.admin, env.base, 'h.xlsx', workbook(defs, layout));
    expect(res.body).toMatchObject({ updated: [{ name: 'H1', version: 2 }, { name: 'H2', version: 2 }, { name: 'H3', version: 2 }], unchanged: [{ name: 'Steady' }] });
    expect((await stored(env.h)).versions).toBe(before + 3);
    for (const n of ['H1', 'H2', 'H3']) expect((await hist('forms', n))[0]).toMatchObject({ version: 2, current: true, description: `changed ${n}` });
  });
});
