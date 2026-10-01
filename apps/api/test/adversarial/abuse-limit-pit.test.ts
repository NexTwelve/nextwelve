import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_IN_PLACE_CELLS } from '../../src/backup/snapshots.js';
import { Api, expectOk, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, buildBigApp, createAbuseHarness } from './abuse-helpers.js';

/** A point-in-time restore of more than MAX_IN_PLACE_CELLS cells: one transaction, one jsonb, no limit. */
describe('adversarial: point-in-time restore size limit', () => {
  let h: AbuseHarness;
  let admin: Api;
  let base: string;
  let big: Awaited<ReturnType<typeof buildBigApp>>;
  const txnCount = async () => expectOk(await admin.get(`${base}/txns?limit=200`)).txns.length as number;

  beforeAll(async () => {
    h = await createAbuseHarness();
    const tenantId = await provisionTenant(h.db, 'Pit Limit Co', null, 'admin@pl.test');
    admin = await signIn(h as any, 'admin@pl.test');
    const appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    big = await buildBigApp(h, admin, tenantId, 'admin@pl.test', appId, 2800); // 100,800 cells
    expect(big.total).toBeGreaterThan(MAX_IN_PLACE_CELLS);
  }, 40_000);
  afterAll(async () => h?.close());

  it('is held to the same limit as an in-place snapshot restore (422, nothing written)', async () => {
    const dry = expectOk(await admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: big.txns[0], dry_run: true }));
    expect(dry.cells_cleared).toBe(big.total);
    const txns = await txnCount();
    const r = await admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: big.txns[0] });
    expect({ status: r.status, cellsWritten: r.body.cell_count ?? 0 }).toEqual({ status: 422, cellsWritten: 0 });
    expect(await txnCount()).toBe(txns);
  }, 30_000);
});
