import { gunzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, asUser, cubeId, createAbuseHarness, memberIds } from './abuse-helpers.js';

const R = { REV: 2, COGS: 3, OPEX: 4 };
const C = { JAN: 0, FEB: 1, MAR: 2 };

/** Restores and snapshots racing each other and ordinary writes. */
describe('adversarial: races', () => {
  let h: AbuseHarness;
  let admin: Api;
  let tenantId: string;
  let appId: string;
  let base: string;
  let ids: Record<string, Record<string, number>>;
  let cube: number;

  async function edit(edits: [number, number, number | null][], pov = PLAN_POV): Promise<number> {
    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid(pov)));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).txn_id;
  }
  const grid = async (pov = PLAN_POV) => expectOk(await admin.post(`${base}/grid/read`, planGrid(pov))).values as (number | null)[][];
  /** Coordinates of one Plan cell in Budget/Working/FY27/Sales/Widgets. */
  const coord = (period: string, entity: string, account: string, version = 'Working') => {
    const k = new Array<number>(16).fill(0);
    k[0] = cube; k[1] = ids.Scenario!.Budget!; k[2] = ids.Version![version]!; k[3] = ids.Years!.FY27!; k[4] = ids.Period![period]!;
    k[5] = ids.Entity![entity]!; k[6] = ids.Account![account]!; k[7] = ids.Department!.Sales!; k[8] = ids.Product!.Widgets!;
    return k;
  };
  /** Another session's write, committed immediately on its own connection. */
  const otherWriter = (cells: { k: number[]; v: number | null }[]) =>
    asUser(h.pool, tenantId, 'admin@race.test', (c) =>
      c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: appId, source: 'api', cells })]));

  beforeAll(async () => {
    h = await createAbuseHarness();
    tenantId = await provisionTenant(h.db, 'Race Co', null, 'admin@race.test');
    admin = await signIn(h as any, 'admin@race.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    ids = await memberIds(h.db, appId);
    cube = await cubeId(h.db, appId);
  });
  beforeEach(() => {
    h.queryHooks.length = 0;
    h.unexpected.length = 0;
  });
  afterAll(async () => h?.close());

  it('two in-place snapshot restores at once: no 500, and the data ends as the snapshot had it', async () => {
    await edit([[R.REV, C.JAN, 10], [R.REV, C.FEB, 20], [R.OPEX, C.JAN, 3]]);
    const snap = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    await edit([[R.REV, C.JAN, 11], [R.REV, C.FEB, null], [R.COGS, C.MAR, 9]]);
    const rs = await Promise.all([1, 2, 3].map(() => admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' })));
    expect(rs.map((r) => r.status).filter((s) => s !== 200 && s !== 409), JSON.stringify(rs.map((r) => r.body)).slice(0, 400)).toEqual([]);
    expect(h.unexpected).toEqual([]);
    const v = await grid();
    expect([v[R.REV]![C.JAN], v[R.REV]![C.FEB], v[R.OPEX]![C.JAN], v[R.COGS]![C.MAR]]).toEqual([10, 20, 3, null]);
    expect(expectOk(await admin.post(`${base}/audit/verify`))).toMatchObject({ ok: true });
  });

  it('two point-in-time restores of the same slice at once: no 500, and the slice ends at that point', async () => {
    await edit([[R.REV, C.MAR, 1]]);
    const t2 = await edit([[R.REV, C.MAR, 2], [R.OPEX, C.MAR, 2]]);
    await edit([[R.REV, C.MAR, 3]]);
    // Just before t2: Revenue Mar was 1 and Opex Mar empty.
    const body = { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: t2, filters: { Period: ['Mar'] } };
    const rs = await Promise.all([1, 2, 3].map(() => admin.post(`${base}/restore`, body)));
    expect(rs.map((r) => r.status).filter((s) => s !== 200 && s !== 409)).toEqual([]);
    expect(rs.filter((r) => r.status === 200 && r.body.cell_count > 0)).toHaveLength(1); // the others find nothing left to do
    const v = await grid();
    expect([v[R.REV]![C.MAR], v[R.OPEX]![C.MAR]]).toEqual([1, null]);
  });

  it('two point-in-time restores creating the same new version at once: one version, no 500', async () => {
    const t = await edit([[R.REV, C.JAN, 77]]);
    const rs = await Promise.all([1, 2].map(() =>
      admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: t, into_version: 'Race Copy', create_version: true })));
    expect(rs.map((r) => r.status).filter((s) => s !== 200 && s !== 409), JSON.stringify(rs.map((r) => r.body)).slice(0, 300)).toEqual([]);
    expect(h.unexpected).toEqual([]);
    const names = (expectOk(await admin.get(`${base}/dimensions/Version/members`)).members as any[]).map((m) => m.name.toLowerCase());
    expect(names.filter((n) => n === 'race copy')).toHaveLength(1);
  });

  it('a write committed while an in-place restore is planning does not survive the restore unseen', async () => {
    // The restore claims: "The plan runs in the same transaction as the write, so current values cannot move under it."
    await edit([[R.REV, C.JAN, 500], [R.REV, C.FEB, 600]]);
    const snap = expectOk(await admin.post(`${base}/snapshots`, { scope: { versions: ['Working'] } }), 201);
    await edit([[R.REV, C.JAN, 501]]);
    let injected = false;
    h.queryHooks.push(async (sql, params) => {
      if (injected || !sql.includes('epm.apply_changes') || !String(params?.[0]).includes('"source":"restore"')) return;
      injected = true;
      // Between the restore's plan and its write: a planner enters a brand-new cell (West, Mar).
      await otherWriter([{ k: coord('Mar', 'West', 'Revenue'), v: 999 }]);
    });
    const r = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' });
    expect(injected).toBe(true);
    const west = (await grid({ ...PLAN_POV, Entity: 'West' }))[R.REV]![C.MAR];
    // Either the restore notices (409) or it leaves the version exactly as the snapshot had it.
    expect({ status: r.status, westMar: r.status === 409 ? null : west }).toEqual({ status: r.status === 409 ? 409 : 200, westMar: null });
  });

  it('a snapshot taken while metadata is deployed and data written is internally consistent', async () => {
    let fired = false;
    h.queryHooks.push(async (sql) => {
      if (fired || !sql.startsWith('select name, metadata_rev from epm.application')) return;
      fired = true;
      // After the export's transaction has its view: a deploy adds a Product, and a cell is written for it.
      await asUser(h.pool, tenantId, 'admin@race.test', async (c) => {
        await c.query(`insert into epm.member (tenant_id, dim_id, name, parent_id)
                       select d.tenant_id, d.dim_id, 'Gizmos', p.member_id from epm.dimension d join epm.member p on p.dim_id = d.dim_id and p.name = 'All Products'
                        where d.app_id = $1 and d.name = 'Product'`, [appId]);
        await c.query('select epm.deploy_metadata($1)', [appId]);
      });
      const gizmos = (await memberIds(h.db, appId)).Product!.Gizmos!;
      const k = coord('Jan', 'East', 'Revenue'); k[8] = gizmos;
      await otherWriter([{ k, v: 5 }]);
    });
    const s = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    expect(fired).toBe(true);
    const meta = JSON.parse(strFromU8(gunzipSync((await h.store.get(`${s.storage_prefix}/metadata.json.gz`))!)));
    expect(meta.members.map((m: any) => m.name)).not.toContain('Gizmos');
    const facts = strFromU8(gunzipSync((await h.store.get(`${s.storage_prefix}/facts-0001.ndjson.gz`))!)).split('\n').map((l) => JSON.parse(l));
    const memberIdsInSnapshot = new Set(meta.members.map((m: any) => m.member_id));
    expect(facts.every((f: number[]) => f.slice(1, 16).every((id) => id === 0 || memberIdsInSnapshot.has(id)))).toBe(true);
    expect(s.metadata_rev).toBe(meta.application.metadata_rev);
    expect(s.fact_count).toBe(facts.length);
  });

  it('restores racing grid submits on the same cells never answer 500', async () => {
    await edit([[R.REV, C.JAN, 1], [R.REV, C.FEB, 2], [R.REV, C.MAR, 3], [R.OPEX, C.JAN, 4], [R.OPEX, C.FEB, 5]]);
    const snap = expectOk(await admin.post(`${base}/snapshots`, { scope: { versions: ['Working'] } }), 201);
    const statuses: number[] = [];
    for (let round = 0; round < 6; round++) {
      await edit([[R.OPEX, C.FEB, 50 + round], [R.REV, C.JAN, 10 + round], [R.REV, C.MAR, 30 + round]]);
      const writes = [
        // Cells in the opposite order to the table's, so row locks are taken in a different order.
        otherWriter([{ k: coord('Mar', 'East', 'Revenue'), v: 100 + round }, { k: coord('Feb', 'East', 'Opex'), v: 200 + round }, { k: coord('Jan', 'East', 'Revenue'), v: 300 + round }])
          .then(() => 200, (e) => (e.code === 'NX409' ? 409 : e.code === '40P01' ? 500 : 599)),
        admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' }).then((r) => r.status),
      ];
      statuses.push(...(await Promise.all(writes)));
    }
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });
});
