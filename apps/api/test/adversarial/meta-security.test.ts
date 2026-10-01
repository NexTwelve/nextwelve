import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, type Harness, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type MetaApp, type MetaEnv, setupMeta } from './meta-helpers.js';

const POV = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' };
const form = (months: string[]) => ({ cube: 'Plan', definition: { pov: POV, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: months } } });

/**
 * Who may restore metadata, read its history and put definition versions back; isolation between
 * tenants and applications; and whether the API's own database role can write or forge history.
 */
describe('adversarial: metadata history and restore security', () => {
  let env: MetaEnv;
  let a: MetaApp;
  let other: MetaApp; // same tenant
  let t: string;
  let users: { power: Api; planner: Api; viewer: Api; rival: Api };
  let rivalApp: string;

  /** A transaction as the API role (epm_app) with the tenant and admin user set. */
  async function asApp<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await env.h.pool.connect();
    try {
      await c.query('begin');
      const user = (await env.su.query<{ user_id: string }>('select user_id from epm.app_user where email = $1', [env.email])).rows[0]!.user_id;
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [env.tenantId, user]);
      return await fn(c);
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }
  const sqlstate = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

  beforeAll(async () => {
    env = await setupMeta('msec');
    a = await env.newApp('Secure');
    other = await env.newApp('Secure Other');
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, form(['Jan'])));
    expectOk(await env.admin.put(`${other.base}/forms/Entry`, form(['Feb'])));
    await env.pause();
    t = await env.now();
    await env.pause();
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, form(['Jan', 'Feb'])));
    users = {
      power: await env.userWithRole('pu@msec.test', a.appId, 'power_user'),
      planner: await env.userWithRole('pl@msec.test', a.appId, 'planner'),
      viewer: await env.userWithRole('vw@msec.test', a.appId, 'viewer'),
      rival: await (async () => {
        await provisionTenant(env.h.db, 'Rival Co', null, 'admin@rival.test');
        const r = await signIn(env.h as unknown as Harness, 'admin@rival.test');
        rivalApp = await seedPlanApp(r, 'Rival Plan');
        return r;
      })(),
    };
  }, 30_000);
  afterAll(async () => env?.close());

  it('metadata restore and metadata history need app_admin', async () => {
    for (const u of [users.power, users.planner, users.viewer]) {
      expect((await u.post(`${a.base}/metadata/restore`, { at: t, dry_run: true })).status).toBe(403);
      expect((await u.post(`${a.base}/metadata/restore`, { at: t })).status).toBe(403);
      expect((await u.get(`${a.base}/metadata/history`)).status).toBe(403);
    }
    expect(expectOk(await env.admin.get(`${a.base}/forms/Entry`)).definition.columns).toEqual([{ dimension: 'Period', members: ['Jan', 'Feb'] }]);
  });

  it('definition history needs power_user; planners and viewers get 403', async () => {
    for (const u of [users.planner, users.viewer]) {
      expect((await u.get(`${a.base}/forms/Entry/history`)).status).toBe(403);
      expect((await u.post(`${a.base}/forms/Entry/history/restore`, { artifact_id: '00000000-0000-4000-8000-000000000000', version: 1 })).status).toBe(403);
    }
    const h = expectOk(await users.power.get(`${a.base}/forms/Entry/history`)).history;
    expect(h).toHaveLength(2);
  });

  it('another tenant sees none of it (404), even with the right ids', async () => {
    const id = expectOk(await env.admin.get(`${a.base}/forms/Entry/history`)).history[0].artifact_id;
    expect((await users.rival.post(`${a.base}/metadata/restore`, { at: t, dry_run: true })).status).toBe(404);
    expect((await users.rival.get(`${a.base}/metadata/history`)).status).toBe(404);
    expect((await users.rival.get(`${a.base}/forms/Entry/history`)).status).toBe(404);
    // Its own application, someone else's history entry.
    expect((await users.rival.post(`/v1/apps/${rivalApp}/forms/Entry/history/restore`, { artifact_id: id, version: 1 })).status).toBe(404);
    const rows = await env.su.query('select 1 from epm.form where app_id = $1', [rivalApp]);
    expect(rows.rowCount).toBe(0);
  });

  it("a history entry of another application, or of the other kind, cannot be restored through this one's route", async () => {
    const otherId = expectOk(await env.admin.get(`${other.base}/forms/Entry/history`)).history[0].artifact_id;
    expect((await env.admin.post(`${a.base}/forms/Entry/history/restore`, { artifact_id: otherId, version: 1 })).status).toBe(404);
    const formId = expectOk(await env.admin.get(`${a.base}/forms/Entry/history`)).history[0].artifact_id;
    expect((await env.admin.post(`${a.base}/reports/Entry/history/restore`, { artifact_id: formId, version: 1 })).status).toBe(404);
    expect((await env.admin.post(`${a.base}/forms/Entry/history/restore`, { artifact_id: formId, version: 2_147_483_648 })).status).toBe(422);
    expect((await env.admin.post(`${a.base}/forms/Entry/history/restore`, { artifact_id: 'not-a-uuid', version: 1 })).status).toBe(422);
  });

  it("a snapshot of another application (same tenant) or another tenant is not a source", async () => {
    const snap = expectOk(await env.admin.post(`${other.base}/snapshots`, {}), 201);
    const r = await a.restore({ snapshot_id: snap.snapshot_id, dry_run: true });
    expect(r.status).toBe(404);
    const rivalSnap = expectOk(await users.rival.post(`/v1/apps/${rivalApp}/snapshots`, {}), 201);
    expect((await a.restore({ snapshot_id: rivalSnap.snapshot_id, dry_run: true })).status).toBe(404);
  });

  it("an application being restored ('restoring') is closed to metadata restore and history (423)", async () => {
    const c = await env.newApp('Secure Restoring');
    await env.su.query(`update epm.application set state = 'restoring' where app_id = $1`, [c.appId]);
    try {
      expect((await c.restore({ at: await env.now(), dry_run: true })).status).toBe(423);
      expect((await env.admin.get(`${c.base}/metadata/history`)).status).toBe(423);
      expect((await env.admin.get(`${c.base}/forms/Entry/history`)).status).toBe(423);
    } finally {
      await env.su.query(`update epm.application set state = 'online' where app_id = $1`, [c.appId]);
    }
  });

  it('the API role cannot write history directly, nor call the function that records deploys', async () => {
    const row = (await env.su.query<{ form_id: string; dim_id: number; member_id: number }>(
      `select f.form_id, m.dim_id, m.member_id from epm.form f, epm.member m join epm.dimension d on d.dim_id = m.dim_id
        where f.app_id = $1 and d.app_id = $1 limit 1`, [a.appId],
    )).rows[0]!;
    const forged = JSON.stringify({ pov: POV, rows: { dimension: 'Account', members: ['Opex'] }, columns: { dimension: 'Period', members: ['Jan'] } });
    expect(await asApp((c) => sqlstate(c.query(
      `insert into epm.artifact_version (tenant_id, app_id, kind, artifact_id, version, name, cube_id, definition, changed_at)
       values ($1, $2, 'form', gen_random_uuid(), 1, 'Injected', 1, $3, now() - interval '1 day')`, [env.tenantId, a.appId, forged])))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query(`update epm.artifact_version set definition = $2 where app_id = $1`, [a.appId, forged])))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query(`delete from epm.artifact_version where app_id = $1`, [a.appId])))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query(
      `insert into epm.member_version (tenant_id, app_id, dim_id, member_id, name, sort_order, agg_op, from_rev)
       values ($1, $2, $3, 999999, 'Injected', 1, '+', 1)`, [env.tenantId, a.appId, row.dim_id])))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query(`update epm.member_version set to_rev = 1 where app_id = $1`, [a.appId])))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query(`insert into epm.metadata_rev (tenant_id, app_id, metadata_rev) values ($1, $2, 999)`, [env.tenantId, a.appId])))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query(`update epm.metadata_rev set deployed_at = now() - interval '1 year' where app_id = $1`, [a.appId])))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query('select epm.record_metadata_rev($1, 999, null, null)', [a.appId])))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query('truncate epm.form')))).toBe('42501');
    expect(await asApp((c) => sqlstate(c.query('alter table epm.form disable trigger form_history')))).toBe('42501');
    // Writing a definition row directly still leaves history (triggers), with the version moved past history.
    const v = await asApp(async (c) => {
      await c.query(`update epm.form set version = 1, definition = $2 where form_id = $1`, [row.form_id, forged]);
      return (await c.query<{ version: number; n: number }>(
        `select (select version from epm.form where form_id = $1) as version,
                (select count(*)::int from epm.artifact_version where artifact_id = $1) as n`, [row.form_id])).rows[0]!;
    });
    expect(v).toEqual({ version: 3, n: 3 });
  });

  it('history rows are confined to their tenant (row-level security), also for the API role', async () => {
    const seen = await asApp(async (c) => (await c.query<{ n: number }>('select count(*)::int as n from epm.member_version where tenant_id <> $1', [env.tenantId])).rows[0]!.n);
    expect(seen).toBe(0);
    const total = (await env.su.query<{ n: number }>('select count(*)::int as n from epm.member_version where tenant_id <> $1', [env.tenantId])).rows[0]!.n;
    expect(total).toBeGreaterThan(0);
  });

  it('FINDING: access grants a snapshot restore puts back (write access for a user) leave no trace in the security log', async () => {
    const c = await env.newApp('Secure Grants');
    await env.userWithRole('eve@msec.test', c.appId, 'planner');
    await c.put('Entity', [{ name: 'North', parent: 'Total Company' }]);
    await c.deploy();
    expectOk(await env.admin.put(`${c.base}/grants`, {
      grants: [{ principal: { user: 'eve@msec.test' }, dimension: 'Entity', member: 'North', scope: 'member', access: 'write' }],
    }));
    const snap = expectOk(await env.admin.post(`${c.base}/snapshots`, {}), 201);
    await c.del('Entity', 'North');
    await c.deploy();
    const since = (await env.su.query<{ id: number }>('select coalesce(max(event_id), 0)::int as id from epm.security_event')).rows[0]!.id;

    const r = expectOk(await c.restore({ snapshot_id: snap.snapshot_id, dimensions: ['Entity'], definitions: false }));
    expect(r.members.grants_restored).toBe(1);
    const events = (await env.su.query<{ event_type: string; detail: any }>(
      'select event_type, detail from epm.security_event where app_id = $1 and event_id > $2', [c.appId, since])).rows;
    // PUT /grants logs grants_changed, and so does a restore into a new application; a grant put back
    // here must be just as visible (its own event, or at least counted in the metadata_restored event).
    const logged = events.some((e) => e.event_type === 'grants_changed'
      || Number(e.detail?.grants_restored ?? e.detail?.members?.grants_restored ?? 0) > 0);
    expect(logged, JSON.stringify(events)).toBe(true);
  });
});
