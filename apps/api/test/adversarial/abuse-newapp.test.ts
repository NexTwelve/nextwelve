import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, createAbuseHarness, superuser } from './abuse-helpers.js';

const R = { REV: 2 };
const C = { JAN: 0 };

/** Restores into a new application: pending metadata, names, collisions, empty applications. */
describe('adversarial: restore into a new application', () => {
  let h: AbuseHarness;
  let admin: Api;
  let base: string;
  let snap: any;

  async function edit(b: string, v: number) {
    const g = expectOk(await admin.post(`${b}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[R.REV][C.JAN] = v;
    return expectOk(await admin.post(`${b}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  }
  const apps = async () => expectOk(await admin.get('/v1/apps')).apps as { app_id: string; name: string; state: string }[];

  beforeAll(async () => {
    h = await createAbuseHarness();
    await provisionTenant(h.db, 'New App Abuse Co', null, 'admin@na.test');
    admin = await signIn(h as any, 'admin@na.test');
    base = `/v1/apps/${await seedPlanApp(admin)}`;
    await edit(base, 100);
    snap = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
  });
  afterAll(async () => h?.close());

  describe('a snapshot taken while metadata edits were pending (saved, not deployed)', () => {
    let pendingBase: string;
    let pendingSnap: any;
    beforeAll(async () => {
      pendingBase = `/v1/apps/${await seedPlanApp(admin, 'Weekly Plan')}`;
      await edit(pendingBase, 100);
      // Someone starts splitting January into weeks but has not deployed: Jan still holds data and is still a leaf.
      expectOk(await admin.put(`${pendingBase}/dimensions/Period/members`, { members: [{ name: 'Jan W1', parent: 'Jan' }] }));
      pendingSnap = expectOk(await admin.post(`${pendingBase}/snapshots`, {}), 201);
      expect(pendingSnap.status).toBe('complete');
    });

    it('restores into a new application as the deployed application was', async () => {
      const r = await admin.post(`${pendingBase}/snapshots/${pendingSnap.snapshot_id}/restore`, { target: 'new_app', name: 'Weekly Copy' });
      expect([r.status, r.body.message]).toEqual([201, undefined]);
      const v = expectOk(await admin.post(`/v1/apps/${r.body.app_id}/grid/read`, planGrid())).values;
      expect(v[R.REV][C.JAN]).toBe(100);
    });

    it('a failed new-app restore leaves no half-built application behind, so retries do not pile up', async () => {
      await admin.post(`${pendingBase}/snapshots/${pendingSnap.snapshot_id}/restore`, { target: 'new_app', name: 'Weekly Retry' });
      await admin.post(`${pendingBase}/snapshots/${pendingSnap.snapshot_id}/restore`, { target: 'new_app', name: 'Weekly Retry' });
      const stuck = (await apps()).filter((a) => a.state === 'restoring').map((a) => a.name);
      expect(stuck).toEqual([]);
    });
  });

  it('gives up with a 409 after 99 names are taken, creating nothing', async () => {
    for (let n = 1; n < 100; n++) expectOk(await admin.post('/v1/apps', { name: n === 1 ? 'Crowded' : `Crowded ${n}` }), 201);
    const count = (await apps()).length;
    const r = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'crowded' });
    expect(r.status).toBe(409);
    expect((await apps()).length).toBe(count);
    // The next free name is still usable directly.
    expect((await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Crowded 100' })).status).toBe(201);
  });

  it('restored application names respect the 200-character limit applications have', async () => {
    const long = 'L'.repeat(200);
    expectOk(await admin.post('/v1/apps', { name: long }), 201);
    const a = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: long });
    // Default names: "<source name> (restored YYYY-MM-DD HH:MM)" for a source app with a 200-character name.
    const srcBase = `/v1/apps/${expectOk(await admin.post('/v1/apps', { name: 'S'.repeat(200) }), 201).app_id}`;
    const srcSnap = expectOk(await admin.post(`${srcBase}/snapshots`, {}), 201);
    const b = await admin.post(`${srcBase}/snapshots/${srcSnap.snapshot_id}/restore`, { target: 'new_app' });
    const lengths = [a, b].map((r) => (r.status === 201 ? r.body.name.length : 0));
    expect(lengths.every((n) => n <= 200), `name lengths ${lengths}`).toBe(true);
  });

  it('two restores asking for the same name at once both succeed with different names', async () => {
    const [x, y] = await Promise.all([
      admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Twin' }),
      admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Twin' }),
    ]);
    expect(h.unexpected).toEqual([]);
    expect([x.status, y.status], JSON.stringify([x.body, y.body]).slice(0, 300)).toEqual([201, 201]);
    expect(new Set([x.body.name, y.body.name]).size).toBe(2);
  });

  it('snapshots and restores an empty application (no dimensions, cubes, facts or datasets)', async () => {
    const empty = expectOk(await admin.post('/v1/apps', { name: 'Hollow' }), 201);
    const eb = `/v1/apps/${empty.app_id}`;
    const s = expectOk(await admin.post(`${eb}/snapshots`, {}), 201);
    expect(s).toMatchObject({ status: 'complete', fact_count: 0 });
    expect(s.manifest.files.map((f: any) => f.name)).toEqual(['metadata.json.gz', 'datasets.json.gz']);
    expect(expectOk(await admin.post(`${eb}/snapshots/${s.snapshot_id}/restore`, { target: 'in_place', dry_run: true })))
      .toMatchObject({ cells_set: 0, cells_cleared: 0, skipped: 0 });
    expect(expectOk(await admin.post(`${eb}/snapshots/${s.snapshot_id}/restore`, { target: 'in_place' })))
      .toMatchObject({ txn_id: null, cell_count: 0, pre_restore_snapshot_id: null });
    const r = expectOk(await admin.post(`${eb}/snapshots/${s.snapshot_id}/restore`, { target: 'new_app', name: 'Hollow Copy' }), 201);
    expect(r).toMatchObject({ cells: 0, missing_users: [], missing_groups: [] });
    expect((await apps()).find((a) => a.app_id === r.app_id)).toMatchObject({ state: 'online' });
  });

  it('snapshots and restores an application with cubes but no data', async () => {
    const nb = `/v1/apps/${await seedPlanApp(admin, 'Dry Plan')}`;
    const s = expectOk(await admin.post(`${nb}/snapshots`, { scope: { versions: ['Final'] } }), 201);
    expect(s.manifest.files.map((f: any) => f.name)).toEqual(['metadata.json.gz', 'datasets.json.gz']);
    const r = expectOk(await admin.post(`${nb}/snapshots/${s.snapshot_id}/restore`, { target: 'new_app' }), 201);
    expect(r.cells).toBe(0);
    expect(expectOk(await admin.get(`/v1/apps/${r.app_id}/dimensions`)).cubes).toHaveLength(1);
  });

  it('the snapshot of a deleted application can still be restored into a new one (it is meant to outlive the app)', async () => {
    const doomed = await seedPlanApp(admin, 'Doomed Plan');
    await edit(`/v1/apps/${doomed}`, 64);
    const s = expectOk(await admin.post(`/v1/apps/${doomed}/snapshots`, {}), 201);
    const su = await superuser(h.db);
    await su.query('delete from epm.application where app_id = $1', [doomed]);
    const kept = (await su.query('select status from epm.snapshot where snapshot_id = $1', [s.snapshot_id])).rows[0];
    await su.end();
    expect(kept).toEqual({ status: 'complete' }); // the row and its files are still there
    const r = await admin.post(`/v1/apps/${doomed}/snapshots/${s.snapshot_id}/restore`, { target: 'new_app', name: 'Doomed Plan (recovered)' });
    expect([r.status, r.body.message]).toEqual([201, undefined]);
  });

  it('an in-place restore over a cube whose dimension was renamed skips its cells and clears nothing', async () => {
    const nb = `/v1/apps/${await seedPlanApp(admin, 'Renamed Plan')}`;
    await edit(nb, 42);
    const s = expectOk(await admin.post(`${nb}/snapshots`, {}), 201);
    await edit(nb, 43);
    const su = await superuser(h.db);
    await su.query(`update epm.dimension set name = 'Item' where name = 'Product' and app_id = $1`, [nb.split('/').pop()]);
    await su.end();
    const r = expectOk(await admin.post(`${nb}/snapshots/${s.snapshot_id}/restore`, { target: 'in_place' }));
    expect(r).toMatchObject({ cells_set: 0, cells_cleared: 0, skipped: 1, skipped_reasons: [{ reason: 'dimension Product is no longer in cube Plan', count: 1 }] });
    expect(expectOk(await admin.post(`${nb}/grid/read`, planGrid({ ...PLAN_POV, Item: 'Widgets', Product: undefined } as any))).values[R.REV][C.JAN]).toBe(43);
  });
});
