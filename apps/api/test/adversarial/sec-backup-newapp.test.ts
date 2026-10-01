import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Adversarial: what security a restore carries. A snapshot holds the roles and member grants
 * of its moment; access removed since must not come back silently through a restore, and any
 * access a restore does hand out must be on the security record.
 */
const R = { REV: 2 };
const C = { JAN: 0 };

describe('restore into a new application: roles and grants', () => {
  let h: Harness;
  let su: pg.Client;
  let admin: Api;
  let mallory: Api; // app_admin of X when the snapshot was taken; removed afterwards
  let pat: Api; // planner with West write when the snapshot was taken; narrowed afterwards
  let appX: string;
  let snapId: string;
  let newApp: any;
  let copied: any; // a copy made with access: 'copy'
  const X = () => `/v1/apps/${appX}`;

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    await provisionTenant(h.db, 'Roles Co', null, 'admin@roles.test');
    admin = await signIn(h, 'admin@roles.test');
    appX = await seedPlanApp(admin, 'X');
    for (const [email, role] of [['mallory@roles.test', 'app_admin'], ['pat@roles.test', 'planner']] as const) {
      expectOk(await admin.post('/v1/users', { email }), 201);
      expectOk(await admin.post(`${X()}/roles`, { email, role }));
    }
    expectOk(await admin.put(`${X()}/grants`, { grants: [{ principal: { user: 'pat@roles.test' }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'write' }] }));
    mallory = await signIn(h, 'mallory@roles.test');
    pat = await signIn(h, 'pat@roles.test');
    const g = expectOk(await admin.post(`${X()}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[R.REV][C.JAN] = 42;
    expectOk(await admin.post(`${X()}/grid/submit`, { grid_session_id: g.grid_session_id, values }));

    snapId = expectOk(await admin.post(`${X()}/snapshots`, {}), 201).snapshot_id;

    // After the snapshot: Mallory is removed from X; Pat is narrowed to East (West is now denied).
    expectOk(await admin.del(`${X()}/roles/mallory@roles.test`));
    expectOk(await admin.put(`${X()}/grants`, { replace: true, grants: [{ principal: { user: 'pat@roles.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' }] }));
    expect((await mallory.get(`${X()}/snapshots`)).status).toBe(403);
    expect((await pat.post(`${X()}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'West' }))).status).toBe(403);
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  it('an in-place restore of the old snapshot does not bring back removed roles or grants', async () => {
    expectOk(await admin.post(`${X()}/snapshots/${snapId}/restore`, { target: 'in_place' }));
    expect((await mallory.get(`${X()}/snapshots`)).status).toBe(403);
    expect((await pat.post(`${X()}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'West' }))).status).toBe(403);
  });

  it('restore into a new app does not silently re-grant app_admin to a user removed since the snapshot', async () => {
    newApp = expectOk(await admin.post(`${X()}/snapshots/${snapId}/restore`, { target: 'new_app', name: 'X Copy' }), 201);
    const nb = `/v1/apps/${newApp.app_id}`;
    const res = await mallory.get(`${nb}/snapshots`);
    const role = (await su.query<{ role: string }>(
      `select r.role from epm.user_role r join epm.app_user u on u.user_id = r.user_id where u.email = 'mallory@roles.test' and r.app_id = $1`,
      [newApp.app_id],
    )).rows[0]?.role ?? null;
    // Correct behavior: either no role, or the restore at least told the restoring admin it granted one.
    const disclosed = JSON.stringify(newApp).includes('mallory@roles.test');
    expect({ role, status: res.status, disclosed }, 'removed app_admin regained access to the copy').toEqual(
      role === null ? { role: null, status: 403, disclosed } : { role, status: res.status, disclosed: true },
    );
  });

  it('restore into a new app does not silently widen a member grant that was narrowed since the snapshot', async () => {
    const nb = `/v1/apps/${newApp.app_id}`;
    const west = await pat.post(`${nb}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'West' }));
    const disclosed = JSON.stringify(newApp).includes('pat@roles.test');
    expect({ status: west.status, disclosed }, 'narrowed planner regained West in the copy').toEqual(
      west.status === 403 ? { status: 403, disclosed } : { status: west.status, disclosed: true },
    );
  });

  it('copying access is an explicit choice, and every role and grant it re-creates is listed in the response', async () => {
    expect(newApp).toMatchObject({ access: 'none', roles_granted: [], grants_copied: 0, access_in_snapshot: { roles: 2, grants: 1 } });
    copied = expectOk(await admin.post(`${X()}/snapshots/${snapId}/restore`, { target: 'new_app', name: 'X Copy With Access', access: 'copy' }), 201);
    expect(copied.roles_granted).toEqual(expect.arrayContaining([
      { email: 'mallory@roles.test', role: 'app_admin' }, { email: 'pat@roles.test', role: 'planner' },
    ]));
    expect(copied.grants_copied).toBe(1);
  });

  it("a copy still 'restoring' (mid-load or after a failed load) takes no writes from the admins copied into it", async () => {
    // Put the copy back into the 'restoring' state and let a copied app_admin try restore-sourced writes.
    const newApp = copied;
    const nb = `/v1/apps/${newApp.app_id}`;
    const role = (await su.query<{ n: number }>(
      `select count(*)::int as n from epm.user_role r join epm.app_user u on u.user_id = r.user_id
        where u.email = 'mallory@roles.test' and r.app_id = $1 and r.role = 'app_admin'`, [newApp.app_id])).rows[0]!.n;
    expect(role).toBe(1); // (the finding above)
    const before = (await su.query('select value from epm.fact where app_id = $1 order by value', [newApp.app_id])).rows;
    await su.query(`update epm.application set state = 'restoring' where app_id = $1`, [newApp.app_id]);
    try {
      const pit = await mallory.post(`${nb}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', at: '2000-01-01T00:00:00Z' });
      expect(pit.status, `point-in-time restore into a restoring app: ${JSON.stringify(pit.body)}`).toBe(423);
      const after = (await su.query('select value from epm.fact where app_id = $1 order by value', [newApp.app_id])).rows;
      expect(after).toEqual(before);
    } finally {
      await su.query(`update epm.application set state = 'online' where app_id = $1`, [newApp.app_id]);
    }
  });

  it('puts every role and grant a restore creates on the security record of the new application', async () => {
    const newApp = copied;
    const roles = (await su.query<{ email: string; role: string }>(
      `select u.email, r.role from epm.user_role r join epm.app_user u on u.user_id = r.user_id where r.app_id = $1 order by u.email`,
      [newApp.app_id],
    )).rows;
    expect(roles.length).toBeGreaterThan(0);
    const events = (await su.query<{ event_type: string; app_id: string; detail: any }>(
      `select event_type, app_id, detail from epm.security_event
        where app_id = $1 or detail->>'new_app_id' = $1::text order by event_id`,
      [newApp.app_id],
    )).rows;
    const text = JSON.stringify(events);
    // Each granted role is recorded (as the roles route does with 'role_granted'), naming the user.
    for (const r of roles) expect(text, `no security event records ${r.email} getting ${r.role} in the copy`).toContain(r.email);
  });
});
