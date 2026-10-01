import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { asUser } from './abuse-helpers.js';

/**
 * Second pass on epm.add_version_leaf (a deployed top-level Version leaf, without a full deploy):
 * who may call it on what, name collisions, concurrent calls, security on a secured Version
 * dimension, and whether the tree it leaves is the one a later full deploy would build.
 */
describe('fix: adding a version for a point-in-time restore', () => {
  let h: Harness;
  let su: pg.Client;
  let admin: Api;
  let pat: Api; // planner
  let tenantId: string;
  let otherTenant: string;
  let appId: string;
  let base: string;
  const dimId = async (app: string, name: string) =>
    (await su.query<{ dim_id: number }>('select dim_id from epm.dimension where app_id = $1 and name = $2', [app, name])).rows[0]!.dim_id;
  const add = (t: string, email: string, dim: number, name: string) =>
    asUser(h.pool, t, email, (c) => c.query('select epm.add_version_leaf($1, $2) as id', [dim, name])).then((r) => r.rows[0].id as number, (e: any) => e.code as string);
  const versionTree = async (app: string) =>
    (await su.query(
      `select m.name, m.is_leaf, m.tree_ordinal, m.leaf_ordinal, m.parent_id is null as top,
              (select array_agg(a.ancestor_id || ':' || a.depth || ':' || a.sign || ':' || a.descendant_is_leaf order by a.ancestor_id)
                 from epm.member_ancestor a where a.descendant_id = m.member_id) as closure
         from epm.member m join epm.dimension d on d.dim_id = m.dim_id
        where d.app_id = $1 and d.dim_type = 'version' order by m.member_id`,
      [app],
    )).rows;

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    tenantId = await provisionTenant(h.db, 'Version Co', null, 'admin@vc.test');
    otherTenant = await provisionTenant(h.db, 'Rival Co', null, 'admin@rival.test');
    admin = await signIn(h, 'admin@vc.test');
    await signIn(h, 'admin@rival.test');
    appId = await seedPlanApp(admin, 'Version Plan');
    base = `/v1/apps/${appId}`;
    expectOk(await admin.post('/v1/users', { email: 'pat@vc.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'pat@vc.test', role: 'planner' }));
    pat = await signIn(h, 'pat@vc.test');
    // A Version hierarchy and some history to restore.
    expectOk(await admin.put(`${base}/dimensions/Version/members`, { members: [{ name: 'All Versions', sort_order: 1 }, { name: 'Working', parent: 'All Versions' }, { name: 'Final', parent: 'All Versions' }, { name: 'Scratch', sort_order: 500 }] }));
    expectOk(await admin.post(`${base}/deploy`));
    expectOk(await admin.put(`${base}/grants`, { grants: [{ principal: { user: 'pat@vc.test' }, dimension: 'Entity', member: 'Total Company', scope: 'idescendants', access: 'write' }] }));
    for (const v of [10, 20]) {
      const g = expectOk(await admin.post(`${base}/grid/read`, planGrid()));
      const values = g.values.map((row: unknown[]) => [...row]);
      values[2][0] = v;
      expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
    }
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  it('refuses the wrong dimension type, look-alike names, planners and other tenants', async () => {
    const ver = await dimId(appId, 'Version');
    expect({
      entity: await add(tenantId, 'admin@vc.test', await dimId(appId, 'Entity'), 'Q'),
      lookalike: await add(tenantId, 'admin@vc.test', ver, 'wORKING'),
      planner: await add(tenantId, 'pat@vc.test', ver, 'Pat Version'),
      rival: await add(otherTenant, 'admin@rival.test', ver, 'Rival Version'),
    }).toEqual({ entity: 'NX422', lookalike: 'NX409', planner: 'NX403', rival: 'NX404' });
    expect((await su.query("select count(*)::int as n from epm.member where name in ('Q', 'Pat Version', 'Rival Version')")).rows[0].n).toBe(0);
  });

  it('two restores creating different versions at once both land, and a later full deploy builds the very same tree', async () => {
    const txns = expectOk(await admin.get(`${base}/txns`)).txns;
    const first = txns[txns.length - 1].txn_id;
    const [a, b] = await Promise.all(['Copy A', 'Copy B'].map((v) =>
      admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: first + 0, into_version: v, create_version: true })));
    expect([a!.status, b!.status, a!.body.version_created, b!.body.version_created]).toEqual([200, 200, true, true]);
    const before = await versionTree(appId);
    const ords = before.map((r) => r.tree_ordinal);
    expect(new Set(ords).size).toBe(ords.length);
    expectOk(await admin.post(`${base}/deploy`));
    expect(await versionTree(appId)).toEqual(before);
    expect(expectOk(await admin.post(`${base}/audit/verify`)).ok).toBe(true);
  });

  it('on a secured Version dimension the new version is invisible to planners until granted, before and after a deploy', async () => {
    expectOk(await admin.patch(`${base}/dimensions/Version`, { secured: true }));
    expectOk(await admin.put(`${base}/grants`, { grants: [{ principal: { user: 'pat@vc.test' }, dimension: 'Version', member: 'All Versions', scope: 'idescendants', access: 'write' }] }));
    const txns = expectOk(await admin.get(`${base}/txns`)).txns;
    const made = expectOk(await admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: txns[0].txn_id, into_version: 'Hidden', create_version: true }));
    expect(made.version_created).toBe(true);
    const visible = async () => expectOk(await pat.get(`${base}/dimensions/Version/members`)).members.map((m: any) => m.name);
    const read = async () => (await pat.post(`${base}/grid/read`, planGrid({ ...PLAN_POV, Version: 'Hidden' }))).status;
    expect({ visible: (await visible()).includes('Hidden'), read: await read() }).toEqual({ visible: false, read: 403 });
    expectOk(await admin.post(`${base}/deploy`));
    expect({ visible: (await visible()).includes('Hidden'), read: await read() }).toEqual({ visible: false, read: 403 });
  });
});
