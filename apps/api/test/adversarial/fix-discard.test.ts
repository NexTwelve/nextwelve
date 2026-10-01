import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, asUser, buildBigApp, createAbuseHarness, superuser } from './abuse-helpers.js';

/**
 * Second pass on the fix for half-built restores: epm.discard_restoring_app and the new-app
 * loader's clean-up. Who may discard what, what a discard leaves behind, and whether a failed
 * restore really leaves nothing behind at every phase - including when the failure is the
 * restoring user's own session.
 */
const HISTORY = ['change_txn', 'cell_audit', 'metadata_change', 'security_event', 'snapshot'];

describe('fix: discarding a restore that failed part way', () => {
  let h: AbuseHarness;
  let su: pg.Client;
  let admin: Api;
  let admin2: Api; // a second service admin of the same tenant
  let tenantId: string;
  let otherTenant: string;
  let srcApp: string;
  let bigSnap: any; // a snapshot with 20,160 cells: the loader needs two batches
  const restoringSql = "select set_config('app.restoring_app', $1, true)";

  /** Rows that still name the application in any table that is not history. */
  async function leftovers(appId: string): Promise<Record<string, number>> {
    const tables = (await su.query<{ relname: string }>(
      `select c.relname from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'epm' and a.attname = 'app_id' and not a.attisdropped and c.relkind in ('r', 'p') and not c.relispartition`,
    )).rows.map((r) => r.relname).filter((t) => !HISTORY.includes(t));
    const out: Record<string, number> = {};
    for (const t of tables) {
      const n = Number((await su.query(`select count(*)::int as n from epm.${t} where app_id = $1`, [appId])).rows[0].n);
      if (n) out[t] = n;
    }
    const orphanClosure = Number((await su.query(
      'select count(*)::int as n from epm.member_ancestor ma where not exists (select 1 from epm.dimension d where d.dim_id = ma.dim_id)',
    )).rows[0].n);
    if (orphanClosure) out.member_ancestor_orphans = orphanClosure;
    return out;
  }

  const restoringApps = async () =>
    (await su.query<{ app_id: string; name: string }>("select app_id, name from epm.application where state = 'restoring'")).rows;

  beforeAll(async () => {
    h = await createAbuseHarness();
    su = await superuser(h.db);
    tenantId = await provisionTenant(h.db, 'Discard Co', null, 'admin@dc.test');
    otherTenant = await provisionTenant(h.db, 'Other Co', null, 'admin@oc.test');
    admin = await signIn(h as any, 'admin@dc.test');
    await signIn(h as any, 'admin@oc.test');
    for (const email of ['admin2@dc.test', 'admin3@dc.test', 'appadmin@dc.test']) expectOk(await admin.post('/v1/users', { email }), 201);
    await su.query(
      `insert into epm.user_role (tenant_id, user_id, app_id, role)
       select tenant_id, user_id, null, 'service_admin' from epm.app_user where email in ('admin2@dc.test', 'admin3@dc.test')`,
    );
    admin2 = await signIn(h as any, 'admin2@dc.test');
    await signIn(h as any, 'admin3@dc.test');
    await signIn(h as any, 'appadmin@dc.test');

    srcApp = await seedPlanApp(admin, 'Big Plan');
    const src = `/v1/apps/${srcApp}`;
    expectOk(await admin.post(`${src}/roles`, { email: 'appadmin@dc.test', role: 'app_admin' }));
    // Things that hang off an application: a form, an import format, a dataset.
    expectOk(await admin.put(`${src}/forms/Entry`, { cube: 'Plan', definition: {
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Product: 'Widgets' },
      page: { Entity: ['East', 'West'] },
      rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] },
    } }));
    await buildBigApp(h, admin, tenantId, 'admin@dc.test', srcApp, 560);
    bigSnap = expectOk(await admin.post(`${src}/snapshots`, {}), 201);
    expect(bigSnap.fact_count).toBe(20_160);
  }, 40_000);
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  it('only a service admin of the same tenant may discard, and only an application that is being restored', async () => {
    const make = async (state: string, name: string) =>
      (await su.query<{ app_id: string }>(`insert into epm.application (tenant_id, name, state) values ($1, $2, $3) returning app_id`, [tenantId, name, state])).rows[0]!.app_id;
    const restoring = await make('restoring', 'Half Built');
    const online = await make('online', 'Live One');
    await su.query(`insert into epm.user_role (tenant_id, user_id, app_id, role) select tenant_id, user_id, $1, 'app_admin' from epm.app_user where email = 'appadmin@dc.test'`, [restoring]);
    const discard = async (t: string, email: string, appId: string) =>
      asUser(h.pool, t, email, (c) => c.query('select epm.discard_restoring_app($1)', [appId])).then(() => 'ok', (e: any) => e.code);

    expect(await discard(tenantId, 'appadmin@dc.test', restoring)).toBe('NX403'); // app_admin of that very app
    expect(await discard(otherTenant, 'admin@oc.test', restoring)).toBe('NX404'); // another tenant's service admin
    expect(await discard(tenantId, 'admin@dc.test', online)).toBe('NX409'); // a live application
    expect((await su.query('select state from epm.application where app_id = any($1::uuid[]) order by state', [[restoring, online]])).rows.map((r) => r.state))
      .toEqual(['online', 'restoring']);
    expect(await discard(tenantId, 'admin@dc.test', restoring)).toBe('ok');
    expect(await leftovers(restoring)).toEqual({});
  });

  it('a failure while the second batch of facts loads leaves nothing behind, and other chains still verify', async () => {
    let newApp: string | null = null;
    let batches = 0;
    h.queryHooks.push((sql, params) => {
      if (sql !== restoringSql) return;
      newApp = String(params![0]);
      if (++batches === 2) throw new Error('injected: storage stalled during the second batch');
    });
    try {
      const r = await admin.post(`/v1/apps/${srcApp}/snapshots/${bigSnap.snapshot_id}/restore`, { target: 'new_app', name: 'Batch Failure' });
      expect(r.status).toBe(500);
    } finally {
      h.queryHooks.length = 0;
    }
    expect(batches).toBe(2);
    expect(newApp).not.toBeNull();
    expect(await restoringApps()).toEqual([]);
    expect(await leftovers(newApp!)).toEqual({});
    const ev = await su.query("select detail->>'name' as name from epm.security_event where app_id = $1 and event_type = 'restore_discarded'", [newApp]);
    expect(ev.rows.map((r) => r.name)).toEqual(['Batch Failure']);
    expect(expectOk(await admin.post(`/v1/apps/${srcApp}/audit/verify`)).ok).toBe(true);
  });

  it('a failure when the application is switched online leaves nothing behind', async () => {
    let newApp: string | null = null;
    h.queryHooks.push((sql, params) => {
      if (sql === restoringSql) newApp = String(params![0]);
      if (sql.startsWith("update epm.application set state = 'online'")) throw new Error('injected: connection reset at the last step');
    });
    try {
      const r = await admin.post(`/v1/apps/${srcApp}/snapshots/${bigSnap.snapshot_id}/restore`, { target: 'new_app', name: 'Online Failure', access: 'copy' });
      expect(r.status).toBe(500);
    } finally {
      h.queryHooks.length = 0;
    }
    expect(await restoringApps()).toEqual([]);
    expect(await leftovers(newApp!)).toEqual({});
  });

  it('FINDING: a restore whose user is disabled part way leaves no half-built application behind', async () => {
    // admin3 restores; admin2 disables admin3 (an ordinary admin action) while the facts are loading.
    const admin3 = await signIn(h as any, 'admin3@dc.test');
    let newApp: string | null = null;
    let batches = 0;
    let disabling = false;
    h.queryHooks.push(async (sql, params) => {
      if (sql !== restoringSql || disabling) return;
      newApp = String(params![0]);
      if (++batches === 2) {
        disabling = true;
        expectOk(await admin2.patch('/v1/users/admin3@dc.test', { status: 'disabled' }));
      }
    });
    let status = 0;
    try {
      status = (await admin3.post(`/v1/apps/${srcApp}/snapshots/${bigSnap.snapshot_id}/restore`, { target: 'new_app', name: 'Disabled Mid Restore' })).status;
    } finally {
      h.queryHooks.length = 0;
    }
    expect(status).toBe(401);
    const stuck = (await su.query<{ state: string; facts: number }>(
      `select a.state, (select count(*)::int from epm.fact f where f.app_id = a.app_id) as facts from epm.application a where a.app_id = $1`,
      [newApp],
    )).rows[0] ?? null;
    // Correct: the half-built copy is removed like any other failed restore. (Nothing in the API can
    // remove an application, and nothing sweeps old 'restoring' ones, so a leftover stays forever.)
    expect(stuck, 'half-built copy left behind').toBeNull();
    // ... and it does not lock its name for the next attempt.
    expect((await admin2.get('/v1/apps')).body.apps.filter((a: any) => a.state === 'restoring').map((a: any) => a.name)).toEqual([]);
  });

  it('the source application and its history are untouched by all of the above', async () => {
    const g = expectOk(await admin.post(`/v1/apps/${srcApp}/grid/read`, planGrid()));
    expect(g.values.length).toBeGreaterThan(0);
    expect(expectOk(await admin.post(`/v1/apps/${srcApp}/audit/verify`)).ok).toBe(true);
  });
});
