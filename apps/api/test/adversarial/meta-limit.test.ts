import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_IN_PLACE_CELLS } from '../../src/backup/snapshots.js';
import { Api, expectOk, type Harness, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, buildBigApp, createAbuseHarness } from './abuse-helpers.js';

/**
 * A metadata restore with data: true that would change more than MAX_IN_PLACE_CELLS cells, from a
 * point in time and from a snapshot: the preview says so, the real run refuses before taking a
 * pre_restore snapshot or writing anything, and the metadata alone still restores.
 */
describe('adversarial: metadata restore data limit', () => {
  let h: AbuseHarness;
  let admin: Api;
  let appId: string;
  let base: string;
  let big: Awaited<ReturnType<typeof buildBigApp>>;
  let t: string;

  const counts = async () => {
    const c = new pg.Client({ connectionString: h.db.superUrl });
    await c.connect();
    try {
      return (await c.query<{ snaps: number; txns: number; rev: number; facts: number; events: number }>(
        `select (select count(*)::int from epm.snapshot where app_id = $1) as snaps,
                (select count(*)::int from epm.change_txn where app_id = $1) as txns,
                (select metadata_rev from epm.application where app_id = $1) as rev,
                (select count(*)::int from epm.fact where app_id = $1) as facts,
                (select count(*)::int from epm.security_event where app_id = $1) as events`, [appId])).rows[0]!;
    } finally {
      await c.end();
    }
  };

  beforeAll(async () => {
    h = await createAbuseHarness();
    const tenantId = await provisionTenant(h.db, 'MLimit Co', null, 'admin@mlim.test');
    admin = await signIn(h as unknown as Harness, 'admin@mlim.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    // 2,800 products x 36 cells = 100,800 cells written after the deploy and the (empty) snapshot.
    big = await buildBigApp(h, admin, tenantId, 'admin@mlim.test', appId, 2800);
    expect(big.total).toBeGreaterThan(MAX_IN_PLACE_CELLS);
    const c = new pg.Client({ connectionString: h.db.superUrl });
    await c.connect();
    t = (await c.query<{ t: string }>(
      `select to_char(completed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t from epm.snapshot where snapshot_id = $1`,
      [big.emptySnap.snapshot_id])).rows[0]!.t;
    await c.end();
  }, 40_000);
  afterAll(async () => h?.close());

  it('point in time: the preview reports over_limit; the real run refuses with 422 before any snapshot or write; metadata alone still runs', async () => {
    const dry = expectOk(await admin.post(`${base}/metadata/restore`, { at: t, data: true, definitions: false, dry_run: true }));
    expect(dry.data).toMatchObject({ cells_cleared: big.total, over_limit: true, max_cells: MAX_IN_PLACE_CELLS });
    const before = await counts();
    const r = await admin.post(`${base}/metadata/restore`, { at: t, data: true, definitions: false });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/more than 100000 cells/);
    expect(await counts()).toEqual(before);
    const meta = expectOk(await admin.post(`${base}/metadata/restore`, { at: t, definitions: false }));
    expect(meta.changes).toBe(0);
  });

  it('from a snapshot: the same', async () => {
    const dry = expectOk(await admin.post(`${base}/metadata/restore`, { snapshot_id: big.emptySnap.snapshot_id, data: true, definitions: false, dry_run: true }));
    expect(dry.data).toMatchObject({ cells_cleared: big.total, over_limit: true });
    const before = await counts();
    const r = await admin.post(`${base}/metadata/restore`, { snapshot_id: big.emptySnap.snapshot_id, data: true, definitions: false });
    expect(r.status).toBe(422);
    expect(await counts()).toEqual(before);
  });
});
