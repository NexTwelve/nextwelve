import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from './helpers.js';

// planGrid(): rows Net Income, Gross Margin, Revenue, COGS, Opex; columns Jan, Feb, Mar, Q1.
const R = { REV: 2, COGS: 3, OPEX: 4 };
const C = { JAN: 0, FEB: 1, MAR: 2 };
const pause = () => new Promise((r) => setTimeout(r, 25));

describe('point-in-time restore of a slice', () => {
  let h: Harness;
  let admin: Api;
  let ann: Api;
  let base: string;
  const txn: Record<string, number> = {};
  let betweenFirstAndSecond: string;

  async function edit(api: Api, edits: [number, number, number | null][], pov = PLAN_POV): Promise<number> {
    const g = expectOk(await api.post(`${base}/grid/read`, planGrid(pov)));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await api.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).txn_id;
  }
  async function values(pov = PLAN_POV) {
    return expectOk(await admin.post(`${base}/grid/read`, planGrid(pov))).values as (number | null)[][];
  }
  const slice = { cube: 'Plan', scenario: 'Budget', version: 'Working' };

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Restore Co', null, 'admin@rs.test');
    admin = await signIn(h, 'admin@rs.test');
    base = `/v1/apps/${await seedPlanApp(admin)}`;
    expectOk(await admin.post('/v1/users', { email: 'ann@rs.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'ann@rs.test', role: 'planner' }));
    expectOk(await admin.put(`${base}/grants`, { grants: [{ principal: { user: 'ann@rs.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' }] }));
    ann = await signIn(h, 'ann@rs.test');

    txn.first = await edit(ann, [[R.REV, C.JAN, 100], [R.REV, C.FEB, 200], [R.OPEX, C.JAN, 30]]);
    await pause();
    betweenFirstAndSecond = new Date().toISOString();
    await pause();
    txn.second = await edit(ann, [[R.REV, C.JAN, 150], [R.COGS, C.JAN, 40]]);
    txn.third = await edit(ann, [[R.REV, C.FEB, null], [R.OPEX, C.JAN, 35]]);
    // Another slice that must not move: West, written by the admin.
    txn.west = await edit(admin, [[R.REV, C.JAN, 999]], { ...PLAN_POV, Entity: 'West' });
  });
  afterAll(async () => h?.close());

  it('previews a restore without changing anything', async () => {
    const before = await values();
    const r = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: txn.second, dry_run: true }));
    // Rev Jan 150 -> 100, Rev Feb (cleared) -> 200, Opex Jan 35 -> 30; COGS Jan and West's Rev Jan
    // did not exist yet, so they are cleared.
    expect(r).toMatchObject({ dry_run: true, cells_set: 3, cells_cleared: 2, skipped: 0, txn_id: null, target_version: 'Working' });
    expect(r.as_of.txn_id).toBe(txn.first);
    expect(await values()).toEqual(before);
  });

  it('narrows the slice with member filters', async () => {
    const r = expectOk(await admin.post(`${base}/restore`, {
      ...slice, before_txn: txn.second, dry_run: true, filters: { Entity: ['East'], Account: ['Revenue'] },
    }));
    expect(r).toMatchObject({ cells_set: 2, cells_cleared: 0 });
    const parents = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: txn.second, dry_run: true, filters: { Entity: ['Total Company'] } }));
    expect(parents).toMatchObject({ cells_set: 3, cells_cleared: 2 }); // a parent filter means all its leaves
  });

  it('restores in place as one undoable restore transaction', async () => {
    const r = expectOk(await admin.post(`${base}/restore`, { ...slice, at: betweenFirstAndSecond, filters: { Entity: ['East'] } }));
    expect(r).toMatchObject({ dry_run: false, cells_set: 3, cells_cleared: 1, cell_count: 4 });
    const v = await values();
    expect([v[R.REV]![C.JAN], v[R.REV]![C.FEB], v[R.COGS]![C.JAN], v[R.OPEX]![C.JAN]]).toEqual([100, 200, null, 30]);
    expect((await values({ ...PLAN_POV, Entity: 'West' }))[R.REV]![C.JAN]).toBe(999);

    const history = expectOk(await admin.post(`${base}/history`, { cube: 'Plan', cell: { ...PLAN_POV, Account: 'Revenue', Period: 'Jan' } }));
    expect(history.changes[0]).toMatchObject({ source: 'restore', old_value: 150, new_value: 100, user: 'admin@rs.test' });

    expectOk(await admin.post(`${base}/txns/${r.txn_id}/undo`, {}));
    const back = await values();
    expect([back[R.REV]![C.JAN], back[R.REV]![C.FEB], back[R.COGS]![C.JAN], back[R.OPEX]![C.JAN]]).toEqual([150, null, 40, 35]);
  });

  it('restores into another version, creating it on request', async () => {
    const dry = expectOk(await admin.post(`${base}/restore`, {
      ...slice, before_txn: txn.third, into_version: 'Restored', create_version: true, dry_run: true,
    }));
    expect(dry).toMatchObject({ cells_set: 4, cells_cleared: 0, version_created: false });
    const members = expectOk(await admin.get(`${base}/dimensions/Version/members`)).members.map((m: any) => m.name);
    expect(members).not.toContain('Restored'); // the dry run created nothing

    expect((await admin.post(`${base}/restore`, { ...slice, before_txn: txn.third, into_version: 'Restored' })).status).toBe(422);
    const r = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: txn.third, into_version: 'Restored', create_version: true }));
    expect(r).toMatchObject({ version_created: true, target_version: 'Restored', cell_count: 4 });
    const v = await values({ ...PLAN_POV, Version: 'Restored' });
    expect([v[R.REV]![C.JAN], v[R.REV]![C.FEB], v[R.COGS]![C.JAN], v[R.OPEX]![C.JAN]]).toEqual([150, 200, 40, 30]);
    // The source version is untouched.
    expect((await values())[R.REV]![C.JAN]).toBe(150);

    // Restoring again into the same version clears what the older point did not have.
    const again = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: txn.second, into_version: 'Restored' }));
    expect(again).toMatchObject({ cells_set: 1, cells_cleared: 1 }); // Rev Jan 150 -> 100; COGS did not exist yet
    const w = await values({ ...PLAN_POV, Version: 'Restored' });
    expect([w[R.REV]![C.JAN], w[R.COGS]![C.JAN]]).toEqual([100, null]);
  });

  it('skips cells whose members were deleted since, and says which', async () => {
    const gadgets = { ...PLAN_POV, Product: 'Gadgets' };
    await edit(admin, [[R.REV, C.MAR, 7]], gadgets);
    const cleared = await edit(admin, [[R.REV, C.MAR, null]], gadgets);
    expectOk(await admin.del(`${base}/dimensions/Product/members/Gadgets`));
    expectOk(await admin.post(`${base}/deploy`));
    const r = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: cleared, dry_run: true, filters: { Account: ['Revenue'], Period: ['Mar'] } }));
    expect(r.skipped).toBe(1);
    expect(r.skipped_sample[0]).toMatchObject({ Product: expect.stringMatching(/^#\d+ \(deleted\)$/), Account: 'Revenue', Period: 'Mar' });
  });

  it('is for application admins only, and checks its inputs', async () => {
    expect((await ann.post(`${base}/restore`, { ...slice, before_txn: txn.second })).status).toBe(403);
    expect((await admin.post(`${base}/restore`, { ...slice })).status).toBe(422);
    expect((await admin.post(`${base}/restore`, { ...slice, before_txn: 999999 })).status).toBe(404);
    expect((await admin.post(`${base}/restore`, { ...slice, scenario: 'Budget', version: 'Working', before_txn: txn.second, filters: { Version: ['Final'] } })).status).toBe(422);
    const future = expectOk(await admin.post(`${base}/restore`, { ...slice, at: '2999-01-01T00:00:00Z', dry_run: true }));
    expect(future).toMatchObject({ cells_set: 0, cells_cleared: 0 });
  });

  it('closes an application to everyone while it is being restored', async () => {
    const su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    try {
      const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
      await su.query(`update epm.application set state = 'restoring' where app_id = $1`, [base.split('/').pop()]);
      const values = g.values.map((row: unknown[]) => [...row]);
      values[R.REV][C.MAR] = 1;
      expect((await ann.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).status).toBe(423);
      expect((await ann.post(`${base}/grid/read`, planGrid())).status).toBe(423);
      expect((await admin.post(`${base}/snapshots`, {})).status).toBe(423);
      expect((await admin.post(`${base}/restore`, { ...slice, before_txn: txn.second, dry_run: true })).status).toBe(423);
    } finally {
      await su.query(`update epm.application set state = 'online' where app_id = $1`, [base.split('/').pop()]);
      await su.end();
    }
  });
});
