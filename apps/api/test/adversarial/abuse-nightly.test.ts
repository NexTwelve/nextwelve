import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runNightlySnapshots } from '../../src/backup/snapshots.js';
import { Api, expectOk, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, createAbuseHarness, keysUnder, superuser } from './abuse-helpers.js';

/** The scheduled job across tenants, with one application's export failing. */
describe('adversarial: nightly snapshots', () => {
  let h: AbuseHarness;
  let adminA: Api;
  let adminB: Api;
  let tenantA: string;
  let tenantB: string;
  const app: Record<string, string> = {};

  async function edit(api: Api, appId: string, v: number) {
    const b = `/v1/apps/${appId}`;
    const g = expectOk(await api.post(`${b}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[2][0] = v;
    expectOk(await api.post(`${b}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  }
  const deps = () => ({ db: h.database, blobs: h.blobs });
  const byApp = (results: Awaited<ReturnType<typeof runNightlySnapshots>>) => Object.fromEntries(results.map((r) => [r.app_id, r]));

  beforeAll(async () => {
    h = await createAbuseHarness();
    tenantA = await provisionTenant(h.db, 'Night A', null, 'admin@na.test');
    tenantB = await provisionTenant(h.db, 'Night B', null, 'admin@nb.test');
    adminA = await signIn(h as any, 'admin@na.test');
    adminB = await signIn(h as any, 'admin@nb.test');
    app.a1 = await seedPlanApp(adminA, 'A One');
    app.a2 = await seedPlanApp(adminA, 'A Two');
    app.b1 = await seedPlanApp(adminB, 'B One');
    app.restoring = await seedPlanApp(adminA, 'A Restoring');
    app.adminOnly = await seedPlanApp(adminB, 'B Admin Only');
    await edit(adminA, app.a1, 1);
    await edit(adminA, app.a2, 2);
    await edit(adminB, app.b1, 3);
    const su = await superuser(h.db);
    await su.query(`update epm.application set state = 'restoring' where app_id = $1`, [app.restoring]);
    await su.query(`update epm.application set state = 'admin_only' where app_id = $1`, [app.adminOnly]);
    await su.end();
  });
  beforeEach(() => { h.blobHooks.beforePut = undefined; });
  afterAll(async () => h?.close());

  it('one application whose export fails does not stop the others, and leaves no files', async () => {
    h.blobHooks.beforePut = (key) => { if (key.startsWith(`${tenantA}/${app.a2}/`)) throw new Error('prefix is on fire'); };
    const r = byApp(await runNightlySnapshots(deps(), { jobKey: h.db.jobKey }));
    expect(r[app.a1]).toMatchObject({ status: 'taken' });
    expect(r[app.b1]).toMatchObject({ status: 'taken' });
    expect(r[app.a2]).toMatchObject({ status: 'failed', error: 'prefix is on fire' });
    const su = await superuser(h.db);
    const rows = (await su.query(`select app_id, status, storage_prefix from epm.snapshot where kind = 'nightly'`)).rows;
    await su.end();
    expect(rows.find((x) => x.app_id === app.a2)).toMatchObject({ status: 'failed' });
    expect(keysUnder(h, `${tenantA}/${app.a2}/`)).toEqual([]);
    expect(rows.filter((x) => x.status === 'complete').map((x) => x.app_id).sort()).toEqual([app.a1, app.b1].sort());
  });

  it('skips applications that are not online, and retries the failed one on the next run', async () => {
    const r = byApp(await runNightlySnapshots(deps(), { jobKey: h.db.jobKey }));
    expect(Object.keys(r).sort()).toEqual([app.a1, app.a2, app.b1].sort());
    expect(r[app.a2]).toMatchObject({ status: 'taken' });
    expect(r[app.a1]).toMatchObject({ status: 'unchanged' });
  });

  it('refuses to list targets inside a tenant or user session, and works with an empty tenant setting', async () => {
    const c = await h.pool.connect();
    try {
      for (const setup of [
        ["select set_config('app.tenant_id', $1, true)", [tenantB]],
        ["select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantA, '00000000-0000-0000-0000-000000000000']],
      ] as [string, unknown[]][]) {
        await c.query('begin');
        await c.query(setup[0], setup[1]);
        await expect(c.query('select * from epm.snapshot_targets($1)', [h.db.jobKey])).rejects.toMatchObject({ code: 'NX422' });
        await c.query('rollback');
      }
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', '', true)");
      const rows = (await c.query('select * from epm.snapshot_targets($1)', [h.db.jobKey])).rows;
      // The function leaves no tenant behind in the caller's session.
      const after = (await c.query("select coalesce(current_setting('app.tenant_id', true), '') as t")).rows[0].t;
      await c.query('rollback');
      expect(rows.map((x) => x.app_id).sort()).toEqual([app.a1, app.a2, app.b1].sort());
      expect(after).toBe('');
    } finally {
      c.release();
    }
  });
});
