import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createGoogleVerifier } from '../../src/auth/google.js';
import { createSessionSigner } from '../../src/auth/session.js';
import { poolDatabase } from '../../src/db.js';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn, TEST_CLIENT_ID } from '../helpers.js';

/**
 * Adversarial: the nightly job acts for a tenant with no user (withActor, userId null), and
 * createSnapshot skips the role check for such an actor. No request may reach that path, even
 * with a session whose user or tenant is empty. Also: the download's Content-Disposition.
 */
describe('backup: the no-user actor path and response headers', () => {
  let h: Harness;
  let su: pg.Client;
  let tenantA: string;
  let tenantB: string;
  let appX: string;
  let snapX: string;
  let adminUser: string;
  let forgedApp: ReturnType<typeof createApp>;
  let signer: ReturnType<typeof createSessionSigner>;
  let admin: Api;

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    tenantA = await provisionTenant(h.db, 'Actor Co', null, 'admin@actor.test');
    tenantB = await provisionTenant(h.db, 'Actor B', null, 'admin@actorb.test');
    admin = await signIn(h, 'admin@actor.test');
    appX = await seedPlanApp(admin, 'Evil"\r\nSet-Cookie: pwned=1; x="');
    snapX = expectOk(await admin.post(`/v1/apps/${appX}/snapshots`, {}), 201).snapshot_id;
    adminUser = (await su.query<{ id: string }>("select user_id as id from epm.app_user where email = 'admin@actor.test'")).rows[0]!.id;
    // The same API over the same database, with a signing key the test knows (standing in for a leaked
    // or mis-issued token shape; the real signer never issues these).
    signer = createSessionSigner(randomBytes(32), 900);
    forgedApp = createApp({
      db: poolDatabase(h.pool),
      blobs: h.blobs,
      signer,
      verifier: createGoogleVerifier({ audiences: [TEST_CLIENT_ID], keys: h.google.keys() }),
    });
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  async function as(ctx: { userId: string; tenantId: string }) {
    return new Api(forgedApp, (await signer.issue(ctx)).token);
  }
  async function snapshotRows() {
    return (await su.query<{ n: number }>('select count(*)::int as n from epm.snapshot')).rows[0]!.n;
  }

  it('a session with an empty user id cannot take, list, read or restore snapshots', async () => {
    const api = await as({ userId: '', tenantId: tenantA });
    const before = { rows: await snapshotRows(), blobs: h.blobs.keys().length };
    const b = `/v1/apps/${appX}`;
    const res = {
      create: (await api.post(`${b}/snapshots`, {})).status,
      list: (await api.get(`${b}/snapshots`)).status,
      get: (await api.get(`${b}/snapshots/${snapX}`)).status,
      inPlace: (await api.post(`${b}/snapshots/${snapX}/restore`, { target: 'in_place', dry_run: true })).status,
      newApp: (await api.post(`${b}/snapshots/${snapX}/restore`, { target: 'new_app' })).status,
    };
    for (const [k, s] of Object.entries(res)) expect(s, k).toBeGreaterThanOrEqual(400);
    expect(res.list).toBe(401);
    expect({ rows: await snapshotRows(), blobs: h.blobs.keys().length }).toEqual(before);
  });

  it("a session naming another tenant, or no tenant, gets nothing (user must be active in the session's tenant)", async () => {
    for (const ctx of [{ userId: adminUser, tenantId: tenantB }, { userId: adminUser, tenantId: '' }]) {
      const api = await as(ctx);
      const before = await snapshotRows();
      expect((await api.post(`/v1/apps/${appX}/snapshots`, {})).status).toBe(401);
      expect((await api.get(`/v1/apps/${appX}/snapshots`)).status).toBe(401);
      expect((await api.post(`/v1/apps/${appX}/snapshots/${snapX}/restore`, { target: 'in_place', dry_run: true })).status).toBe(401);
      expect(await snapshotRows()).toBe(before);
    }
  });

  it('the download filename cannot inject headers through the application name', async () => {
    const res = await h.app.request(`/v1/apps/${appX}/snapshots/${snapX}/files/manifest.json`, { headers: { authorization: `Bearer ${admin.token}` } });
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toMatch(/^attachment; filename="[\w.-]+"$/);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
