import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_IN_PLACE_CELLS } from '../../src/backup/snapshots.js';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, buildBigApp, createAbuseHarness } from './abuse-helpers.js';

/** In-place snapshot restores that would change more than MAX_IN_PLACE_CELLS cells. */
describe('adversarial: in-place snapshot restore size limit', () => {
  let h: AbuseHarness;
  let admin: Api;
  let base: string;
  let big: Awaited<ReturnType<typeof buildBigApp>>;

  const snapshotCount = async () => expectOk(await admin.get(`${base}/snapshots`)).snapshots.length as number;
  const txnCount = async () => expectOk(await admin.get(`${base}/txns?limit=200`)).txns.length as number;
  const sample = async () => expectOk(await admin.post(`${base}/grid/read`, planGrid({ ...PLAN_POV, Product: 'P2999' }))).values[2][0];

  beforeAll(async () => {
    h = await createAbuseHarness();
    const tenantId = await provisionTenant(h.db, 'Limit Co', null, 'admin@lim.test');
    admin = await signIn(h as any, 'admin@lim.test');
    const appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    big = await buildBigApp(h, admin, tenantId, 'admin@lim.test', appId, 3000);
    expect(big.total).toBeGreaterThan(MAX_IN_PLACE_CELLS);
  }, 40_000);
  afterAll(async () => h?.close());

  it('previews an over-limit snapshot restore', async () => {
    const dry = expectOk(await admin.post(`${base}/snapshots/${big.emptySnap.snapshot_id}/restore`, { target: 'in_place', dry_run: true }));
    expect(dry).toMatchObject({ cells_set: 0, cells_cleared: big.total });
  });

  it('refuses an over-limit in-place snapshot restore with 422 before a pre-restore snapshot or any write', async () => {
    const snaps = await snapshotCount();
    const txns = await txnCount();
    const r = await admin.post(`${base}/snapshots/${big.emptySnap.snapshot_id}/restore`, { target: 'in_place' });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/would change 108000 cells; restore at most 100000/);
    expect(await snapshotCount()).toBe(snaps);
    expect(await txnCount()).toBe(txns);
    expect(await sample()).not.toBeNull();
  });

  it('a narrower scope that fits the limit still goes through', async () => {
    const r = expectOk(await admin.post(`${base}/snapshots/${big.emptySnap.snapshot_id}/restore`, { target: 'in_place', versions: ['Final'] }));
    expect(r).toMatchObject({ cells_set: 0, cells_cleared: 0, txn_id: null });
  });
});
