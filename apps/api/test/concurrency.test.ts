import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn } from './helpers.js';

/** Real concurrent transactions against apply_changes, as two API workers would run them. */
describe('concurrent writers', () => {
  let h: Harness;
  let ctx: { tenant: string; user: string; app: string; cube: number; ids: Record<string, number> };

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Conc', null, 'admin@conc.test');
    const admin = await signIn(h, 'admin@conc.test');
    const app = await seedPlanApp(admin);
    expectOk(await admin.get('/v1/me'));
    const su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    const ids = Object.fromEntries((await su.query('select name, member_id from epm.member')).rows.map((r) => [r.name, r.member_id]));
    const u = (await su.query("select user_id, tenant_id from epm.app_user where email = 'admin@conc.test'")).rows[0];
    const cube = (await su.query("select cube_id from epm.cube where name = 'Plan'")).rows[0].cube_id;
    await su.end();
    ctx = { tenant: u.tenant_id, user: u.user_id, app, cube, ids };
  });
  afterAll(async () => h?.close());

  function k(period: string, account: string) {
    const { ids, cube } = ctx;
    return [cube, ids.Budget, ids.Working, ids.FY27, ids[period], ids.East, ids[account], ids.Sales, ids.Widgets, 0, 0, 0, 0, 0, 0, 0];
  }

  async function session() {
    const c = await h.pool.connect();
    await c.query('begin');
    await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [ctx.tenant, ctx.user]);
    return c;
  }

  function apply(c: pg.PoolClient, cells: unknown[], check = true) {
    return c.query('select epm.apply_changes($1::jsonb) as r', [
      JSON.stringify({ app_id: ctx.app, source: 'grid_submit', check_rev: check, cells }),
    ]);
  }

  it('lets only one of two planners create the same empty cell', async () => {
    const a = await session();
    const b = await session();
    try {
      await apply(a, [{ k: k('Apr', 'Revenue'), v: 1, r: null }]);
      // B blocks on A's uncommitted insert, then sees A's row once A commits.
      const pending = apply(b, [{ k: k('Apr', 'Revenue'), v: 2, r: null }]).then(
        () => 'saved',
        (e) => e.code,
      );
      await new Promise((r) => setTimeout(r, 150));
      await a.query('commit');
      expect(await pending).toBe('NX409');
    } finally {
      await b.query('rollback').catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it('serialises updates to an existing cell and catches the stale one', async () => {
    const a = await session();
    const b = await session();
    try {
      const rev = (await a.query('select rev from epm.fact where period_id = $1 and account_id = $2', [ctx.ids.Apr, ctx.ids.Revenue])).rows[0].rev;
      await apply(a, [{ k: k('Apr', 'Revenue'), v: 10, r: rev }]);
      const pending = apply(b, [{ k: k('Apr', 'Revenue'), v: 20, r: rev }]).then(
        () => 'saved',
        (e) => e.code,
      );
      await new Promise((r) => setTimeout(r, 150));
      await a.query('commit');
      expect(await pending).toBe('NX409');
    } finally {
      await b.query('rollback').catch(() => undefined);
      a.release();
      b.release();
    }
  });

  it('keeps the hash chain intact under parallel submits', async () => {
    const months = ['Jan', 'Feb', 'Mar', 'May', 'Jun'];
    const accounts = ['Revenue', 'COGS', 'Opex'];
    await Promise.all(
      months.flatMap((m) =>
        accounts.map(async (acct, n) => {
          const c = await session();
          try {
            await apply(c, [{ k: k(m, acct), v: n + 1 }], false);
            await c.query('commit');
          } finally {
            c.release();
          }
        }),
      ),
    );
    const c = await session();
    try {
      const seqs = (await c.query('select chain_seq from epm.change_txn where app_id = $1 order by chain_seq', [ctx.app])).rows.map((r) => r.chain_seq);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      const verify = (await c.query('select epm.verify_chain($1) as r', [ctx.app])).rows[0].r;
      expect(verify).toMatchObject({ ok: true, checked: seqs.length });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
