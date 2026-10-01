import { strFromU8, unzipSync } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCsv } from '../../src/files/xlsx.js';
import { Api, expectOk, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import {
  BASIC_DEF, DEF_HEADER, type DefsEnv, defRow, defsEnv, exportDefs, importDefs, LAYOUT_HEADER, layoutFor, type Rows, sheets, stored, userWithRole, workbook,
} from './defs-helpers.js';

/**
 * Adversarial: who may export, import and restore definitions, whether ids from one application
 * or tenant work through another's routes, and whether the files we hand out are safe to open.
 */
describe('definition export/import/history: authorization and output safety', () => {
  let env: DefsEnv;
  let viewer: Api;
  let planner: Api;
  let powerX: Api;
  let powerY: Api;
  let otherTenant: Api;
  let appY: string;
  let appB: string;
  const X = () => env.base;
  const Y = () => `/v1/apps/${appY}`;
  let formIdY: string;

  const validCsv = () => writeCsv([LAYOUT_HEADER, ...layoutFor('Form', 'Shared', BASIC_DEF)] as never);

  beforeAll(async () => {
    env = await defsEnv('Authz');
    appY = await seedPlanApp(env.admin, 'Plan Y');
    viewer = await userWithRole(env, 'vic@authz.test', 'viewer');
    planner = await userWithRole(env, 'pat@authz.test', 'planner');
    powerX = await userWithRole(env, 'pow@authz.test', 'power_user');
    powerY = await userWithRole(env, 'poy@authz.test', 'power_user', appY);
    await provisionTenant(env.h.db, 'Other', null, 'admin@other.test');
    otherTenant = await signIn(env.h, 'admin@other.test');
    appB = await seedPlanApp(otherTenant, 'Plan B');
    for (const base of [X(), Y(), `/v1/apps/${appB}`]) {
      const api = base.includes(appB) ? otherTenant : env.admin;
      expectOk(await api.put(`${base}/forms/Shared`, { cube: 'Plan', definition: BASIC_DEF }));
      expectOk(await api.put(`${base}/reports/Shared Report`, { cube: 'Plan', definition: BASIC_DEF }));
    }
    formIdY = expectOk(await env.admin.get(`${Y()}/forms/Shared`)).form_id;
  });
  afterAll(async () => env?.h.close());

  it('viewers and planners get 403 from export, import (any form of upload), history and restore', async () => {
    const before = await stored(env.h);
    const formId = expectOk(await env.admin.get(`${X()}/forms/Shared`)).form_id;
    for (const api of [viewer, planner]) {
      for (const q of ['', '?format=csv', '?type=report&name=Shared Report']) expect((await exportDefs(api, X(), q)).status).toBe(403);
      expect((await importDefs(api, X(), 'layout.csv', validCsv())).status).toBe(403);
      expect((await importDefs(api, X(), 'layout.csv', validCsv(), true)).status).toBe(403);
      expect((await importDefs(api, X(), 'junk.xlsx', new Uint8Array([1, 2, 3]))).status).toBe(403);
      const form = new FormData();
      form.append('f', new Blob([validCsv()]), 'layout.csv');
      expect((await api.raw('POST', `${X()}/definitions/import`, form)).status).toBe(403);
      for (const kind of ['forms', 'reports']) {
        const name = kind === 'forms' ? 'Shared' : 'Shared Report';
        expect((await api.get(`${X()}/${kind}/${name}/history`)).status).toBe(403);
        expect((await api.post(`${X()}/${kind}/${name}/history/restore`, { artifact_id: formId, version: 1 })).status).toBe(403);
      }
    }
    expect(await stored(env.h)).toEqual(before);
  });

  it('FINDING: a planner gets 422 instead of 403 when the upload or restore body is invalid (validated before the role check)', async () => {
    const empty = await planner.raw('POST', `${X()}/definitions/import?name=x.csv`, new Uint8Array(0), 'application/octet-stream');
    const noName = await planner.raw('POST', `${X()}/definitions/import`, validCsv(), 'text/csv');
    const badRestore = await planner.post(`${X()}/forms/Shared/history/restore`, { artifact_id: 'not-a-uuid', version: 0 });
    expect([empty.status, noName.status, badRestore.status]).toEqual([403, 403, 403]);
  });

  it('a power user of another application gets 403; another tenant gets 404', async () => {
    for (const [api, status] of [[powerY, 403], [otherTenant, 404]] as const) {
      expect((await exportDefs(api, X())).status).toBe(status);
      expect((await importDefs(api, X(), 'layout.csv', validCsv(), true)).status).toBe(status);
      expect((await api.get(`${X()}/forms/Shared/history`)).status).toBe(status);
      expect((await api.post(`${X()}/forms/Shared/history/restore`, { artifact_id: formIdY, version: 1 })).status).toBe(status);
    }
  });

  it("history and restore through app X never reach app Y's definitions (same name, same tenant)", async () => {
    // Y's form has a version 2 that X's does not.
    expectOk(await env.admin.put(`${Y()}/forms/Shared`, { cube: 'Plan', description: 'Y only', definition: BASIC_DEF }));
    const hx = expectOk(await powerX.get(`${X()}/forms/Shared/history`)).history;
    expect(hx.every((v: { artifact_id: string }) => v.artifact_id !== formIdY)).toBe(true);
    const res = await powerX.post(`${X()}/forms/Shared/history/restore`, { artifact_id: formIdY, version: 2 });
    expect(res.status).toBe(404);
    expect(expectOk(await env.admin.get(`${X()}/forms/Shared`)).description).toBeNull();
    // Nor through the other kind's route.
    expect((await powerX.post(`${Y()}/reports/Shared/history/restore`, { artifact_id: formIdY, version: 1 })).status).toBe(403);
    expect((await env.admin.post(`${Y()}/reports/Shared/history/restore`, { artifact_id: formIdY, version: 1 })).status).toBe(404);
  });

  it('the API database role can read history but cannot forge, edit or erase it', async () => {
    const c = new pg.Client({ connectionString: env.h.db.appUrl });
    await c.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true)", [env.tenantId]);
      const rows = await c.query('select count(*)::int as n from epm.artifact_version');
      expect(rows.rows[0].n).toBeGreaterThan(0);
      for (const sql of [
        `insert into epm.artifact_version (tenant_id, app_id, kind, artifact_id, version, name) values ('${env.tenantId}', '${env.appId}', 'form', gen_random_uuid(), 1, 'Forged')`,
        "update epm.artifact_version set name = 'Renamed'",
        'delete from epm.artifact_version',
      ]) {
        await c.query('savepoint s');
        await expect(c.query(sql)).rejects.toMatchObject({ code: '42501' });
        await c.query('rollback to savepoint s');
      }
      await c.query('rollback');
    } finally {
      await c.end();
    }
  });

  it('Content-Disposition cannot be broken by an application name with quotes, semicolons or newlines', async () => {
    const app = expectOk(await env.admin.post('/v1/apps', { name: 'Evil"; filename=x.exe\r\nX-Injected: 1 ünï' }), 201) as { app_id: string };
    for (const format of ['xlsx', 'csv']) {
      const r = await exportDefs(env.admin, `/v1/apps/${app.app_id}`, `?format=${format}`);
      expect(r.status).toBe(200);
      const cd = r.headers.get('content-disposition')!;
      expect(r.headers.get('x-injected')).toBeNull();
      expect(cd).not.toMatch(/[\r\n]/);
      const ascii = /filename="([^"]*)"/.exec(cd)![1]!;
      expect(ascii).toMatch(/^[\w.-]+$/);
      expect(cd.match(/filename=/g)).toHaveLength(1);
      expect(decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(cd)![1]!)).toMatch(/^Evil"; filename=x\.exe\r\nX-Injected: 1 ünï definitions \d{4}-\d{2}-\d{2}\.(xlsx|zip)$/);
    }
  });

  it('XML special characters and control characters in text give a well-formed workbook our reader reads back', async () => {
    // Control characters are refused when a definition is saved; XML's special characters are not.
    expect((await env.admin.put(`${X()}/forms/ctl`, { cube: 'Plan', description: 'bell \u0007', definition: BASIC_DEF })).status).toBe(422);
    const description = 'a <b> & "c" \'d\' ]]> ￾￿ tab\there';
    expectOk(await env.admin.put(`${X()}/forms/<script>&amp;`, { cube: 'Plan', folder: '&lt;', description, definition: { ...BASIC_DEF, instructions: '</t></is></c><c r="Z9"><v>1</v></c>' } }));
    const r = await exportDefs(env.admin, X(), '?type=form');
    expect(r.status).toBe(200);
    const parts = unzipSync(r.bytes);
    for (const [name, data] of Object.entries(parts)) {
      if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
      const xml = strFromU8(data);
      // eslint-disable-next-line no-control-regex
      expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/);
      const text = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<[^<>]+>/g, '');
      expect(text).not.toMatch(/[<>]/);
      expect(text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, '')).not.toContain('&');
    }
    const wb = sheets(r.bytes);
    const row = wb.Definitions!.find((r) => r[1] === '<script>&amp;')!;
    expect([...row.slice(0, 4), row[5], row[6]]).toEqual(['Form', '<script>&amp;', 'Plan', '&lt;', 'No', '</t></is></c><c r="Z9"><v>1</v></c>']);
    // (Whether the control characters survive is the subject of a round-trip finding; the rest must.)
    expect(String(row[4])).toMatch(/^a <b> & "c" 'd' \]\]> [\s\S]* tab\there$/);
  });

  it('CSV export guards formula-looking names, folders, descriptions and members; xlsx writes no formulas', async () => {
    expectOk(await env.admin.put(`${X()}/forms/=cmd|' -C calc'!A0`, { cube: 'Plan', folder: '+folder', description: '@SUM(1)', definition: { ...BASIC_DEF, instructions: '-2+3' } }));
    const r = await exportDefs(env.admin, X(), "?format=csv&type=form&name==cmd|' -C calc'!A0");
    const files = unzipSync(r.bytes);
    const lines = strFromU8(files['definitions.csv']!).split('\r\n');
    expect(lines[1]).toBe("Form,'=cmd|' -C calc'!A0,Plan,'+folder,'@SUM(1),No,'-2+3,,,,,,,");
    const x = await exportDefs(env.admin, X(), "?type=form&name==cmd|' -C calc'!A0");
    for (const [name, data] of Object.entries(unzipSync(x.bytes))) if (name.startsWith('xl/worksheets/')) expect(strFromU8(data)).not.toContain('<f>');
    // And both come back as the same definition.
    expect((await importDefs(env.admin, X(), 'x.zip', r.bytes, true)).body.unchanged).toEqual([{ type: 'form', name: "=cmd|' -C calc'!A0" }]);
    expect((await importDefs(env.admin, X(), 'x.xlsx', x.bytes, true)).body.unchanged).toEqual([{ type: 'form', name: "=cmd|' -C calc'!A0" }]);
  });

  it('a power user can import, and the import is recorded with who did it', async () => {
    const defs: Rows = [DEF_HEADER, defRow('Report', 'By Power User')];
    const layout: Rows = [LAYOUT_HEADER, ...layoutFor('Report', 'By Power User', BASIC_DEF)];
    const res = await importDefs(powerX, X(), 'p.xlsx', workbook(defs, layout));
    expect(res.body.created).toEqual([{ type: 'report', name: 'By Power User' }]);
    const hist = expectOk(await powerX.get(`${X()}/reports/By Power User/history`)).history;
    expect(hist).toEqual([expect.objectContaining({ version: 1, current: true, changed_by: 'pow@authz.test' })]);
  });
});
