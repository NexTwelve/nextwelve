import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSnapshot } from '../src/backup/snapshots.js';
import { poolDatabase } from '../src/db.js';
import { DEMO_PERSONAS, type DemoConfig, demoGuard, networkOf, storeTemplate, sweepDemoTenants } from '../src/demo.js';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, provisionTenant, seedPlanApp, signIn, superQuery } from './helpers.js';

const [ADMIN, PLANNER, VIEWER] = DEMO_PERSONAS as [typeof DEMO_PERSONAS[number], typeof DEMO_PERSONAS[number], typeof DEMO_PERSONAS[number]];
const DEMO: DemoConfig = { enabled: true, maxLive: 6, perIpHour: 3, hours: 24, ipSalt: 'test-salt' };

/** A small template: the plan app with a little data, a planner for East and a viewer. */
async function buildTemplate(h: Harness): Promise<void> {
  const tenantId = await provisionTenant(h.db, 'Template build', null, ADMIN.email);
  const admin = await signIn(h, ADMIN.email);
  const appId = await seedPlanApp(admin, 'Fernhollow Operating Plan');
  const base = `/v1/apps/${appId}`;
  for (const [p, role] of [[PLANNER, 'planner'], [VIEWER, 'viewer']] as const) {
    expectOk(await admin.post('/v1/users', { email: p.email }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: p.email, role }));
  }
  expectOk(await admin.put(`${base}/grants`, {
    grants: [
      { principal: { user: PLANNER.email }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' },
      { principal: { user: VIEWER.email }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'read' },
    ],
  }));
  const g = expectOk(await admin.post(`${base}/grid/read`, { cube: 'Plan', pov: PLAN_POV, rows: { dimension: 'Account', members: ['Revenue', 'COGS'] }, columns: { dimension: 'Period', members: ['Jan', 'Feb'] } }));
  expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[100, 110], [40, 44]] }));
  expectOk(await admin.put(`${base}/reports/Margin`, {
    cube: 'Plan',
    definition: { pov: { ...PLAN_POV }, rows: [{ dimension: 'Account', members: ['Revenue', 'COGS'] }], columns: [{ dimension: 'Period', members: ['Jan', 'Feb'] }] },
  }));
  const me = expectOk(await admin.get('/v1/me'));
  const snap = await createSnapshot({ db: poolDatabase(h.pool), blobs: h.blobs }, { userId: me.user_id, tenantId }, appId, { kind: 'manual' });
  const owner = new pg.Client({ connectionString: h.db.ownerUrl });
  await owner.connect();
  try {
    await storeTemplate(owner, h.blobs, snap);
    await owner.query("update epm.tenant set demo_expires_at = now() + interval '1 hour' where tenant_id = $1", [tenantId]);
    await owner.query('select epm.purge_tenant($1)', [tenantId]);
  } finally {
    await owner.end();
  }
}

describe('the public demo', () => {
  let h: Harness;
  let realAdmin: Api;
  let realApp: string;

  const start = (ip: string, token?: string) => {
    const api = new Api(h.app, token ?? null);
    return Promise.resolve(h.app.request('/v1/demo/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
    })).then(async (r: Response) => ({ status: r.status, body: await r.json() as any, api }));
  };
  const demoApi = (token: string) => new Api(h.app, token);
  const tenants = async () => superQuery(h, 'select tenant_id, name, demo_expires_at from epm.tenant order by name');

  beforeAll(async () => {
    h = await createHarness({ demo: DEMO });
    // A real customer tenant alongside the demos.
    await provisionTenant(h.db, 'Real Co', null, 'cfo@real.test');
    realAdmin = await signIn(h, 'cfo@real.test');
    realApp = await seedPlanApp(realAdmin, 'Real Plan');
    await buildTemplate(h);
  }, 40_000);
  afterAll(async () => h?.close());

  it('says whether the demo is on and who is in it, without a session', async () => {
    const r = await new Api(h.app).get('/v1/demo');
    expect(r.body).toMatchObject({ enabled: true, turnstile_site_key: null, hours: 24 });
    expect(r.body.personas.map((p: { key: string }) => p.key)).toEqual(['admin', 'planner', 'viewer']);
    expect((await new Api(h.app).get('/v1/config')).body.demo).toEqual({ enabled: true, turnstile_site_key: null });
  });

  it('starts a private copy of the sample with a session for its administrator', async () => {
    const r = await start('203.0.113.10');
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ persona: 'admin', expires_in: expect.any(Number) });
    expect(r.body.expires_in).toBeGreaterThan(23 * 3600);
    const api = demoApi(r.body.session_token);
    const me = expectOk(await api.get('/v1/me'));
    expect(me).toMatchObject({ email: ADMIN.email, tenant: 'NexTwelve demo', demo: { persona: 'admin' } });
    const apps = expectOk(await api.get('/v1/apps')).apps;
    expect(apps.map((a: { name: string }) => a.name)).toEqual(['Fernhollow Operating Plan']);
    const base = `/v1/apps/${apps[0].app_id}`;
    // The template's data, report and people came along; numbers can change.
    const report = expectOk(await api.post(`${base}/reports/Margin/run`, {}));
    expect(report.values).toEqual([[100, 110], [40, 44]]);
    const g = expectOk(await api.post(`${base}/grid/read`, { cube: 'Plan', pov: PLAN_POV, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } }));
    expectOk(await api.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[999]] }));
    expect(expectOk(await api.post(`${base}/reports/Margin/run`, {})).values[0][0]).toBe(999);
  });

  it('keeps every copy apart: another visitor sees the original numbers, the real tenant sees nothing', async () => {
    const a = await start('203.0.113.11');
    const b = await start('203.0.113.12');
    const apiA = demoApi(a.body.session_token);
    const apiB = demoApi(b.body.session_token);
    const appA = expectOk(await apiA.get('/v1/apps')).apps[0].app_id;
    const appB = expectOk(await apiB.get('/v1/apps')).apps[0].app_id;
    expect(appA).not.toBe(appB);
    const g = expectOk(await apiA.post(`/v1/apps/${appA}/grid/read`, { cube: 'Plan', pov: PLAN_POV, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } }));
    expectOk(await apiA.post(`/v1/apps/${appA}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[1]] }));
    expect(expectOk(await apiB.post(`/v1/apps/${appB}/reports/Margin/run`, {})).values[0][0]).toBe(100);
    expect((await apiA.get(`/v1/apps/${appB}/forms`)).status).toBe(404);
    expect((await apiA.get(`/v1/apps/${realApp}/forms`)).status).toBe(404);
    expect(expectOk(await realAdmin.get('/v1/apps')).apps.map((x: { name: string }) => x.name)).toEqual(['Real Plan']);
  });

  it('switches between the people in a copy, and their access is enforced', async () => {
    const r = await start('203.0.113.13');
    const admin = demoApi(r.body.session_token);
    const appId = expectOk(await admin.get('/v1/apps')).apps[0].app_id;
    const asPlanner = expectOk(await admin.post('/v1/demo/persona', { persona: 'planner' }));
    expect(asPlanner.persona).toBe('planner');
    const planner = demoApi(asPlanner.session_token);
    expect(expectOk(await planner.get('/v1/me'))).toMatchObject({ email: PLANNER.email, demo: { persona: 'planner' } });
    const read = (api: Api, entity: string) => api.post(`/v1/apps/${appId}/grid/read`, { cube: 'Plan', pov: { ...PLAN_POV, Entity: entity }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } });
    expect(expectOk(await read(planner, 'East')).writable).toEqual([[true]]);
    expect((await read(planner, 'West')).status).toBe(403);
    const viewer = demoApi(expectOk(await planner.post('/v1/demo/persona', { persona: 'viewer' })).session_token);
    expect(expectOk(await read(viewer, 'West')).writable).toEqual([[false]]);
    expect((await viewer.put(`/v1/apps/${appId}/reports/Margin`, { cube: 'Plan', definition: {} })).status).toBe(403);
    // Back to the administrator; a real session cannot switch into a demo.
    expect(expectOk(await viewer.post('/v1/demo/persona', { persona: 'admin' })).persona).toBe('admin');
    expect((await realAdmin.post('/v1/demo/persona', { persona: 'admin' })).status).toBe(403);
  });

  it('blocks inviting people, roles, new applications and large uploads in a demo', async () => {
    const r = await start('203.0.113.14');
    const api = demoApi(r.body.session_token);
    const appId = expectOk(await api.get('/v1/apps')).apps[0].app_id;
    expect((await api.post('/v1/apps', { name: 'Another' })).status).toBe(403);
    expect((await api.post('/v1/users', { email: 'friend@example.com' })).status).toBe(403);
    expect((await api.post('/v1/groups', { name: 'G' })).status).toBe(403);
    expect((await api.post(`/v1/apps/${appId}/roles`, { email: PLANNER.email, role: 'app_admin' })).status).toBe(403);
    expect((await api.del(`/v1/apps/${appId}/roles/${PLANNER.email}`)).status).toBe(403);
    const big = await api.upload(`/v1/apps/${appId}`, 'big.csv', new Uint8Array(1024 * 1024 + 10));
    expect(big.status).toBe(413);
    const snap = expectOk(await api.post(`/v1/apps/${appId}/snapshots`, {}), 201);
    expect((await api.post(`/v1/apps/${appId}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app' })).status).toBe(403);
    // What a demo is for still works: metadata restore, definitions export, backups.
    expect((await api.raw('GET', `/v1/apps/${appId}/definitions/export`)).status).toBe(200);
    expect(expectOk(await api.post(`/v1/apps/${appId}/metadata/restore`, { snapshot_id: snap.snapshot_id, dry_run: true })).dry_run).toBe(true);
  });

  it('limits demos per network per hour and live copies overall', async () => {
    const ip = '198.51.100.7';
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await start(ip)).status);
    // The cap on live copies (6) is reached here, so the busy message may come before the rate limit.
    expect(codes.some((c) => c === 429 || c === 503)).toBe(true);
    const busy = await start('198.51.100.99');
    expect(busy.status).toBe(503);
    expect(busy.body.message).toMatch(/busy/);
  });

  it('"Start over" ends the old copy, and ended or expired copies leave nothing behind', async () => {
    await superQuery(h, "update epm.tenant set demo_expires_at = now() - interval '1 minute' where demo_expires_at is not null");
    const first = await start('192.0.2.1');
    expect(first.status).toBe(201);
    const oldTenant = expectOk(await demoApi(first.body.session_token).get('/v1/me')).tenant_id ?? null;
    void oldTenant;
    const appId = expectOk(await demoApi(first.body.session_token).get('/v1/apps')).apps[0].app_id;
    // A file in storage, as uploads and snapshots leave.
    expectOk(await demoApi(first.body.session_token).post(`/v1/apps/${appId}/snapshots`, {}), 201);
    const firstTenant = (await superQuery(h, 'select tenant_id from epm.application where app_id = $1', [appId]))[0].tenant_id;
    expect((await h.blobs.list(`${firstTenant}/`)).length).toBeGreaterThan(0);

    const again = await start('192.0.2.1', first.body.session_token);
    expect(again.status).toBe(201);
    expect((await demoApi(first.body.session_token).get('/v1/apps')).status).not.toBe(200);
    expect(await superQuery(h, 'select 1 from epm.tenant where tenant_id = $1', [firstTenant])).toEqual([]);
    expect(await h.blobs.list(`${firstTenant}/`)).toEqual([]);
    for (const t of ['fact', 'cell_audit', 'change_txn', 'member', 'snapshot', 'security_event', 'app_user', 'artifact_version']) {
      expect(await superQuery(h, `select 1 from epm.${t} where tenant_id = $1 limit 1`, [firstTenant]), t).toEqual([]);
    }

    // Ending a demo from the app.
    const third = await start('192.0.2.2');
    const api = demoApi(third.body.session_token);
    expect(expectOk(await api.del('/v1/demo/session')).ended).toBe(true);
    expect((await api.get('/v1/apps')).status).not.toBe(200);
    expect((await realAdmin.del('/v1/demo/session')).status).toBe(403);

    // The scheduled sweep removes expired copies (and only demo tenants).
    await superQuery(h, "update epm.tenant set demo_expires_at = now() - interval '1 minute' where demo_expires_at is not null");
    const swept = await sweepDemoTenants({ db: poolDatabase(h.pool), blobs: h.blobs }, h.db.jobKey);
    expect(swept.length).toBeGreaterThan(0);
    expect((await tenants()).map((t) => t.name)).toEqual(['Real Co']);
    expect(expectOk(await realAdmin.get('/v1/apps')).apps).toHaveLength(1);
  });

  it('needs the browser check when one is configured, and is off unless enabled', async () => {
    const checked = await createHarness({ demo: { ...DEMO, verifyTurnstile: async (t) => t === 'good' } });
    try {
      const go = (body: unknown) => checked.app.request('/v1/demo/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect((await go({})).status).toBe(403);
      expect((await go({ turnstile_token: 'bad' })).status).toBe(403);
      expect((await go({ turnstile_token: 'good' })).status).toBe(503); // no template in this database
      expect((await go({ turnstile_token: 'x'.repeat(100_000) })).status).toBe(413); // read no further than 16 KB
    } finally {
      await checked.close();
    }
    const off = await createHarness();
    try {
      expect((await off.app.request('/v1/demo/session', { method: 'POST', body: '{}' })).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe('demo limits, without a database', () => {
  it('counts a visitor by IPv4 address or IPv6 /64', () => {
    const cases: [string | null, string][] = [
      ['198.51.100.20', '198.51.100.20'], [null, 'unknown'],
      ['2001:db8:1234:5678::1', '2001:db8:1234:5678::/64'], ['2001:0db8:1234:5678:ffff:0:0:9', '2001:db8:1234:5678::/64'],
      ['2001:db8::1', '2001:db8:0:0::/64'], ['::ffff:192.0.2.1', '192.0.2.1'], ['[2001:db8:1:2::3]', '2001:db8:1:2::/64'],
      ['64:ff9b:0:0:0:0:1.2.3.4', '64:ff9b:0:0::/64'], ['fe80::1%eth0', 'fe80:0:0:0::/64'], ['2001:DB8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ];
    for (const [ip, want] of cases) expect(networkOf(ip), String(ip)).toBe(want);
  });

  it('refuses demo sessions once the demo is turned off', () => {
    const c = { req: { method: 'GET', path: '/v1/apps', header: () => undefined } } as unknown as Parameters<typeof demoGuard>[0];
    const s = { userId: 'u', tenantId: 't', demo: true };
    expect(() => demoGuard(c, s, { ...DEMO, enabled: false })).toThrow(/ended/);
    expect(() => demoGuard(c, s, undefined)).toThrow(/ended/);
    expect(() => demoGuard(c, s, DEMO)).not.toThrow();
    expect(() => demoGuard(c, { userId: 'u', tenantId: 't' }, undefined)).not.toThrow();
  });
});
