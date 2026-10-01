import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, cubeId, createAbuseHarness, memberIds, sleep } from './abuse-helpers.js';

const R = { REV: 2, OPEX: 4 };
const C = { JAN: 0 };

/**
 * "Restore to a time" must give the data as it was committed at that time. change_txn.created_at is
 * the writer's transaction START (now()), while chain_seq is assigned at the end, so the two orders
 * disagree whenever a write takes a while (an import, a large restore).
 */
describe('adversarial: point-in-time by timestamp with overlapping writers', () => {
  let h: AbuseHarness;
  let admin: Api;
  let tenantId: string;
  let appId: string;
  let base: string;

  async function edit(edits: [number, number, number | null][]): Promise<number> {
    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).txn_id;
  }

  beforeAll(async () => {
    h = await createAbuseHarness();
    tenantId = await provisionTenant(h.db, 'Pit Time Co', null, 'admin@pt.test');
    admin = await signIn(h as any, 'admin@pt.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
  });
  afterAll(async () => h?.close());

  it('a restore to time T does not keep a change committed after T', async () => {
    const first = await edit([[R.REV, C.JAN, 100]]);
    await sleep(20);

    // A slow writer (an import, say) starts now, before T ...
    const ids = await memberIds(h.db, appId);
    const cube = await cubeId(h.db, appId);
    const slow = await h.pool.connect();
    await slow.query('begin');
    await slow.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const user = (await slow.query('select user_id from epm.app_user where email = $1', ['admin@pt.test'])).rows[0].user_id;
    await slow.query("select set_config('app.user_id', $1, true)", [user]);
    await slow.query('select now()'); // the transaction's timestamp is fixed here
    await sleep(40);
    const T = new Date().toISOString();
    await sleep(40);

    // ... a planner's edit starts and commits after T ...
    const late = await edit([[R.REV, C.JAN, 555]]);

    // ... and the slow writer commits last.
    const k = new Array<number>(16).fill(0);
    k[0] = cube; k[1] = ids.Scenario!.Budget!; k[2] = ids.Version!.Working!; k[3] = ids.Years!.FY27!; k[4] = ids.Period!.Jan!;
    k[5] = ids.Entity!.East!; k[6] = ids.Account!.Opex!; k[7] = ids.Department!.Sales!; k[8] = ids.Product!.Widgets!;
    const slowTxn = (await slow.query('select epm.apply_changes($1::jsonb) as r', [JSON.stringify({ app_id: appId, source: 'data_load', cells: [{ k, v: 7 }] })])).rows[0].r.txn_id;
    await slow.query('commit');
    slow.release();
    expect(slowTxn).toBeGreaterThan(0);

    // At T only `first` had been committed: Revenue Jan was 100 and Opex Jan was empty.
    const r = expectOk(await admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', at: T, dry_run: true }));
    expect({ kept: r.as_of.txn_id, cells_set: r.cells_set, cells_cleared: r.cells_cleared }).toEqual({ kept: first, cells_set: 1, cells_cleared: 1 });
    expect(late).toBeGreaterThan(first);
  });
});
