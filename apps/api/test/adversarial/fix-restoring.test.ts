import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, asUser, createAbuseHarness, superuser } from './abuse-helpers.js';

/**
 * Second pass on the 'restoring' state: while a copy is being loaded, only its loader may write to
 * it (apply_changes checks app.restoring_app). What else can reach a copy mid-restore, and can the
 * loader's marker leak to anyone else?
 */
const RESTORING_SQL = "select set_config('app.restoring_app', $1, true)";

describe('fix: an application in the restoring state', () => {
  let h: AbuseHarness;
  let su: pg.Client;
  let admin: Api;
  let other: Api; // another service admin of the tenant, working at the same time
  let tenantId: string;
  let src: string;
  let snap: any;

  async function edit(b: string, v: number) {
    const g = expectOk(await admin.post(`${b}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[2][0] = v;
    expectOk(await admin.post(`${b}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  }

  /** Restore `snap` into a new app; `probe` runs once, mid-load, with the copy's id. */
  async function restoreWithProbe(name: string, probe: (appId: string) => Promise<void>) {
    let fired = false;
    let newApp = '';
    h.queryHooks.push(async (sql, params) => {
      if (sql !== RESTORING_SQL || fired) return;
      fired = true;
      newApp = String(params![0]);
      await probe(newApp);
    });
    try {
      const r = await admin.post(`/v1/apps/${src}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name });
      return { r, newApp };
    } finally {
      h.queryHooks.length = 0;
    }
  }

  beforeAll(async () => {
    h = await createAbuseHarness();
    su = await superuser(h.db);
    tenantId = await provisionTenant(h.db, 'Restoring Co', null, 'admin@rs.test');
    admin = await signIn(h as any, 'admin@rs.test');
    expectOk(await admin.post('/v1/users', { email: 'other@rs.test' }), 201);
    expectOk(await admin.post('/v1/users', { email: 'pat@rs.test' }), 201);
    await su.query(`insert into epm.user_role (tenant_id, user_id, app_id, role) select tenant_id, user_id, null, 'service_admin' from epm.app_user where email = 'other@rs.test'`);
    other = await signIn(h as any, 'other@rs.test');
    await signIn(h as any, 'pat@rs.test');
    src = await seedPlanApp(admin, 'Source');
    await edit(`/v1/apps/${src}`, 100);
    snap = expectOk(await admin.post(`/v1/apps/${src}/snapshots`, {}), 201);
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  it('writes to the data of a copy mid-restore are refused on every path but the loader (grid, undo, point in time, raw restore source)', async () => {
    const out: Record<string, unknown> = {};
    const { r, newApp } = await restoreWithProbe('Data Probe', async (appId) => {
      const b = `/v1/apps/${appId}`;
      const g = await other.post(`${b}/grid/read`, planGrid());
      if (g.status === 200) {
        const values = g.body.values.map((row: unknown[]) => [...row]);
        values[2][0] = 999;
        out.grid = (await other.post(`${b}/grid/submit`, { grid_session_id: g.body.grid_session_id, values })).status;
      } else out.grid = g.status;
      // (The copy has no history yet, so a point-in-time restore has nothing to do; it must not write.)
      const pit = await other.post(`${b}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', at: new Date().toISOString() });
      out.pit = pit.status === 200 ? (pit.body.txn_id === null ? 'nothing written' : 'wrote') : pit.status;
      // A service admin's own transaction, source 'restore', with the marker naming another application or empty.
      const raw = async (marker: string) => asUser(h.pool, tenantId, 'other@rs.test', async (c) => {
        await c.query("select set_config('app.restoring_app', $1, true)", [marker]);
        await c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: appId, source: 'restore', cells: [] })]);
      }).then(() => 'ok', (e: any) => e.code);
      out.rawOther = await raw(src);
      out.rawEmpty = await raw('');
      out.rawApi = await asUser(h.pool, tenantId, 'other@rs.test', (c) =>
        c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: appId, source: 'api', cells: [] })])).then(() => 'ok', (e: any) => e.code);
    });
    expect(r.status).toBe(201);
    expect(['nothing written', 423]).toContain(out.pit);
    expect({ ...out, pit: undefined }).toEqual({ grid: 423, pit: undefined, rawOther: 'NX423', rawEmpty: 'NX423', rawApi: 'NX423' });
    // The copy holds exactly the snapshot's data.
    const v = expectOk(await admin.post(`/v1/apps/${newApp}/grid/read`, planGrid())).values;
    expect(v[2][0]).toBe(100);
  });

  it('the loader\'s marker never outlives its transaction on a pooled connection', async () => {
    const clients = await Promise.all(Array.from({ length: 12 }, () => h.pool.connect()));
    try {
      const vals = await Promise.all(clients.map(async (c) => (await c.query("select coalesce(current_setting('app.restoring_app', true), '') as v")).rows[0].v));
      expect(vals.filter((v) => v !== '')).toEqual([]);
    } finally {
      for (const c of clients) c.release();
    }
  });

  it('FINDING: a snapshot of a copy that is still being restored is refused (it would be recorded complete with part of the data)', async () => {
    let probeSnap: { status: number; body: any } | null = null;
    const { r, newApp } = await restoreWithProbe('Snapshot Probe', async (appId) => {
      probeSnap = await other.post(`/v1/apps/${appId}/snapshots`, { comment: 'taken mid-restore' });
    });
    expect(r.status).toBe(201);
    const rows = (await su.query<{ status: string; fact_count: number }>(
      `select status, fact_count from epm.snapshot where app_id = $1 and comment = 'taken mid-restore'`, [newApp],
    )).rows;
    const facts = Number((await su.query('select count(*)::int as n from epm.fact where app_id = $1', [newApp])).rows[0].n);
    expect({ status: probeSnap!.status, snapshots: rows }, `copy holds ${facts} facts`).toEqual({ status: expect.any(Number), snapshots: [] });
    expect([409, 423]).toContain(probeSnap!.status);
  });

  it('FINDING: ... and such a snapshot does not outlive the discard of a restore that then fails', async () => {
    let failedApp = '';
    h.queryHooks.push((sql) => {
      if (sql.startsWith("update epm.application set state = 'online'")) throw new Error('injected: the last step fails');
    });
    try {
      const { r, newApp } = await restoreWithProbe('Doomed Copy', async (appId) => {
        await other.post(`/v1/apps/${appId}/snapshots`, { comment: 'taken from a doomed copy' });
      });
      failedApp = newApp;
      expect(r.status).toBe(500);
    } finally {
      h.queryHooks.length = 0;
    }
    expect((await su.query('select count(*)::int as n from epm.application where app_id = $1', [failedApp])).rows[0].n).toBe(0);
    const orphans = (await su.query<{ snapshot_id: string; status: string }>(
      `select snapshot_id, status from epm.snapshot where app_id = $1`, [failedApp])).rows;
    // A complete snapshot of a copy that never existed: a service admin can still restore it into a new application.
    let resurrected: number | null = null;
    if (orphans[0]) resurrected = (await admin.post(`/v1/apps/${failedApp}/snapshots/${orphans[0].snapshot_id}/restore`, { target: 'new_app', name: 'Resurrected' })).status;
    expect({ orphans: orphans.map((o) => o.status), resurrected }).toEqual({ orphans: [], resurrected: null });
  });

  it('FINDING: metadata, roles and grants of a copy mid-restore are read-only too (it is "read-only to everyone but this loader")', async () => {
    const out: Record<string, number> = {};
    const { r, newApp } = await restoreWithProbe('Metadata Probe', async (appId) => {
      const b = `/v1/apps/${appId}`;
      out.members = (await other.put(`${b}/dimensions/Entity/members`, { members: [{ name: 'Probe Region', parent: 'Total Company' }] })).status;
      out.deploy = (await other.post(`${b}/deploy`)).status;
      out.role = (await other.post(`${b}/roles`, { email: 'pat@rs.test', role: 'planner' })).status;
      out.window = (await other.put(`${b}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', locked: true })).status;
    });
    expect(r.status).toBe(201);
    const extra = (await su.query(
      `select (select count(*)::int from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1 and m.name = 'Probe Region') as members,
              (select count(*)::int from epm.user_role where app_id = $1) as roles,
              (select count(*)::int from epm.plan_window where app_id = $1) as windows`,
      [newApp],
    )).rows[0];
    expect({ out, extra }).toEqual({
      out: { members: expect.any(Number), deploy: expect.any(Number), role: expect.any(Number), window: expect.any(Number) },
      extra: { members: 0, roles: 0, windows: 0 },
    });
    for (const s of Object.values(out)) expect([409, 423]).toContain(s);
  });

  it('a copy that finished restoring takes writes again', async () => {
    const copy = expectOk(await admin.post(`/v1/apps/${src}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Finished' }), 201);
    const b = `/v1/apps/${copy.app_id}`;
    const g = expectOk(await admin.post(`${b}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'West' })));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[2][0] = 7;
    expectOk(await admin.post(`${b}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
    expect(expectOk(await admin.post(`${b}/audit/verify`)).ok).toBe(true);
  });
});
