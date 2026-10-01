import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Env, expectOk, setupEnv } from './data-helpers.js';

/**
 * Restores decide what to write (the plan) and then write it through apply_changes, in READ COMMITTED.
 * A writer that holds a row the restore must change makes the restore wait inside apply_changes;
 * anything that writer also changed, and that the plan had judged "already right", is then left at
 * the writer's value. The result is neither "writer, then restore" nor "restore, then writer".
 *
 * The interleaving is forced: the writer's transaction is open (rows locked) before the restore
 * starts and commits only once the restore is seen waiting on a lock.
 */
describe('restores racing a concurrent writer', () => {
  let env: Env;
  let base: string;

  const val = async (k: number[]) =>
    (await env.su.query<{ v: string }>(
      `select value::text as v from epm.fact where app_id = $1 and array[cube_id, scenario_id, version_id, years_id, period_id,
         entity_id, account_id, department_id, c1, c2, c3, c4, c5, c6, c7, c8] = $2::int[]`,
      [env.appId, k],
    )).rows[0]?.v ?? null;

  /** Open a writer transaction that has changed (and so locked) the given cells, uncommitted. */
  async function openWriter(cells: { k: number[]; v: string }[]): Promise<{ c: pg.PoolClient; pid: number }> {
    const c = await env.h.pool.connect();
    await c.query('begin');
    await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [env.tenantId, env.userId]);
    await c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: env.appId, source: 'api', cells })]);
    const pid = (await c.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid;
    return { c, pid };
  }
  async function waitUntilBlockedBy(pid: number) {
    for (let i = 0; i < 250; i++) {
      const r = await env.su.query('select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))', [pid]);
      if (r.rowCount) return;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error('the restore never waited on the writer');
  }

  beforeAll(async () => {
    env = await setupEnv('race');
    base = env.base;
  });
  afterAll(async () => env?.close());

  it('FINDING: an in-place snapshot restore leaves the scope equal to the snapshot even when a writer commits mid-restore', async () => {
    const A = env.coord({ Account: 'Revenue', Period: 'Jan' });
    const B = env.coord({ Account: 'COGS', Period: 'Jan' });
    await env.write([{ k: A, v: '1' }, { k: B, v: '1' }]);
    const snap = expectOk(await env.admin.post(`${base}/snapshots`, { scope: { versions: ['Working'] } }), 201);
    await env.write([{ k: A, v: '2' }]); // B still equals the snapshot

    const w = await openWriter([{ k: A, v: '3' }, { k: B, v: '3' }]);
    try {
      const restoring = env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'] });
      await waitUntilBlockedBy(w.pid);
      await w.c.query('commit');
      expectOk(await restoring);
    } finally {
      w.c.release();
    }
    const after = { A: await val(A), B: await val(B) };
    // Serial outcomes: writer then restore -> 1/1; restore then writer -> 3/3.
    expect([JSON.stringify({ A: '1.000000', B: '1.000000' }), JSON.stringify({ A: '3.000000', B: '3.000000' })]).toContain(JSON.stringify(after));
  });

  it('FINDING: a point-in-time restore leaves the slice at the chosen point even when a writer commits mid-restore', async () => {
    const A = env.coord({ Account: 'Revenue', Period: 'Feb' });
    const B = env.coord({ Account: 'COGS', Period: 'Feb' });
    await env.write([{ k: A, v: '10' }, { k: B, v: '10' }]);
    const later = await env.write([{ k: A, v: '20' }]); // B has no change after the point

    const w = await openWriter([{ k: A, v: '30' }, { k: B, v: '30' }]);
    try {
      const restoring = env.admin.post(`${base}/restore`, {
        cube: 'Plan', scenario: 'Budget', version: 'Working', before_txn: later.txn_id, filters: { Period: ['Feb'] },
      });
      await waitUntilBlockedBy(w.pid);
      await w.c.query('commit');
      expectOk(await restoring);
    } finally {
      w.c.release();
    }
    const after = { A: await val(A), B: await val(B) };
    expect([JSON.stringify({ A: '10.000000', B: '10.000000' }), JSON.stringify({ A: '30.000000', B: '30.000000' })]).toContain(JSON.stringify(after));
  });
});
