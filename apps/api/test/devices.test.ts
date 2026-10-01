import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SessionContext, poolDatabase, withSession } from '../src/db.js';
import { deviceLabel, qrSvg } from '../src/devices.js';
import { Api, createHarness, expectOk, type Harness, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn, superQuery } from './helpers.js';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** Read-only phone access paired by QR code. */
describe('phone pairing and read-only sessions', () => {
  let h: Harness;
  let admin: Api;
  let planner: Api;
  let appId: string;
  let tenantId: string;

  const post = async (path: string, body: unknown, headers: Record<string, string> = {}) => {
    const r = await h.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const codeOf = (url: string) => url.slice(url.indexOf('#') + 1);

  /** Show a code on the computer, claim it on a phone, approve with the number, collect the session. */
  async function pair(api: Api): Promise<{ phone: Api; linkId: string; token: string }> {
    const link = expectOk(await api.post('/v1/devices/links', {}), 201);
    const claimed = await post('/v1/devices/claim', { code: codeOf(link.url) }, { 'user-agent': IPHONE });
    expect(claimed.status).toBe(200);
    expectOk(await api.post(`/v1/devices/links/${link.link_id}/approve`, { match: claimed.body.match }));
    const got = await post('/v1/devices/claim/poll', { claim: claimed.body.claim });
    expect(got.status).toBe(200);
    return { phone: new Api(h.app, got.body.session_token), linkId: link.link_id, token: got.body.session_token };
  }

  beforeAll(async () => {
    h = await createHarness();
    tenantId = await provisionTenant(h.db, 'Phone Co', null, 'cfo@phone.test');
    admin = await signIn(h, 'cfo@phone.test');
    appId = await seedPlanApp(admin);
    const base = `/v1/apps/${appId}`;
    expectOk(await admin.post('/v1/users', { email: 'pat@phone.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'pat@phone.test', role: 'planner' }));
    expectOk(await admin.put(`${base}/grants`, { grants: [{ principal: { user: 'pat@phone.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' }] }));
    planner = await signIn(h, 'pat@phone.test');
    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid(PLAN_POV, ['Revenue'], ['Jan'])));
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[125]] }));
    expectOk(await admin.put(`${base}/forms/Revenue`, {
      cube: 'Plan',
      definition: { pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Product: 'Widgets' }, page: { Entity: ['East', 'West'] },
        rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan', 'Feb'] } },
    }));
    expectOk(await admin.put(`${base}/reports/Revenue`, {
      cube: 'Plan',
      definition: { pov: { ...PLAN_POV }, rows: [{ dimension: 'Account', members: ['Revenue'] }], columns: [{ dimension: 'Period', members: ['Jan'] }] },
    }));
  }, 30_000);
  afterAll(async () => h?.close());

  it('pairs a phone: one-time code, number match on the computer, session handed out once', async () => {
    const link = expectOk(await admin.post('/v1/devices/links', {}), 201);
    expect(link.url).toMatch(new RegExp(`/m/#${tenantId}\\.${link.link_id}\\.[A-Za-z0-9_-]{43}$`));
    expect(link.qr_svg).toMatch(/^<svg [^>]*viewBox="0 0 \d+ \d+"/);
    expect(expectOk(await admin.get(`/v1/devices/links/${link.link_id}`)).status).toBe('pending');
    // Nothing to approve before a phone has scanned.
    expect((await admin.post(`/v1/devices/links/${link.link_id}/approve`, { match: '42' })).status).toBe(409);

    const claimed = await post('/v1/devices/claim', { code: codeOf(link.url) }, { 'user-agent': IPHONE });
    expect(claimed.body).toMatchObject({ match: expect.stringMatching(/^\d{2}$/), device_label: 'iPhone · Safari' });
    // The code works once.
    expect((await post('/v1/devices/claim', { code: codeOf(link.url) })).status).toBe(410);
    expect(expectOk(await admin.get(`/v1/devices/links/${link.link_id}`))).toMatchObject({ status: 'claimed', device_label: 'iPhone · Safari' });
    expect((await post('/v1/devices/claim/poll', { claim: claimed.body.claim })).body).toEqual({ status: 'waiting' });

    const wrong = claimed.body.match === '10' ? '11' : '10';
    expect((await admin.post(`/v1/devices/links/${link.link_id}/approve`, { match: wrong })).status).toBe(422);
    // Another user of the tenant cannot approve someone else's code.
    expect((await planner.post(`/v1/devices/links/${link.link_id}/approve`, { match: claimed.body.match })).status).toBe(404);
    expectOk(await admin.post(`/v1/devices/links/${link.link_id}/approve`, { match: claimed.body.match }));

    const got = await post('/v1/devices/claim/poll', { claim: claimed.body.claim });
    expect(got.body).toMatchObject({ status: 'approved', session_token: expect.any(String) });
    expect(got.body.expires_in).toBeLessThanOrEqual(8 * 3600);
    expect((await post('/v1/devices/claim/poll', { claim: claimed.body.claim })).status).toBe(410);

    const phone = new Api(h.app, got.body.session_token);
    expect(expectOk(await phone.get('/v1/me'))).toMatchObject({ email: 'cfo@phone.test', read_only: true });
    expect(expectOk(await phone.get('/v1/devices/current'))).toMatchObject({ link_id: link.link_id, device_label: 'iPhone · Safari' });
    expect(expectOk(await admin.get('/v1/devices')).devices.map((d: { link_id: string }) => d.link_id)).toContain(link.link_id);
    const events = await superQuery(h, "select event_type from epm.security_event where tenant_id = $1 and event_type like 'device_%'", [tenantId]);
    expect(events.map((e) => e.event_type)).toContain('device_link_approved');
  });

  it('a phone reads forms and reports but cannot change anything, whatever it calls', async () => {
    const { phone } = await pair(admin);
    const base = `/v1/apps/${appId}`;
    expect(expectOk(await phone.get('/v1/apps')).apps).toHaveLength(1);
    const form = expectOk(await phone.post(`${base}/forms/Revenue/open`, { page: { Entity: 'East' } }));
    expect(form.grid.values).toEqual([[125, null]]);
    expect(form.grid.grid_session_id).toBeNull();
    expect(form.grid.writable.flat().every((w: boolean) => w === false)).toBe(true);
    expect(expectOk(await phone.post(`${base}/reports/Revenue/run`, {})).values).toEqual([[125]]);
    expect(expectOk(await phone.post(`${base}/grid/read`, planGrid(PLAN_POV, ['Revenue'], ['Jan']))).values).toEqual([[125]]);
    expect((await phone.post(`${base}/history`, { cube: 'Plan', cell: { ...PLAN_POV, Account: 'Revenue', Period: 'Jan' } })).status).toBe(200);

    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid(PLAN_POV, ['Revenue'], ['Jan'])));
    const refused = [
      await phone.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[1]] }),
      await phone.put(`${base}/forms/Revenue`, { cube: 'Plan', definition: {} }),
      await phone.del(`${base}/forms/Revenue`),
      await phone.post(`${base}/snapshots`, {}),
      await phone.post(`${base}/restore`, { at: new Date().toISOString(), scenarios: ['Budget'] }),
      await phone.post(`${base}/deploy`, {}),
      await phone.put(`${base}/grants`, { grants: [] }),
      await phone.post(`${base}/txns/1/undo`, {}),
      await phone.get(`${base}/txns`),
      await phone.get(`${base}/snapshots`),
      await phone.raw('GET', `${base}/definitions/export`),
      await phone.post('/v1/devices/links', {}),
      await phone.post('/v1/demo/persona', { persona: 'admin' }),
      await phone.post('/v1/users', { email: 'x@phone.test' }),
      await phone.get(`${base}/forms/Revenue/history`),
    ];
    for (const r of refused) expect(r.status, JSON.stringify((r as { body?: unknown }).body ?? '')).toBe(403);
    // Reports are read on the phone, not downloaded.
    expect((await phone.raw('POST', `${base}/reports/Revenue/run?format=xlsx`, '{}', 'application/json')).status).toBe(403);
    expect(expectOk(await admin.post(`${base}/grid/read`, planGrid(PLAN_POV, ['Revenue'], ['Jan']))).values).toEqual([[125]]);
  });

  it('Postgres itself refuses writes in a phone session, whatever the code path', async () => {
    const { linkId } = await pair(admin);
    const [u] = await superQuery(h, "select user_id from epm.app_user where email = 'cfo@phone.test'");
    const s: SessionContext = { userId: u.user_id, tenantId, readOnly: true, linkId };
    const db = poolDatabase(h.pool);
    expect(await withSession(db, s, async (c) => (await c.query('select count(*)::int as n from epm.form')).rows[0].n)).toBe(1);
    const err = await withSession(db, s, (c) => c.query("insert into epm.security_event (tenant_id, event_type) values ($1, 'x')", [tenantId]))
      .then(() => null, (e: { code?: string }) => e.code);
    expect(err).toBe('25006');
    // A phone session without an active link gets nothing at all.
    const stale = await withSession(db, { ...s, linkId: crypto.randomUUID() }, (c) => c.query('select 1')).then(() => null, (e: Error) => e.message);
    expect(stale).toMatch(/access has ended/);
  });

  it('member-level security applies to the phone exactly as to its user', async () => {
    const { phone } = await pair(planner);
    const base = `/v1/apps/${appId}`;
    expect(expectOk(await phone.post(`${base}/grid/read`, planGrid(PLAN_POV, ['Revenue'], ['Jan']))).values).toEqual([[125]]);
    expect((await phone.post(`${base}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'West' }, ['Revenue'], ['Jan']))).status).toBe(403);
    const form = expectOk(await phone.post(`${base}/forms/Revenue/open`, {}));
    expect(form.page.Entity.options).toEqual(['East']);
    expect(form.grid.writable.flat().every((w: boolean) => w === false)).toBe(true);
  });

  it('revoking from the computer or the phone ends access at once', async () => {
    const one = await pair(admin);
    expect((await one.phone.get('/v1/apps')).status).toBe(200);
    expectOk(await admin.del(`/v1/devices/${one.linkId}`));
    expect((await one.phone.get('/v1/apps')).status).toBe(401);
    expect(expectOk(await admin.get('/v1/devices')).devices.map((d: { link_id: string }) => d.link_id)).not.toContain(one.linkId);

    const two = await pair(admin);
    expectOk(await two.phone.del('/v1/devices/current'));
    expect((await two.phone.get('/v1/me')).status).toBe(401);
    // A user cannot revoke someone else's phone.
    const three = await pair(admin);
    expect((await planner.del(`/v1/devices/${three.linkId}`)).status).toBe(404);
    expect((await three.phone.get('/v1/apps')).status).toBe(200);
  });

  it('expired codes, wrong tenants, guessing and three wrong numbers all fail closed', async () => {
    const link = expectOk(await admin.post('/v1/devices/links', {}), 201);
    const code = codeOf(link.url);
    const [, lid, secret] = code.split('.');
    // Another tenant's id, a made-up secret, junk.
    const other = crypto.randomUUID();
    for (const bad of [`${other}.${lid}.${secret}`, `${tenantId}.${lid}.${'A'.repeat(43)}`, 'nonsense', `${code}.x`, `${tenantId}.${lid}`]) {
      expect((await post('/v1/devices/claim', { code: bad })).status, bad).toBe(404);
    }
    await superQuery(h, "update epm.device_link set code_expires_at = now() - interval '1 second' where link_id = $1", [link.link_id]);
    expect((await post('/v1/devices/claim', { code })).status).toBe(410);
    expect(expectOk(await admin.get(`/v1/devices/links/${link.link_id}`)).status).toBe('expired');

    const next = expectOk(await admin.post('/v1/devices/links', {}), 201);
    const claimed = await post('/v1/devices/claim', { code: codeOf(next.url) });
    const wrong = claimed.body.match === '10' ? '11' : '10';
    expect((await admin.post(`/v1/devices/links/${next.link_id}/approve`, { match: wrong })).status).toBe(422);
    expect((await admin.post(`/v1/devices/links/${next.link_id}/approve`, { match: wrong })).status).toBe(422);
    expect((await admin.post(`/v1/devices/links/${next.link_id}/approve`, { match: wrong })).status).toBe(409);
    // Even the right number is too late now.
    expect((await admin.post(`/v1/devices/links/${next.link_id}/approve`, { match: claimed.body.match })).status).toBe(409);
    expect((await post('/v1/devices/claim/poll', { claim: claimed.body.claim })).body).toEqual({ status: 'denied' });
    // A claim that waits too long for approval expires.
    const late = expectOk(await admin.post('/v1/devices/links', {}), 201);
    const lateClaim = await post('/v1/devices/claim', { code: codeOf(late.url) });
    await superQuery(h, "update epm.device_link set claimed_at = now() - interval '6 minutes' where link_id = $1", [late.link_id]);
    expect((await admin.post(`/v1/devices/links/${late.link_id}/approve`, { match: lateClaim.body.match })).status).toBe(409);
  });

  it('refuses forged phone tokens and limits how many phones a user connects', async () => {
    const forge = async (claims: Record<string, unknown>) => {
      const [u] = await superQuery(h, "select user_id from epm.app_user where email = 'cfo@phone.test'");
      const { SignJWT } = await import('jose');
      return new SignJWT({ tid: tenantId, ...claims }).setProtectedHeader({ alg: 'HS256' }).setSubject(u.user_id)
        .setIssuer('nextwelve').setAudience('nextwelve-api').setIssuedAt().setExpirationTime('1h').sign(new TextEncoder().encode('wrong-secret-wrong-secret-wrong-secret'));
    };
    // Signed with the wrong key: refused before anything else.
    expect((await new Api(h.app, await forge({ ro: true, lid: crypto.randomUUID() })).get('/v1/me')).status).toBe(401);
    // Up to five phones at once.
    await superQuery(h, "update epm.device_link set status = 'revoked' where tenant_id = $1", [tenantId]);
    await superQuery(h, 'delete from epm.device_link where tenant_id = $1', [tenantId]);
    for (let i = 0; i < 5; i++) await pair(admin);
    expect((await admin.post('/v1/devices/links', {})).status).toBe(409);
  });

  it('labels devices and draws QR codes', () => {
    expect(deviceLabel(IPHONE)).toBe('iPhone · Safari');
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36')).toBe('Android · Chrome');
    expect(deviceLabel(undefined)).toBe('Unknown device · a browser');
    const svg = qrSvg('https://nextwelve.com/m/#x');
    expect(svg.length).toBeLessThan(6000);
    expect(svg).toContain('<path fill="#000" d="M');
  });
});
