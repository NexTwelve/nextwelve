import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAN_POV, planGrid, seedPlanApp } from '../helpers.js';
import { type Env, expectOk, setupEnv, sorted } from './data-helpers.js';

/**
 * Where does a point-in-time restore land? `at` (a time) and `before_txn` both resolve to a chain
 * position; these tests pin the boundaries.
 */
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SLICE = { cube: 'Plan', scenario: 'Budget', version: 'Working' };

describe('point-in-time boundaries', () => {
  let env: Env;
  let base: string;
  let A: number[];
  let B: number[];
  let C: number[];

  /** The server's clock, as an ISO string with milliseconds. */
  const serverNow = async () =>
    (await env.su.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as t`)).rows[0]!.t;
  const createdAt = async (txn: number) =>
    (await env.su.query<{ t: string; us: number }>(
      `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t,
              (extract(microseconds from created_at)::bigint % 1000)::int as us
         from epm.change_txn where txn_id = $1`,
      [txn],
    )).rows[0]!;
  const slice = () => env.facts({ scenario: 'Budget', version: 'Working' });

  beforeAll(async () => {
    env = await setupEnv('pitbound');
    base = env.base;
    A = env.coord({ Account: 'Revenue', Period: 'Jan' });
    B = env.coord({ Account: 'COGS', Period: 'Jan' });
    C = env.coord({ Account: 'Opex', Period: 'Feb' });
  });
  afterAll(async () => env?.close());

  it('before the first change and before_txn of the very first transaction both mean "empty"', async () => {
    const before = await serverNow();
    await pause(5);
    const first = await env.write([{ k: A, v: 1 }, { k: B, v: 2 }]);
    await env.write([{ k: A, v: 3 }, { k: C, v: 4 }]);
    const head = await slice();
    expect(head.size).toBe(3);

    for (const point of [{ at: before }, { at: '2000-01-01T00:00:00Z' }, { before_txn: first.txn_id }]) {
      const dry = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...point, dry_run: true }));
      expect(dry, JSON.stringify(point)).toMatchObject({ cells_set: 0, cells_cleared: 3, as_of: { chain_seq: 0, txn_id: null, at: null } });
    }
    const r = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, before_txn: first.txn_id }));
    expect((await slice()).size).toBe(0);
    expectOk(await env.admin.post(`${base}/txns/${r.txn_id}/undo`, {}));
    expect(sorted(await slice())).toEqual(sorted(head));

    // Into a new version: the version is created and holds nothing.
    const into = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, before_txn: first.txn_id, into_version: 'Empty', create_version: true }));
    expect(into).toMatchObject({ version_created: true, cells_set: 0, cells_cleared: 0 });
    await env.refreshIds();
    expect((await env.facts({ scenario: 'Budget', version: 'Empty' })).size).toBe(0);
  });

  it('a time given with any UTC offset is the same instant', async () => {
    await env.write([{ k: A, v: 10 }]);
    await pause(30);
    const mid = await serverNow();
    await pause(30);
    const later = await env.write([{ k: A, v: 11 }]);
    const instant = new Date(mid).getTime();
    const withOffset = (minutes: number) => {
      const d = new Date(instant + minutes * 60_000).toISOString().slice(0, 23);
      const sign = minutes >= 0 ? '+' : '-';
      const m = Math.abs(minutes);
      return `${d}${sign}${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    };
    const seqs = [];
    for (const at of [mid, withOffset(330), withOffset(-480), withOffset(0)]) {
      seqs.push(expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, at, dry_run: true })).as_of.chain_seq);
    }
    expect(seqs).toEqual(seqs.map(() => later.chain_seq! - 1));
  });

  it('several transactions inside one database transaction: before_txn still separates them', async () => {
    const c = await env.h.pool.connect();
    const txns: number[] = [];
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [env.tenantId, env.userId]);
      for (const v of [21, 22, 23]) {
        const r = await c.query<{ r: { txn_id: number } }>('select epm.apply_changes($1::jsonb) as r', [
          JSON.stringify({ app_id: env.appId, source: 'api', cells: [{ k: C, v: String(v) }] }),
        ]);
        txns.push(r.rows[0]!.r.txn_id);
      }
      await c.query('commit');
    } finally {
      c.release();
    }
    // Each change gets its own time when it joins the history, in chain order.
    const times = await Promise.all(txns.map(async (t) => (await createdAt(t)).t));
    expect([...times].sort()).toEqual(times);
    expect(new Set(times).size).toBe(3);
    const r1 = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, before_txn: txns[1], filters: { Account: ['Opex'] }, dry_run: true }));
    expect(r1.as_of.txn_id).toBe(txns[0]);
    const exact = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, at: times[2], dry_run: true }));
    expect(exact.as_of.txn_id).toBe(txns[2]);
    const first = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, at: times[0], dry_run: true }));
    expect(first.as_of.txn_id).toBe(txns[0]);
  });

  it('before_txn naming a transaction of another application in the same tenant is refused', async () => {
    const otherApp = await seedPlanApp(env.admin, 'Other Plan');
    const ob = `/v1/apps/${otherApp}`;
    const g = expectOk(await env.admin.post(`${ob}/grid/read`, planGrid(PLAN_POV)));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[2][0] = 5;
    const foreign = expectOk(await env.admin.post(`${ob}/grid/submit`, { grid_session_id: g.grid_session_id, values })).txn_id;
    const before = await slice();
    const res = await env.admin.post(`${base}/restore`, { ...SLICE, before_txn: foreign });
    expect(res.status).toBe(404);
    expect(sorted(await slice())).toEqual(sorted(before));
  });

  // ---------------------------------------------------------------------------------------------
  // Findings
  // ---------------------------------------------------------------------------------------------

  it('FINDING: "at" = a transaction\'s created_at as the API reports it must include that transaction', async () => {
    // A transaction whose created_at has sub-millisecond digits (almost all of them).
    let t: { txn_id: number | null; chain_seq: number | null } = { txn_id: null, chain_seq: null };
    for (let n = 0; n < 10; n++) {
      t = await env.write([{ k: A, v: 100 + n }]);
      if ((await createdAt(t.txn_id!)).us !== 0) break;
    }
    const listed = expectOk(await env.admin.get(`${base}/txns?limit=5`)).txns.find((x: any) => x.txn_id === t.txn_id);
    expect(listed).toBeDefined();
    // Restoring to the moment the history says this change was made keeps the change.
    const r = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, at: listed.created_at, dry_run: true }));
    expect({ as_of_txn: r.as_of.txn_id, cells_set: r.cells_set }).toEqual({ as_of_txn: t.txn_id, cells_set: 0 });
  });

  it('FINDING: the as_of.at a restore reports, fed back as "at", lands on the same chain position', async () => {
    const p = await env.write([{ k: B, v: 500 }]);
    const q = await env.write([{ k: B, v: 600 }]);
    const viaTxn = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, before_txn: q.txn_id, dry_run: true }));
    expect(viaTxn.as_of.txn_id).toBe(p.txn_id);
    const viaAt = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, at: viaTxn.as_of.at, dry_run: true }));
    expect(viaAt.as_of).toEqual(viaTxn.as_of);
  });

  it('FINDING: a restore to time T never keeps a change recorded after T (long-running transactions)', async () => {
    // A writer whose transaction began before T but committed after a quicker writer.
    const slow = await env.h.pool.connect();
    try {
      await slow.query('begin');
      await slow.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [env.tenantId, env.userId]);
      await slow.query('select now()'); // the transaction's clock starts here
      await pause(40);
      const T = await serverNow();
      await pause(40);
      const before = await env.head();
      const quick = await env.write([{ k: A, v: 777 }]); // made after T
      expect((await createdAt(quick.txn_id!)).t > T).toBe(true);
      await slow.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: env.appId, source: 'api', cells: [{ k: C, v: '888' }] })]);
      await slow.query('commit');

      // At T neither change had been committed; the quick one was not even begun.
      const r = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, at: T, dry_run: true }));
      expect(r.as_of.chain_seq).toBeLessThanOrEqual(before);
    } finally {
      slow.release();
    }
  });
});
