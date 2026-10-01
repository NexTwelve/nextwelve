import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, provisionTenant, signIn } from './helpers.js';

describe('Google sign-in and sessions', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Personal Test', null, 'john.tester@gmail.com');
    await provisionTenant(h.db, 'Acme', 'acme.test', 'cfo@acme.test');
  });
  afterAll(async () => h?.close());

  async function exchange(token: string) {
    return new Api(h.app).post('/v1/auth/session', { id_token: token });
  }

  it('lets an invited personal Gmail account in (no hd claim)', async () => {
    const res = await exchange(await h.google.token({ sub: 'g-john', email: 'John.Tester@gmail.com' }));
    expect(res.status).toBe(200);
    expect(res.body.session_token).toBeTypeOf('string');
    const api = new Api(h.app, res.body.session_token);
    const me = expectOk(await api.get('/v1/me'));
    expect(me.email).toBe('john.tester@gmail.com');
    expect(me.roles).toEqual([expect.objectContaining({ role: 'service_admin', app_id: null })]);
  });

  it('matches returning users on sub, not email', async () => {
    const res = await exchange(await h.google.token({ sub: 'g-john', email: 'renamed@gmail.com' }));
    expect(res.status).toBe(200);
    const me = expectOk(await new Api(h.app, res.body.session_token).get('/v1/me'));
    expect(me.email).toBe('john.tester@gmail.com');
  });

  it('admits a new user from the tenant domain via the hd claim, with no roles', async () => {
    const res = await exchange(await h.google.token({ sub: 'g-ana', email: 'ana@acme.test', hd: 'acme.test' }));
    expect(res.status).toBe(200);
    const me = expectOk(await new Api(h.app, res.body.session_token).get('/v1/me'));
    expect(me.tenant).toBe('Acme');
    expect(me.roles).toEqual([]);
  });

  it('refuses accounts that are neither invited nor in a tenant domain', async () => {
    const res = await exchange(await h.google.token({ sub: 'g-stranger', email: 'stranger@gmail.com' }));
    expect(res.status).toBe(403);
    const wrongDomain = await exchange(await h.google.token({ sub: 'g-x', email: 'x@other.test', hd: 'other.test' }));
    expect(wrongDomain.status).toBe(403);
  });

  it('does not bind an invite to an unverified email', async () => {
    const admin = await signIn(h, 'john.tester@gmail.com', { sub: 'g-john' });
    expectOk(await admin.post('/v1/users', { email: 'pat@gmail.com' }), 201);
    const res = await exchange(await h.google.token({ sub: 'g-pat', email: 'pat@gmail.com', email_verified: false }));
    expect(res.status).toBe(403);
    const ok = await exchange(await h.google.token({ sub: 'g-pat', email: 'pat@gmail.com' }));
    expect(ok.status).toBe(200);
  });

  it('rejects bad Google tokens', async () => {
    const wrongAud = await exchange(await h.google.token({ sub: 'g-john', email: 'john.tester@gmail.com', aud: 'someone-else' }));
    expect(wrongAud.status).toBe(401);
    const wrongIss = await exchange(await h.google.token({ sub: 'g-john', email: 'john.tester@gmail.com', iss: 'https://evil.test' }));
    expect(wrongIss.status).toBe(401);
    const expired = await exchange(await h.google.token({ sub: 'g-john', email: 'john.tester@gmail.com', expiresIn: '-1m' }));
    expect(expired.status).toBe(401);
    const garbage = await exchange('x'.repeat(40));
    expect(garbage.status).toBe(401);
  });

  it('rejects missing or tampered session tokens', async () => {
    expect((await new Api(h.app).get('/v1/me')).status).toBe(401);
    const api = await signIn(h, 'john.tester@gmail.com', { sub: 'g-john' });
    const parts = api.token!.split('.');
    parts[1] = Buffer.from(JSON.stringify({ sub: 'someone', tid: 'other' })).toString('base64url');
    expect((await new Api(h.app, parts.join('.')).get('/v1/me')).status).toBe(401);
  });

  it('cuts off a disabled user on their next request and at sign-in', async () => {
    const admin = await signIn(h, 'john.tester@gmail.com', { sub: 'g-john' });
    expectOk(await admin.post('/v1/users', { email: 'temp@gmail.com' }), 201);
    const temp = await signIn(h, 'temp@gmail.com', { sub: 'g-temp' });
    expectOk(await temp.get('/v1/me'));
    expectOk(await admin.patch('/v1/users/temp@gmail.com', { status: 'disabled' }));
    expect((await temp.get('/v1/me')).status).toBe(401);
    const again = await exchange(await h.google.token({ sub: 'g-temp', email: 'temp@gmail.com' }));
    expect(again.status).toBe(403);
    expect((await admin.patch(`/v1/users/john.tester@gmail.com`, { status: 'disabled' })).status).toBe(422);
  });

  it('records sign-ins and denials as security events', async () => {
    const su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    const res = await su.query<{ event_type: string; n: number }>(
      "select event_type, count(*)::int as n from epm.security_event where event_type like 'login%' group by 1",
    );
    await su.end();
    const counts = Object.fromEntries(res.rows.map((r) => [r.event_type, r.n]));
    expect(counts.login).toBeGreaterThan(3);
    expect(counts.login_denied).toBeGreaterThanOrEqual(1);
  });
});
