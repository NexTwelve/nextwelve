import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Env, expectOk, setupEnv } from './data-helpers.js';

/**
 * restore_slice skips cells "whose members no longer exist as deployed leaves". Deleting a member
 * removes its row at once, but the closure the check reads (member_ancestor) is only rebuilt by the
 * next deploy. Between the two, a restore must still not write facts for a member that is gone.
 */
describe('point-in-time restore and a member deleted but not yet deployed', () => {
  let env: Env;
  let base: string;
  let gadgets: number;
  let beforeClear: number;

  const orphanFacts = async () =>
    (await env.su.query<{ n: number }>(
      `select count(*)::int as n from epm.fact f where f.app_id = $1 and not exists (select 1 from epm.member m where m.member_id = f.c1)`,
      [env.appId],
    )).rows[0]!.n;

  beforeAll(async () => {
    env = await setupEnv('pitdel');
    base = env.base;
    gadgets = env.id('Product', 'Gadgets');
    const cells = ['Jan', 'Feb'].map((p) => ({ k: env.coord({ Product: 'Gadgets', Period: p }), v: '5' }));
    await env.write([...cells, { k: env.coord({ Product: 'Widgets' }), v: '1' }]);
    beforeClear = (await env.write(cells.map((c) => ({ ...c, v: null })))).txn_id!;
    expectOk(await env.admin.del(`${base}/dimensions/Product/members/Gadgets`)); // deploy_required: true
  });
  afterAll(async () => env?.close());

  it('FINDING: does not write facts for the deleted member (they are skipped and reported)', async () => {
    const dry = expectOk(await env.admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: beforeClear, dry_run: true }));
    const r = expectOk(await env.admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: beforeClear }));
    expect({ orphans: await orphanFacts(), skipped: r.skipped, set: r.cells_set, dry_skipped: dry.skipped })
      .toEqual({ orphans: 0, skipped: 2, set: 0, dry_skipped: 2 });
  });

  it('FINDING: the application stays snapshot-and-restorable afterwards', async () => {
    // Whatever the restore did, a snapshot of the application must restore into a new application.
    expectOk(await env.admin.post(`${base}/deploy`));
    const snap = expectOk(await env.admin.post(`${base}/snapshots`, {}), 201);
    const res = await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'After Orphans' });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
    expect(gadgets).toBeGreaterThan(0);
  });
});
