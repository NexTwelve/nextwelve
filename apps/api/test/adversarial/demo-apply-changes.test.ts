import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Api, createHarness, expectOk, type Harness, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { asUser } from './abuse-helpers.js';

/**
 * epm.apply_changes after 0010 (key-share lock on the application, indexed and analyzed temporary
 * table, joins on the whole coordinate array): large writes into an application that already has
 * data, and duplicate or conflicting writes.
 */
describe('adversarial apply_changes after 0010', () => {
  let h: Harness;
  let admin: Api;
  let tenantId: string;
  let appId: string;
  let ids: Record<string, Record<string, number>>;
  let cube: number;
  const EMAIL = 'admin@ac.test';
  const PRODUCTS = 556; // x 6 months x 2 entities x 3 accounts = 20,016 cells

  const su = async <T = any>(sql: string, params: unknown[] = []): Promise<T[]> => {
    const c = new pg.Client({ connectionString: h.db.superUrl });
    await c.connect();
    try {
      return (await c.query(sql, params)).rows as T[];
    } finally {
      await c.end();
    }
  };
  const key = (p: number, month: string, entity: string, account: string, version = 'Working') => {
    const k = new Array<number>(16).fill(0);
    k[0] = cube; k[1] = ids.Scenario!.Budget!; k[2] = ids.Version![version]!; k[3] = ids.Years!.FY27!; k[4] = ids.Period![month]!;
    k[5] = ids.Entity![entity]!; k[6] = ids.Account![account]!; k[7] = ids.Department!.Sales!; k[8] = ids.Product![`P${p}`]!;
    return k;
  };
  const allKeys = (version: string) => {
    const out: number[][] = [];
    for (let p = 0; p < PRODUCTS; p++) for (const m of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']) for (const e of ['East', 'West']) for (const a of ['Revenue', 'COGS', 'Opex']) out.push(key(p, m, e, a, version));
    return out;
  };
  const apply = (cells: unknown[], extra: Record<string, unknown> = {}) =>
    asUser(h.pool, tenantId, EMAIL, (c) => c.query<{ r: { txn_id: number | null; cell_count: number } }>('select epm.apply_changes($1::jsonb) as r', [
      JSON.stringify({ app_id: appId, source: 'api', cells, ...extra }),
    ])).then((r) => r.rows[0]!.r);
  const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
    const t = performance.now();
    const out = await fn();
    return [out, performance.now() - t];
  };
  const factCount = async () => (await su<{ n: number }>('select count(*)::int as n from epm.fact where app_id = $1', [appId]))[0]!.n;
  const pgCode = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? String(e));

  beforeAll(async () => {
    h = await createHarness();
    tenantId = await provisionTenant(h.db, 'Apply Co', null, EMAIL);
    admin = await signIn(h, EMAIL);
    appId = await seedPlanApp(admin);
    await su(
      `insert into epm.member (tenant_id, dim_id, name, parent_id, sort_order)
       select d.tenant_id, d.dim_id, 'P' || g, p.member_id, 100 + g
         from epm.dimension d join epm.member p on p.dim_id = d.dim_id and p.name = 'All Products', generate_series(0, $2 - 1) g
        where d.app_id = $1 and d.name = 'Product'`,
      [appId, PRODUCTS],
    );
    expectOk(await admin.post(`/v1/apps/${appId}/deploy`));
    const rows = await su<{ dim: string; name: string; member_id: number }>(
      'select d.name as dim, m.name, m.member_id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1', [appId]);
    ids = {};
    for (const r of rows) (ids[r.dim] ??= {})[r.name] = r.member_id;
    cube = (await su<{ cube_id: number }>("select cube_id from epm.cube where app_id = $1 and name = 'Plan'", [appId]))[0]!.cube_id;
  }, 30_000);
  afterAll(async () => h?.close());

  it('writes ~20,000 cells into an empty application, then ~20,000 more into one that has them, in seconds', async () => {
    const working = allKeys('Working');
    expect(working.length).toBe(20_016);
    const [first, t1] = await timed(() => apply(working.map((k, i) => ({ k, v: 1 + (i % 97) }))));
    expect(first.cell_count).toBe(20_016);
    // The case 0010 fixed: the application already holds 20,000 cells.
    const [second, t2] = await timed(() => apply(allKeys('Final').map((k, i) => ({ k, v: 2 + (i % 89) }))));
    expect(second.cell_count).toBe(20_016);
    expect(await factCount()).toBe(40_032);
    // Every existing cell changed at once (the update path joins the same way).
    const [third, t3] = await timed(() => apply(working.map((k, i) => ({ k, v: 1000 + (i % 97) }))));
    expect(third.cell_count).toBe(20_016);
    // Half unchanged, a quarter cleared, a quarter changed: only real changes count.
    const final = allKeys('Final');
    const [fourth, t4] = await timed(() => apply(final.map((k, i) => ({ k, v: i % 4 === 0 ? null : i % 4 === 1 ? 5_000_000 : 2 + (i % 89) }))));
    expect(fourth.cell_count).toBe(final.filter((_, i) => i % 4 < 2).length);
    expect(await factCount()).toBe(40_032 - final.filter((_, i) => i % 4 === 0).length);
    // Before 0010 the second write took ~25 s; it should now take a second or two (generous margin for CI).
    for (const [label, ms] of [['empty', t1], ['into 20k', t2], ['update 20k', t3], ['mixed 20k', t4]] as const) {
      expect(ms, `${label}: ${Math.round(ms)} ms`).toBeLessThan(6000);
    }
    const audit = (await su<{ n: number }>('select count(*)::int as n from epm.cell_audit where app_id = $1', [appId]))[0]!.n;
    expect(audit).toBe(20_016 * 3 + fourth.cell_count);
    const verify = expectOk(await admin.post(`/v1/apps/${appId}/audit/verify`, {}));
    expect(verify).toMatchObject({ ok: true });
  }, 40_000);

  it('refuses one cell given twice in a request, however its coordinates are spelled, and writes nothing', async () => {
    const before = await factCount();
    const k = key(1, 'Jan', 'East', 'Revenue', 'Working');
    expect(await pgCode(apply([{ k, v: 1 }, { k, v: 2 }]))).toBe('NX422');
    expect(await pgCode(apply([{ k, v: 1 }, { k: k.map(String), v: 2 }]))).toBe('NX422');
    expect(await pgCode(apply([{ k, v: 1 }, { k: k.map((x) => `0${x}`), v: null }]))).toBe('NX422');
    expect(await factCount()).toBe(before);
  });

  it('a value that rounds to what is stored, or the same value, is no change and no transaction', async () => {
    const k = key(2, 'Feb', 'West', 'COGS', 'Working');
    await apply([{ k, v: 12.5 }]);
    expect(await apply([{ k, v: 12.5 }])).toEqual({ txn_id: null, cell_count: 0 });
    expect(await apply([{ k, v: '12.5000004' }])).toEqual({ txn_id: null, cell_count: 0 });
    expect(await apply([{ k, v: '12.50000' }])).toEqual({ txn_id: null, cell_count: 0 });
    for (const bad of ['NaN', 'Infinity', '-Infinity', '1e30', 'abc']) expect(await pgCode(apply([{ k, v: bad }])), bad).toMatch(/^(NX422|22003|22P02)$/);
    const [row] = await su<{ value: string }>('select value::text from epm.fact where app_id = $1 and cube_id = $2 and period_id = $3 and entity_id = $4 and account_id = $5 and c1 = $6 and version_id = $7',
      [appId, cube, k[4], k[5], k[6], k[8], k[2]]);
    expect(row!.value).toBe('12.500000');
  });

  it('two writers creating the same new cells: the later one wins, and audit and chain agree', async () => {
    const cells = Array.from({ length: 2000 }, (_, i) => key(100 + Math.floor(i / 36), ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'][Math.floor(i / 6) % 6]!, i % 2 ? 'East' : 'West', ['Revenue', 'COGS', 'Opex'][i % 3]!, 'Working'))
      .map((k) => { const x = [...k]; x[1] = ids.Scenario!.Actual!; return x; });
    expect(new Set(cells.map((k) => k.join())).size).toBe(2000);
    const user = (await su<{ user_id: string }>('select user_id from epm.app_user where email = $1', [EMAIL]))[0]!.user_id;
    const conn = async () => {
      const c = await h.pool.connect();
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantId, user]);
      return c;
    };
    const w1 = await conn();
    const w2 = await conn();
    const txns: number[] = [];
    try {
      const r1 = await w1.query('select epm.apply_changes($1::jsonb) as r', [JSON.stringify({ app_id: appId, source: 'api', cells: cells.map((k) => ({ k, v: 1 })) })]);
      expect(r1.rows[0].r.cell_count).toBe(2000);
      // The second writer read the cells as missing and now waits on the first one's inserts.
      const p2 = w2.query('select epm.apply_changes($1::jsonb) as r', [JSON.stringify({ app_id: appId, source: 'api', cells: cells.map((k, i) => ({ k, v: i % 2 ? 1 : 2 })) })]);
      await new Promise((r) => setTimeout(r, 300));
      await w1.query('commit');
      const r2 = await p2;
      await w2.query('commit');
      // Only the cells whose value really changed count for the second writer.
      expect(r2.rows[0].r.cell_count).toBe(1000);
      txns.push(r1.rows[0].r.txn_id, r2.rows[0].r.txn_id);
      expect(txns[1]).toBeGreaterThan(txns[0]!);
    } finally {
      w1.release();
      w2.release();
    }
    const scen = ids.Scenario!.Actual!;
    const vals = await su<{ value: number; n: number }>('select value::float8 as value, count(*)::int as n from epm.fact where app_id = $1 and scenario_id = $2 group by 1 order by 1', [appId, scen]);
    expect(vals).toEqual([{ value: 1, n: 1000 }, { value: 2, n: 1000 }]);
    const lastAudit = await su<{ n: number }>(
      `with last as (
         select distinct on (coords) coords, txn_id, new_value from epm.cell_audit
          where app_id = $1 and txn_id = any($2::bigint[]) order by coords, txn_id desc)
       select count(*)::int as n from last l join epm.fact f
         on f.app_id = $1 and f.cube_id = l.coords[1] and f.scenario_id = l.coords[2] and f.version_id = l.coords[3]
        and f.years_id = l.coords[4] and f.period_id = l.coords[5] and f.entity_id = l.coords[6] and f.account_id = l.coords[7]
        and f.department_id = l.coords[8] and f.c1 = l.coords[9] and f.c2 = l.coords[10] and f.c3 = l.coords[11] and f.c4 = l.coords[12]
        and f.c5 = l.coords[13] and f.c6 = l.coords[14] and f.c7 = l.coords[15] and f.c8 = l.coords[16]
       where l.txn_id = f.rev and l.new_value = f.value`, [appId, txns]);
    // Every cell's current value is what its latest audit row says, and the revision points at it.
    expect(lastAudit[0]!.n).toBe(2000);
    expect(expectOk(await admin.post(`/v1/apps/${appId}/audit/verify`, {}))).toMatchObject({ ok: true });
  });

  it('with check_rev, a writer that expected an empty cell is refused when another created it first', async () => {
    const k = key(200, 'Jun', 'East', 'Opex', 'Working');
    const x = [...k];
    x[1] = ids.Scenario!.Actual!;
    await apply([{ k: x, v: 3 }]);
    expect(await pgCode(apply([{ k: x, v: 4, r: null }], { check_rev: true }))).toBe('NX409');
  });
});
