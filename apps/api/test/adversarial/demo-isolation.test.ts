import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import {
  ADMIN, buildTemplate, createDemoHarness, type DemoHarness, FORM, forgeToken, IMPORT_FORMAT, MAPPINGS, PLANNER, startDemo, startOk, su, VIEWER,
} from './demo-helpers.js';

/**
 * Isolation of public demo copies: from each other, from real tenants, and from tokens that were
 * altered, forged, ended or belong to a real tenant.
 */
describe('adversarial demo: isolation and tokens', () => {
  let h: DemoHarness;
  let realAdmin: Api;
  let realTenant: string;
  let realApp: string;
  let realUserId: string;
  let a: Awaited<ReturnType<typeof startOk>>;
  let b: Awaited<ReturnType<typeof startOk>>;
  let snapB: string;
  let txnB: number;
  let fileB: string;
  let realSnap: string;
  let templateSnap: string;

  const read = (api: Api, appId: string, entity = 'East') => api.post(`/v1/apps/${appId}/grid/read`, {
    cube: 'Plan', pov: { ...PLAN_POV, Entity: entity }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] },
  });
  const write = async (api: Api, appId: string, value: number, entity = 'East') => {
    const g = expectOk(await read(api, appId, entity));
    return api.post(`/v1/apps/${appId}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[value]] });
  };

  beforeAll(async () => {
    h = await createDemoHarness();
    realTenant = await provisionTenant(h.db, 'Real Co', null, 'cfo@real.test');
    realAdmin = await signIn(h, 'cfo@real.test');
    realApp = await seedPlanApp(realAdmin, 'Real Plan');
    realUserId = expectOk(await realAdmin.get('/v1/me')).user_id;
    expectOk(await write(realAdmin, realApp, 777));
    realSnap = expectOk(await realAdmin.post(`/v1/apps/${realApp}/snapshots`, {}), 201).snapshot_id;
    templateSnap = (await buildTemplate(h)).snapshotId;
    a = await startOk(h, '203.0.113.1');
    b = await startOk(h, '203.0.113.2');
    expectOk(await write(b.api, b.appId, 5));
    snapB = expectOk(await b.api.post(`/v1/apps/${b.appId}/snapshots`, {}), 201).snapshot_id;
    txnB = expectOk(await b.api.get(`/v1/apps/${b.appId}/txns`)).txns[0].txn_id;
    fileB = expectOk(await b.api.upload(`/v1/apps/${b.appId}`, 'gl.csv', 'Company,Month,Account,Amount\nE01,Jan,Revenue,1\n'), 201).file_id;
  }, 40_000);
  afterAll(async () => h?.close());

  it('a copy has the template: data, report, form, import format and mappings, roles and grants', async () => {
    const base = `/v1/apps/${a.appId}`;
    expect(expectOk(await a.api.post(`${base}/reports/Margin/run`, {})).values).toEqual([[100, 110], [40, 44]]);
    const form = expectOk(await a.api.get(`${base}/forms/Revenue Entry`));
    expect(form).toMatchObject({ name: 'Revenue Entry', folder: FORM.folder, cube: 'Plan' });
    expect(expectOk(await a.api.get(`${base}/import-formats/GL`))).toMatchObject({ name: 'GL' });
    expect(expectOk(await a.api.get(`${base}/import-formats/GL/mappings`)).rules.map((r: { source: string }) => r.source).sort())
      .toEqual(MAPPINGS.map((m) => m.source).sort());
    expect(IMPORT_FORMAT.cube).toBe('Plan');
    const grants = expectOk(await a.api.get(`${base}/grants`)).grants;
    expect(grants).toEqual(expect.arrayContaining([
      expect.objectContaining({ principal: PLANNER.email, member: 'East', access: 'write' }),
      expect.objectContaining({ principal: VIEWER.email, member: 'Total Company', access: 'read' }),
    ]));
    const users = expectOk(await a.api.get('/v1/users')).users.map((u: { email: string }) => u.email).sort();
    expect(users).toEqual([ADMIN.email, PLANNER.email, VIEWER.email].sort());
    expect(expectOk(await a.api.get('/v1/apps')).apps).toHaveLength(1);
    const me = expectOk(await a.api.get('/v1/me'));
    expect(me.demo).toMatchObject({ persona: 'admin', expires_at: expect.any(String) });
    expect(new Date(me.demo.expires_at).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    expect(expectOk(await realAdmin.get('/v1/me')).demo).toBeNull();
  });

  it('personas see what their grants allow, in their own copy only', async () => {
    const planner = new Api(h.app, expectOk(await a.api.post('/v1/demo/persona', { persona: 'planner' })).session_token);
    const viewer = new Api(h.app, expectOk(await a.api.post('/v1/demo/persona', { persona: 'viewer' })).session_token);
    expect(expectOk(await read(planner, a.appId, 'East')).writable).toEqual([[true]]);
    expect((await read(planner, a.appId, 'West')).status).toBe(403);
    expect((await write(viewer, a.appId, 1)).status).toBe(403);
    expect((await planner.put(`/v1/apps/${a.appId}/grants`, { grants: [] })).status).toBe(403);
    expect((await viewer.post(`/v1/apps/${a.appId}/snapshots`, {})).status).toBe(403);
    // A persona of copy A has no business in copy B or the real tenant.
    expect((await read(planner, b.appId)).status).toBe(404);
    expect((await read(viewer, realApp)).status).toBe(404);
    expect(expectOk(await planner.get('/v1/me')).demo.persona).toBe('planner');
  });

  it('ids of another copy or of a real tenant lead nowhere, on every route that takes one', async () => {
    for (const [other, snap] of [[b.appId, snapB], [realApp, realSnap]] as const) {
      const base = `/v1/apps/${other}`;
      const gets = [
        `${base}/forms`, `${base}/reports`, `${base}/dimensions`, `${base}/dimensions/Entity/members`, `${base}/grants`,
        `${base}/snapshots`, `${base}/snapshots/${snap}`, `${base}/snapshots/${snap}/files/manifest.json`, `${base}/metadata/history`,
        `${base}/txns`, `${base}/files`, `${base}/imports`, `${base}/datasets`, `${base}/import-formats`, `${base}/forms/Revenue Entry/history`,
      ];
      for (const url of gets) expect((await a.api.get(url)).status, url).toBe(404);
      const posts = [
        await a.api.post(`${base}/history`, { cube: 'Plan', cell: { ...PLAN_POV, Account: 'Revenue', Period: 'Jan' } }),
        await a.api.post(`${base}/drill`, { cube: 'Plan', cell: { ...PLAN_POV, Account: 'Revenue', Period: 'Jan' } }),
        await a.api.post(`${base}/audit/verify`, {}),
        await a.api.post(`${base}/deploy`, {}),
        await a.api.post(`${base}/snapshots`, {}),
        await a.api.put(`${base}/grants`, { grants: [] }),
        await a.api.post(`${base}/restore`, { at: new Date().toISOString(), scenarios: ['Budget'] }),
        await a.api.post(`${base}/metadata/restore`, { snapshot_id: snap, dry_run: true }),
        await a.api.post(`${base}/snapshots/${snap}/restore`, { target: 'in_place', dry_run: true }),
        await a.api.put(`${base}/reports/Margin`, { cube: 'Plan', definition: {} }),
        await a.api.del(`${base}/forms/Revenue Entry`),
        await a.api.put(`${base}/dimensions/Entity/members`, { members: [{ name: 'Planted', parent: 'Total Company' }] }),
        await a.api.post(`${base}/dimensions`, { name: 'Planted', type: 'custom' }),
        await a.api.patch(`${base}/dimensions/Entity`, { secured: false }),
        await a.api.post(`${base}/cubes`, { name: 'Planted', dimensions: ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account'] }),
        await a.api.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', locked: true }),
        await a.api.put(`${base}/import-formats/GL/mappings`, { rules: [] }),
        await a.api.post(`${base}/import-formats/GL/run`, { file_id: fileB }),
        await a.api.post(`${base}/txns/${txnB}/undo`, { force: true }),
        await read(a.api, other),
      ];
      for (const r of posts) expect([403, 404, 422], JSON.stringify(r.body)).toContain(r.status);
      expect((await su(h, "select count(*)::int as n from epm.member where name = 'Planted'"))[0].n).toBe(0);
    }
    // Another copy's snapshot, transaction or file used against one's own application.
    expect((await a.api.get(`/v1/apps/${a.appId}/snapshots/${templateSnap}`)).status).toBe(404);
    expect((await a.api.post(`/v1/apps/${a.appId}/metadata/restore`, { snapshot_id: templateSnap, dry_run: true })).status).toBe(404);
    const own = `/v1/apps/${a.appId}`;
    expect((await a.api.post(`${own}/snapshots/${snapB}/restore`, { target: 'in_place', dry_run: true })).status).toBe(404);
    expect((await a.api.post(`${own}/snapshots/${realSnap}/restore`, { target: 'in_place' })).status).toBe(404);
    expect((await a.api.post(`${own}/metadata/restore`, { snapshot_id: snapB })).status).toBe(404);
    expect((await a.api.get(`${own}/snapshots/${snapB}/files/metadata.json.gz`)).status).toBe(404);
    expect((await a.api.post(`${own}/txns/${txnB}/undo`, {})).status).toBe(404);
    expect((await a.api.post(`${own}/import-formats/GL/run`, { file_id: fileB, dry_run: true })).status).toBe(404);
    expect((await a.api.put(`${own}/datasets/Stolen`, { file_id: fileB })).status).toBe(404);
    // Nothing moved in B or the real tenant.
    expect(expectOk(await read(b.api, b.appId)).values).toEqual([[5]]);
    expect(expectOk(await read(realAdmin, realApp)).values).toEqual([[777]]);
  });

  it('the guard cannot be sidestepped with other spellings of a blocked path', async () => {
    const raw = (method: string, path: string, body?: unknown) => h.app.request(path, {
      method, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const attempts: [string, string, unknown?][] = [
      ['POST', '/v1/apps', { name: 'Second' }],
      ['POST', '/v1/apps/', { name: 'Second' }],
      ['POST', '/v1/%61pps', { name: 'Second' }],
      ['POST', '/v1/users', { email: 'friend@example.com' }],
      ['POST', '/v1/%75sers', { email: 'friend@example.com' }],
      ['POST', '/v1/users/', { email: 'friend@example.com' }],
      ['PATCH', `/v1/users/${encodeURIComponent(PLANNER.email)}`, { status: 'disabled' }],
      ['POST', '/v1/groups', { name: 'G' }],
      ['PUT', '/v1/groups/G/members', { emails: [PLANNER.email] }],
      ['POST', `/v1/apps/${a.appId}/roles`, { email: VIEWER.email, role: 'app_admin' }],
      ['POST', `/v1/apps/${a.appId}/rol%65s`, { email: VIEWER.email, role: 'app_admin' }],
      ['POST', `/v1/apps/${a.appId}/roles/`, { email: VIEWER.email, role: 'app_admin' }],
      ['DELETE', `/v1/apps/${a.appId}/roles/${encodeURIComponent(PLANNER.email)}`],
    ];
    for (const [method, path, body] of attempts) {
      const r = await raw(method, path, body);
      expect([403, 404], `${method} ${path}`).toContain(r.status);
    }
    expect(expectOk(await a.api.get('/v1/apps')).apps).toHaveLength(1);
    expect(expectOk(await a.api.get('/v1/users')).users).toHaveLength(3);
    // Grants and in-place work stay possible, but cannot name people outside the copy.
    const g = await a.api.put(`/v1/apps/${a.appId}/grants`, { grants: [{ principal: { user: 'cfo@real.test' }, dimension: 'Entity', member: 'East', access: 'write' }] });
    expect(g.status).toBe(404);
    const snap = expectOk(await a.api.post(`/v1/apps/${a.appId}/snapshots`, {}), 201);
    expect((await a.api.post(`/v1/apps/${a.appId}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Copy' })).status).toBe(403);
    expect((await su(h, 'select count(*)::int as n from epm.application where tenant_id = $1', [a.tenantId]))[0].n).toBe(1);
  });

  it('altered, forged and cross-tenant tokens are refused', async () => {
    const [hdr, payload, sig] = a.token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const swapped = Buffer.from(JSON.stringify({ ...claims, tid: b.tenantId })).toString('base64url');
    expect((await new Api(h.app, `${hdr}.${swapped}.${sig}`).get('/v1/apps')).status).toBe(401);
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`;
    expect((await new Api(h.app, none).get('/v1/apps')).status).toBe(401);
    // Validly signed but naming a user of another tenant: the database refuses it.
    const crossed = await forgeToken(h, { tid: a.tenantId, demo: true }, realUserId);
    expect((await new Api(h.app, crossed).get('/v1/apps')).status).toBe(401);
    expect((await new Api(h.app, crossed).post('/v1/demo/persona', { persona: 'admin' })).status).toBe(401);
  });

  it('even a demo claim on a real tenant cannot end, purge or switch into it', async () => {
    const forged = await forgeToken(h, { tid: realTenant, demo: true }, realUserId);
    const api = new Api(h.app, forged);
    expect((await api.del('/v1/demo/session')).status).toBe(403);
    expect((await api.post('/v1/demo/persona', { persona: 'admin' })).status).toBe(404);
    const again = await startDemo(h, '203.0.113.3', { token: forged });
    expect(again.status).toBe(201);
    expect(expectOk(await read(realAdmin, realApp)).values).toEqual([[777]]);
    expect((await su(h, 'select demo_expires_at from epm.tenant where tenant_id = $1', [realTenant]))[0].demo_expires_at).toBeNull();
  });

  it('a real session in Authorization does not end the real tenant when a demo starts', async () => {
    const r = await startDemo(h, '203.0.113.4', { token: realAdmin.token! });
    expect(r.status).toBe(201);
    expect(expectOk(await realAdmin.get('/v1/apps')).apps.map((x: { name: string }) => x.name)).toEqual(['Real Plan']);
    expect(expectOk(await read(realAdmin, realApp)).values).toEqual([[777]]);
    // And a real session may not switch people or end anything.
    expect((await realAdmin.post('/v1/demo/persona', { persona: 'admin' })).status).toBe(403);
    expect((await realAdmin.del('/v1/demo/session')).status).toBe(403);
  });

  it('every token of a copy stops working once it has ended, including persona tokens', async () => {
    const c = await startOk(h, '203.0.113.5');
    const viewer = new Api(h.app, expectOk(await c.api.post('/v1/demo/persona', { persona: 'viewer' })).session_token);
    expect(expectOk(await viewer.del('/v1/demo/session')).ended).toBe(true);
    for (const api of [c.api, viewer]) {
      expect((await api.get('/v1/apps')).status).toBe(401);
      expect((await api.get('/v1/me')).status).toBe(401);
      expect((await api.post('/v1/demo/persona', { persona: 'admin' })).status).toBe(401);
      expect((await api.del('/v1/demo/session')).status).toBe(401);
      expect((await read(api, c.appId)).status).toBe(401);
    }
    // "Start over" with an ended copy's token just starts a new one.
    const again = await startDemo(h, '203.0.113.5', { token: c.token });
    expect(again.status).toBe(201);
  });

  it('a phone paired to a copy reads it, but cannot end it, start over, switch people or outlive it', async () => {
    const d = await startOk(h, '203.0.113.8');
    const post = async (path: string, body: unknown) => {
      const r = await h.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as any };
    };
    const link = expectOk(await d.api.post('/v1/devices/links', {}), 201);
    const claimed = await post('/v1/devices/claim', { code: link.url.slice(link.url.indexOf('#') + 1) });
    expectOk(await d.api.post(`/v1/devices/links/${link.link_id}/approve`, { match: claimed.body.match }));
    const got = await post('/v1/devices/claim/poll', { claim: claimed.body.claim });
    expect(got.status).toBe(200);
    const phone = new Api(h.app, got.body.session_token);
    const claims = JSON.parse(Buffer.from(got.body.session_token.split('.')[1], 'base64url').toString('utf8'));
    const [row] = await su(h, 'select extract(epoch from demo_expires_at)::bigint as e from epm.tenant where tenant_id = $1', [d.tenantId]);
    expect(claims).toMatchObject({ demo: true, ro: true });
    expect(claims.exp).toBeLessThanOrEqual(Number(row.e) + 2);
    expect(expectOk(await read(phone, d.appId)).values).toEqual([[100]]);
    expect((await phone.del('/v1/demo/session')).status).toBe(403);
    expect((await phone.post('/v1/demo/persona', { persona: 'admin' })).status).toBe(403);
    // "Start over" with the phone's token starts an unrelated copy and leaves this one alone.
    const again = await startDemo(h, '203.0.113.9', { token: got.body.session_token });
    expect(again.status).toBe(201);
    expect((await d.api.get('/v1/apps')).status).toBe(200);
    expect((await phone.get('/v1/apps')).status).toBe(200);
    // Ending the copy ends the phone's access with it.
    expectOk(await d.api.del('/v1/demo/session'));
    expect((await phone.get('/v1/apps')).status).toBe(401);
  });

  it('demo tokens live no longer than the copy (hours are capped at a week)', async () => {
    const d = await startOk(h, '203.0.113.7');
    const exp = JSON.parse(Buffer.from(d.token.split('.')[1]!, 'base64url').toString('utf8')).exp as number;
    const [row] = await su(h, 'select extract(epoch from demo_expires_at)::bigint as e from epm.tenant where tenant_id = $1', [d.tenantId]);
    expect(Math.abs(exp - Number(row.e))).toBeLessThanOrEqual(2);
    const persona = expectOk(await d.api.post('/v1/demo/persona', { persona: 'planner' }));
    expect(persona.expires_in).toBeLessThanOrEqual(24 * 3600);
  });
});
