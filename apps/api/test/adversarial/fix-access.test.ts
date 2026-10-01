import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Second pass on restore-to-new-app access: 'none' (default) copies no roles or grants; 'copy'
 * re-creates them, reports each one and logs role_granted / grants_changed - including for users
 * disabled since the snapshot and for groups. Only service admins may restore into a new app.
 */
describe('fix: what access a restored copy starts with', () => {
  let h: Harness;
  let su: pg.Client;
  let admin: Api;
  let appAdmin: Api;
  let alice: Api;
  let base: string;
  let snapId: string;
  const roles = async (appId: string) =>
    (await su.query('select u.email, r.role from epm.user_role r join epm.app_user u on u.user_id = r.user_id where r.app_id = $1 order by 1', [appId])).rows;
  const counts = async (appId: string) =>
    (await su.query(
      `select (select count(*)::int from epm.access_grant where app_id = $1) as grants,
              (select count(*)::int from epm.effective_access where app_id = $1) as effective,
              (select count(*)::int from epm.security_event where app_id = $1 and event_type = 'role_granted') as role_events,
              (select count(*)::int from epm.security_event where app_id = $1 and event_type = 'grants_changed') as grant_events`,
      [appId],
    )).rows[0];

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    await provisionTenant(h.db, 'Access Co', null, 'admin@ac.test');
    admin = await signIn(h, 'admin@ac.test');
    base = `/v1/apps/${await seedPlanApp(admin, 'Access Plan')}`;
    for (const email of ['alice@ac.test', 'bob@ac.test', 'carol@ac.test', 'appadmin@ac.test']) expectOk(await admin.post('/v1/users', { email }), 201);
    expectOk(await admin.post('/v1/groups', { name: 'East Team' }), 201);
    expectOk(await admin.put('/v1/groups/East Team/members', { emails: ['carol@ac.test'] }));
    expectOk(await admin.post(`${base}/roles`, { email: 'alice@ac.test', role: 'planner' }));
    expectOk(await admin.post(`${base}/roles`, { email: 'bob@ac.test', role: 'viewer' }));
    expectOk(await admin.post(`${base}/roles`, { email: 'carol@ac.test', role: 'planner' }));
    expectOk(await admin.post(`${base}/roles`, { email: 'appadmin@ac.test', role: 'app_admin' }));
    expectOk(await admin.put(`${base}/grants`, { grants: [
      { principal: { user: 'alice@ac.test' }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'write' },
      { principal: { user: 'bob@ac.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'read' },
      { principal: { group: 'East Team' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' },
    ] }));
    alice = await signIn(h, 'alice@ac.test');
    appAdmin = await signIn(h, 'appadmin@ac.test');
    await signIn(h, 'bob@ac.test');
    snapId = expectOk(await admin.post(`${base}/snapshots`, {}), 201).snapshot_id;
    expectOk(await admin.patch('/v1/users/bob@ac.test', { status: 'disabled' })); // after the snapshot
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  it('an app_admin of the source who is not a service admin cannot restore into a new application', async () => {
    const r = await appAdmin.post(`${base}/snapshots/${snapId}/restore`, { target: 'new_app', name: 'Sneaky Copy' });
    expect(r.status).toBe(403);
    expect((await su.query("select count(*)::int as n from epm.application where name = 'Sneaky Copy'")).rows[0].n).toBe(0);
  });

  it("access 'none' (the default): no roles, grants or effective access; former users cannot see the copy", async () => {
    const copy = expectOk(await admin.post(`${base}/snapshots/${snapId}/restore`, { target: 'new_app', name: 'No Access Copy' }), 201);
    expect({ access: copy.access, granted: copy.roles_granted, copied: copy.grants_copied, inSnapshot: copy.access_in_snapshot })
      .toEqual({ access: 'none', granted: [], copied: 0, inSnapshot: { roles: 4, grants: 3 } });
    expect(await roles(copy.app_id)).toEqual([]);
    expect(await counts(copy.app_id)).toEqual({ grants: 0, effective: 0, role_events: 0, grant_events: 0 });
    expect(expectOk(await alice.get('/v1/apps')).apps.map((a: any) => a.app_id)).not.toContain(copy.app_id);
    expect((await alice.post(`/v1/apps/${copy.app_id}/grid/read`, planGrid())).status).toBe(403);
  });

  it("access 'copy': every role and grant comes back, each reported and logged, disabled users included and named", async () => {
    const copy = expectOk(await admin.post(`${base}/snapshots/${snapId}/restore`, { target: 'new_app', name: 'Full Access Copy', access: 'copy' }), 201);
    const granted = [...copy.roles_granted].sort((a: any, b: any) => a.email.localeCompare(b.email));
    expect(granted).toEqual([
      { email: 'alice@ac.test', role: 'planner' }, { email: 'appadmin@ac.test', role: 'app_admin' },
      { email: 'bob@ac.test', role: 'viewer' }, { email: 'carol@ac.test', role: 'planner' },
    ]);
    expect(copy.grants_copied).toBe(3);
    expect(await roles(copy.app_id)).toEqual(granted);
    const c = await counts(copy.app_id);
    expect({ role_events: c.role_events, grant_events: c.grant_events }).toEqual({ role_events: 4, grant_events: 1 });
    // Bob is disabled: he holds the role but has no effective access until re-enabled.
    const eff = await su.query(
      `select u.email, count(*)::int as n from epm.effective_access e join epm.app_user u on u.user_id = e.user_id where e.app_id = $1 group by 1 order by 1`, [copy.app_id]);
    expect(eff.rows.map((r) => r.email)).toEqual(['alice@ac.test', 'carol@ac.test']);
    const v = expectOk(await alice.post(`/v1/apps/${copy.app_id}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'West' })));
    expect(v.values.length).toBeGreaterThan(0);
  });
});
