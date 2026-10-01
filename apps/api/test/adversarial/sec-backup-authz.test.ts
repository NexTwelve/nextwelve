import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Adversarial: who may reach each backup / restore route, and whether ids from one
 * application (or tenant) can be used through another application's routes.
 */
const R = { REV: 2, OPEX: 4 };
const C = { JAN: 0, FEB: 1 };

describe('backup routes: authorization and object references', () => {
  let h: Harness;
  let su: pg.Client;
  let tenantA: string;
  let admin: Api; // service_admin of tenant A
  let viewer: Api;
  let planner: Api;
  let power: Api;
  let adminX: Api; // app_admin of X only
  let adminY: Api; // app_admin of Y only
  let disabled: Api; // app_admin of X, then disabled
  let otherTenant: Api; // service_admin of tenant B
  let appX: string;
  let appY: string;
  let appB: string;
  let snapX: string;
  let snapY: string;
  let snapB: string;
  let restoreTxn: number;
  let plannerTxn: number;

  const X = () => `/v1/apps/${appX}`;
  const Y = () => `/v1/apps/${appY}`;
  const B = () => `/v1/apps/${appB}`;
  const pit = { cube: 'Plan', scenario: 'Budget', version: 'Working' };

  async function edit(api: Api, base: string, edits: [number, number, number | null][], pov = PLAN_POV): Promise<number> {
    const g = expectOk(await api.post(`${base}/grid/read`, planGrid(pov)));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await api.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).txn_id;
  }
  async function user(email: string, app: string, role: string): Promise<Api> {
    expectOk(await admin.post('/v1/users', { email }), 201);
    expectOk(await admin.post(`/v1/apps/${app}/roles`, { email, role }));
    return signIn(h, email);
  }
  async function count(sql: string, params: unknown[] = []): Promise<number> {
    return (await su.query<{ n: number }>(`select count(*)::int as n from (${sql}) x`, params)).rows[0]!.n;
  }

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    tenantA = await provisionTenant(h.db, 'Authz Co', null, 'admin@az.test');
    admin = await signIn(h, 'admin@az.test');
    appX = await seedPlanApp(admin, 'Plan X');
    appY = await seedPlanApp(admin, 'Plan Y');
    viewer = await user('viewer@az.test', appX, 'viewer');
    planner = await user('planner@az.test', appX, 'planner');
    expectOk(await admin.put(`${X()}/grants`, { grants: [{ principal: { user: 'planner@az.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' }] }));
    planner = await signIn(h, 'planner@az.test');
    power = await user('power@az.test', appX, 'power_user');
    adminX = await user('adminx@az.test', appX, 'app_admin');
    adminY = await user('adminy@az.test', appY, 'app_admin');
    disabled = await user('gone@az.test', appX, 'app_admin');
    expectOk(await admin.patch('/v1/users/gone@az.test', { status: 'disabled' }));

    plannerTxn = await edit(planner, X(), [[R.REV, C.JAN, 100], [R.REV, C.FEB, 200]]);
    await edit(admin, X(), [[R.OPEX, C.JAN, 7]]);
    await edit(admin, Y(), [[R.REV, C.JAN, 555]]);
    snapX = expectOk(await admin.post(`${X()}/snapshots`, {}), 201).snapshot_id;
    snapY = expectOk(await admin.post(`${Y()}/snapshots`, {}), 201).snapshot_id;
    const later = await edit(planner, X(), [[R.REV, C.JAN, 111]]);
    // A real restore transaction authored by the service admin (East only, which the planner can write).
    restoreTxn = expectOk(await admin.post(`${X()}/restore`, { ...pit, before_txn: later, filters: { Entity: ['East'], Account: ['Revenue'] } })).txn_id;

    await provisionTenant(h.db, 'Other Co', null, 'admin@other.test');
    otherTenant = await signIn(h, 'admin@other.test');
    appB = await seedPlanApp(otherTenant, 'Plan X');
    await edit(otherTenant, B(), [[R.REV, C.JAN, 9]]);
    snapB = expectOk(await otherTenant.post(`${B()}/snapshots`, {}), 201).snapshot_id;
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  async function lastTxn(app: string): Promise<number> {
    return (await su.query<{ t: number }>('select max(txn_id)::int as t from epm.change_txn where app_id = $1', [app])).rows[0]!.t;
  }

  function routes(base: string, snap: string) {
    return [
      ['POST restore (point in time)', 'POST', `${base}/restore`, { ...pit, before_txn: restoreTxn, dry_run: true }],
      ['GET snapshots', 'GET', `${base}/snapshots`, undefined],
      ['POST snapshots', 'POST', `${base}/snapshots`, {}],
      ['GET snapshot', 'GET', `${base}/snapshots/${snap}`, undefined],
      ['GET manifest.json', 'GET', `${base}/snapshots/${snap}/files/manifest.json`, undefined],
      ['GET facts file', 'GET', `${base}/snapshots/${snap}/files/facts-0001.ndjson.gz`, undefined],
      ['POST restore in_place', 'POST', `${base}/snapshots/${snap}/restore`, { target: 'in_place', dry_run: true }],
      ['POST restore new_app', 'POST', `${base}/snapshots/${snap}/restore`, { target: 'new_app', name: `Hijack ${Math.random()}` }],
    ] as const;
  }

  async function sweep(api: Api, expected: number, base = X(), snap = () => snapX) {
    const before = {
      apps: await count('select 1 from epm.application'),
      snaps: await count('select 1 from epm.snapshot'),
      txns: await count('select 1 from epm.change_txn'),
      blobs: h.blobs.keys().length,
    };
    const got: Record<string, number> = {};
    for (const [label, method, url, body] of routes(base, snap())) {
      const res = method === 'GET' ? await api.get(url) : await api.post(url, body);
      got[label] = res.status;
    }
    expect(got).toEqual(Object.fromEntries(routes(base, snap()).map(([l]) => [l, expected])));
    // Nothing was created by the refused calls.
    expect({
      apps: await count('select 1 from epm.application'),
      snaps: await count('select 1 from epm.snapshot'),
      txns: await count('select 1 from epm.change_txn'),
      blobs: h.blobs.keys().length,
    }).toEqual(before);
  }

  it('sanity: the restore transaction exists and the service admin can use every route', async () => {
    expect(restoreTxn).toBeGreaterThan(0);
    expect((await admin.get(`${X()}/snapshots/${snapX}/files/manifest.json`)).status).toBe(200);
  });

  it('refuses viewers, planners and power users on every backup route (403) and creates nothing', async () => {
    await sweep(viewer, 403);
    await sweep(planner, 403);
    await sweep(power, 403);
  });

  it('refuses an app_admin of another application in the same tenant (403)', async () => {
    await sweep(adminY, 403);
  });

  it('refuses a disabled user whose session token is still valid (401)', async () => {
    await sweep(disabled, 401);
  });

  it('shows another tenant nothing: every route is 404', async () => {
    await sweep(otherTenant, 404);
  });

  it('refuses restore into a new application for a plain app_admin, with nothing created', async () => {
    const before = await count('select 1 from epm.application');
    const r = await adminX.post(`${X()}/snapshots/${snapX}/restore`, { target: 'new_app', name: 'Mine Now' });
    expect(r.status).toBe(403);
    expect(await count('select 1 from epm.application')).toBe(before);
    expect(await count("select 1 from epm.application where name = 'Mine Now'")).toBe(0);
  });

  it("will not use app X's snapshot through app Y's routes, even for a service admin", async () => {
    const yBefore = expectOk(await admin.post(`${Y()}/grid/read`, planGrid())).values;
    for (const api of [admin, adminY]) {
      expect((await api.get(`${Y()}/snapshots/${snapX}`)).status).toBe(404);
      expect((await api.get(`${Y()}/snapshots/${snapX}/files/manifest.json`)).status).toBe(404);
      expect((await api.get(`${Y()}/snapshots/${snapX}/files/facts-0001.ndjson.gz`)).status).toBe(404);
      expect((await api.post(`${Y()}/snapshots/${snapX}/restore`, { target: 'in_place' })).status).toBe(404);
      expect((await api.post(`${Y()}/snapshots/${snapX}/restore`, { target: 'in_place', dry_run: true })).status).toBe(404);
    }
    expect((await admin.post(`${Y()}/snapshots/${snapX}/restore`, { target: 'new_app' })).status).toBe(404);
    expect(expectOk(await admin.get(`${Y()}/snapshots`)).snapshots.map((s: any) => s.snapshot_id)).not.toContain(snapX);
    // Y's data did not move.
    expect(expectOk(await admin.post(`${Y()}/grid/read`, planGrid())).values).toEqual(yBefore);
    // And Y's snapshot is not reachable from X.
    expect((await adminX.get(`${X()}/snapshots/${snapY}`)).status).toBe(404);
    expect((await adminX.post(`${X()}/snapshots/${snapY}/restore`, { target: 'in_place' })).status).toBe(404);
  });

  it("will not use another tenant's snapshot or transaction ids through one's own application", async () => {
    // Tenant B's admin through B's app, with tenant A's ids.
    expect((await otherTenant.get(`${B()}/snapshots/${snapX}`)).status).toBe(404);
    expect((await otherTenant.get(`${B()}/snapshots/${snapX}/files/manifest.json`)).status).toBe(404);
    expect((await otherTenant.post(`${B()}/snapshots/${snapX}/restore`, { target: 'in_place' })).status).toBe(404);
    expect((await otherTenant.post(`${B()}/snapshots/${snapX}/restore`, { target: 'new_app' })).status).toBe(404);
    expect((await otherTenant.post(`${B()}/restore`, { ...pit, before_txn: restoreTxn, dry_run: true })).status).toBe(404);
    // Tenant A's admin through A's app with B's snapshot id.
    expect((await admin.get(`${X()}/snapshots/${snapB}`)).status).toBe(404);
    expect((await admin.post(`${X()}/snapshots/${snapB}/restore`, { target: 'in_place' })).status).toBe(404);
    expect((await admin.post(`${X()}/snapshots/${snapB}/restore`, { target: 'new_app' })).status).toBe(404);
  });

  it('point-in-time: before_txn from another application is not found', async () => {
    const yTxn = await lastTxn(appY);
    expect((await admin.post(`${X()}/restore`, { ...pit, before_txn: yTxn, dry_run: true })).status).toBe(404);
  });

  it('undo of a restore transaction: refused to a planner who is not its author, and to other apps', async () => {
    // The planner has write access to every cell the restore touched (East / Revenue), but did not author it.
    const cells = (await su.query<{ coords: number[] }>('select coords from epm.cell_audit where txn_id = $1', [restoreTxn])).rows;
    expect(cells.length).toBeGreaterThan(0);
    expect((await planner.post(`${X()}/txns/${restoreTxn}/undo`, {})).status).toBe(403);
    expect((await planner.post(`${X()}/txns/${restoreTxn}/undo`, { force: true })).status).toBe(403);
    expect((await viewer.post(`${X()}/txns/${restoreTxn}/undo`, {})).status).toBe(403);
    expect((await power.post(`${X()}/txns/${restoreTxn}/undo`, {})).status).toBe(403);
    expect((await adminY.post(`${X()}/txns/${restoreTxn}/undo`, {})).status).toBe(403);
    expect((await adminY.post(`${Y()}/txns/${restoreTxn}/undo`, {})).status).toBe(404);
    expect((await otherTenant.post(`${B()}/txns/${restoreTxn}/undo`, {})).status).toBe(404);
    expect((await disabled.post(`${X()}/txns/${restoreTxn}/undo`, {})).status).toBe(401);
    // Nothing was undone.
    expect(await count("select 1 from epm.change_txn where source = 'undo' and source_ref = $1", [String(restoreTxn)])).toBe(0);
    // An app admin who is not the author may.
    expectOk(await adminX.post(`${X()}/txns/${restoreTxn}/undo`, {}));
    expect(expectOk(await admin.post(`${X()}/audit/verify`))).toMatchObject({ ok: true });
  });

  it('records every snapshot download in security_event, with the user and file', async () => {
    const before = await count("select 1 from epm.security_event where event_type = 'snapshot_downloaded'");
    expect((await adminX.get(`${X()}/snapshots/${snapX}/files/manifest.json`)).status).toBe(200);
    const gz = await h.app.request(`${X()}/snapshots/${snapX}/files/metadata.json.gz`, { headers: { authorization: `Bearer ${adminX.token}` } });
    expect(gz.status).toBe(200);
    const head = await h.app.request(`${X()}/snapshots/${snapX}/files/datasets.json.gz`, { method: 'HEAD', headers: { authorization: `Bearer ${adminX.token}` } });
    expect(head.status).toBe(200);
    const ev = await su.query<{ user_id: string; detail: any; app_id: string; tenant_id: string }>(
      `select user_id, detail, app_id, tenant_id from epm.security_event where event_type = 'snapshot_downloaded' order by event_id desc limit 3`,
    );
    expect(await count("select 1 from epm.security_event where event_type = 'snapshot_downloaded'")).toBe(before + 3);
    const adminXId = (await su.query<{ user_id: string }>("select user_id from epm.app_user where email = 'adminx@az.test'")).rows[0]!.user_id;
    expect(ev.rows.every((r) => r.user_id === adminXId && r.app_id === appX && r.tenant_id === tenantA && r.detail.snapshot_id === snapX)).toBe(true);
    expect(ev.rows.map((r) => r.detail.file).sort()).toEqual(['datasets.json.gz', 'manifest.json', 'metadata.json.gz']);
  });
});
