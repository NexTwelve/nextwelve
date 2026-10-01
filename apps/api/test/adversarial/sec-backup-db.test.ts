import { gunzipSync, strFromU8 } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runNightlySnapshots } from '../../src/backup/snapshots.js';
import { poolDatabase } from '../../src/db.js';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Adversarial, straight to Postgres as the API's login role (epm_app): the new SECURITY DEFINER
 * functions epm.restore_slice / epm.snapshot_targets and the epm.snapshot table.
 */
const R = { REV: 2, OPEX: 4 };
const C = { JAN: 0, FEB: 1 };

interface AppIds { app: string; cube: number; budget: number; working: number; final: number; east: number; west: number; revenue: number }

describe('backup at the database level', () => {
  let h: Harness;
  let su: pg.Client;
  let tenantA: string;
  let tenantB: string;
  let adminA: string; // user ids
  let adminB: string;
  let plannerA: string;
  let adminYA: string;
  let X: AppIds;
  let Y: AppIds;
  let BX: AppIds;
  let snapB: string;
  let headX: number;

  async function edit(api: Api, base: string, edits: [number, number, number | null][], pov = PLAN_POV): Promise<number> {
    const g = expectOk(await api.post(`${base}/grid/read`, planGrid(pov)));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await api.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).txn_id;
  }
  async function ids(app: string): Promise<AppIds> {
    const m = async (dimType: string, name: string) =>
      (await su.query<{ id: number }>(
        `select m.member_id as id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1 and d.dim_type = $2 and m.name = $3`,
        [app, dimType, name],
      )).rows[0]!.id;
    const cube = (await su.query<{ id: number }>('select cube_id as id from epm.cube where app_id = $1', [app])).rows[0]!.id;
    return {
      app, cube, budget: await m('scenario', 'Budget'), working: await m('version', 'Working'), final: await m('version', 'Final'),
      east: await m('entity', 'East'), west: await m('entity', 'West'), revenue: await m('account', 'Revenue'),
    };
  }
  async function userId(email: string) {
    return (await su.query<{ id: string }>('select user_id as id from epm.app_user where email = $1', [email])).rows[0]!.id;
  }
  async function counts() {
    const r = await su.query<{ txns: number; facts: number; snaps: number }>(
      `select (select count(*)::int from epm.change_txn) as txns, (select count(*)::int from epm.fact) as facts,
              (select count(*)::int from epm.snapshot) as snaps`,
    );
    return r.rows[0]!;
  }

  /** One transaction as epm_app with the given session settings; always rolled back. */
  async function asApp<T>(tenant: string | null, user: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      if (tenant !== null) await c.query("select set_config('app.tenant_id', $1, true)", [tenant]);
      if (user !== null) await c.query("select set_config('app.user_id', $1, true)", [user]);
      return await fn(c);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }
  async function tryIn(c: pg.PoolClient, sql: string, params: unknown[]): Promise<{ ok: true; rows: any[] } | { ok: false; code: string; message: string }> {
    await c.query('savepoint t');
    try {
      const r = await c.query(sql, params);
      await c.query('release savepoint t');
      return { ok: true, rows: r.rows };
    } catch (err) {
      await c.query('rollback to savepoint t');
      return { ok: false, code: (err as any).code, message: (err as Error).message };
    }
  }
  const slice = (a: AppIds, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ app_id: a.app, cube_id: a.cube, scenario_id: a.budget, version_id: a.working, as_of_seq: 0, ...extra });

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    tenantA = await provisionTenant(h.db, 'DB A', null, 'admin@dba.test');
    tenantB = await provisionTenant(h.db, 'DB B', null, 'admin@dbb.test');
    const a = await signIn(h, 'admin@dba.test');
    const b = await signIn(h, 'admin@dbb.test');
    const xId = await seedPlanApp(a, 'X');
    const yId = await seedPlanApp(a, 'Y');
    const bId = await seedPlanApp(b, 'X');
    expectOk(await a.post('/v1/users', { email: 'planner@dba.test' }), 201);
    expectOk(await a.post(`/v1/apps/${xId}/roles`, { email: 'planner@dba.test', role: 'planner' }));
    expectOk(await a.put(`/v1/apps/${xId}/grants`, { grants: [{ principal: { user: 'planner@dba.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' }] }));
    await signIn(h, 'planner@dba.test');
    expectOk(await a.post('/v1/users', { email: 'ya@dba.test' }), 201);
    expectOk(await a.post(`/v1/apps/${yId}/roles`, { email: 'ya@dba.test', role: 'app_admin' }));
    await signIn(h, 'ya@dba.test');

    await edit(a, `/v1/apps/${xId}`, [[R.REV, C.JAN, 10], [R.REV, C.FEB, 20]]);
    await edit(a, `/v1/apps/${xId}`, [[R.REV, C.JAN, 11], [R.OPEX, C.JAN, 3]]);
    await edit(a, `/v1/apps/${yId}`, [[R.REV, C.JAN, 77]]);
    await edit(b, `/v1/apps/${bId}`, [[R.REV, C.JAN, 99]]);
    expectOk(await a.post(`/v1/apps/${xId}/snapshots`, {}), 201);
    snapB = expectOk(await b.post(`/v1/apps/${bId}/snapshots`, {}), 201).snapshot_id;

    X = await ids(xId);
    Y = await ids(yId);
    BX = await ids(bId);
    adminA = await userId('admin@dba.test');
    adminB = await userId('admin@dbb.test');
    plannerA = await userId('planner@dba.test');
    adminYA = await userId('ya@dba.test');
    headX = (await su.query<{ s: number }>('select max(chain_seq)::int as s from epm.change_txn where app_id = $1', [xId])).rows[0]!.s;
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  // ---------------------------------------------------------------------------
  // restore_slice
  // ---------------------------------------------------------------------------
  it('sanity: the service admin can preview a restore of their own slice directly', async () => {
    const r = await asApp(tenantA, adminA, (c) => c.query('select epm.restore_slice($1::jsonb) as r', [slice(X, { dry_run: true })]));
    expect(r.rows[0].r).toMatchObject({ dry_run: true, cells_cleared: 3 });
  });

  it("restore_slice: a tenant A service admin cannot reach tenant B's application or cube", async () => {
    const before = await counts();
    await asApp(tenantA, adminA, async (c) => {
      // B's app and cube (service_admin passes the role check for any uuid; RLS must stop the rest).
      const a = await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(BX)]);
      expect(a).toMatchObject({ ok: false, code: 'NX404' });
      // A's app with B's cube id.
      const b = await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(X, { cube_id: BX.cube })]);
      expect(b).toMatchObject({ ok: false, code: 'NX404' });
      // B's app with A's cube.
      const d = await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice({ ...X, app: BX.app })]);
      expect(d).toMatchObject({ ok: false, code: 'NX404' });
    });
    // Forged session: tenant B with tenant A's user id is not an active user there.
    await asApp(tenantB, adminA, async (c) => {
      expect(await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(BX)])).toMatchObject({ ok: false, code: 'NX401' });
    });
    expect(await counts()).toEqual(before);
  });

  it('restore_slice: refuses non-admins, admins of another app, and sessions without a user', async () => {
    await asApp(tenantA, plannerA, async (c) => {
      expect(await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(X, { dry_run: true })])).toMatchObject({ ok: false, code: 'NX403' });
    });
    await asApp(tenantA, adminYA, async (c) => {
      expect(await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(X, { dry_run: true })])).toMatchObject({ ok: false, code: 'NX403' });
      // Y's admin naming Y's app but X's cube.
      expect(await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(Y, { cube_id: X.cube })])).toMatchObject({ ok: false, code: 'NX404' });
    });
    await asApp(tenantA, null, async (c) => {
      expect(await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(X)])).toMatchObject({ ok: false, code: 'NX401' });
    });
  });

  it('restore_slice: a target version from another application or dimension writes nothing there', async () => {
    const before = await su.query('select * from epm.fact where app_id = $1 order by value', [Y.app]);
    await asApp(tenantA, adminA, async (c) => {
      for (const target of [Y.final, Y.working, X.east, BX.final, 0, -5]) {
        const r = await tryIn(c, 'select epm.restore_slice($1::jsonb) as r', [slice(X, { as_of_seq: 1, target_version_id: target })]);
        if (r.ok) expect(r.rows[0].r, `target ${target}`).toMatchObject({ cells_set: 0, cells_cleared: 0, txn_id: null });
        else expect(['NX422', 'NX403', 'NX404'], `target ${target}: ${r.message}`).toContain(r.code);
      }
      const after = await c.query('select count(*)::int as n from epm.change_txn where app_id = $1', [Y.app]);
      expect(after.rows[0].n).toBe(1);
    });
    expect((await su.query('select * from epm.fact where app_id = $1 order by value', [Y.app])).rows).toEqual(before.rows);
  });

  it('restore_slice: filter payloads cannot inject SQL or escape the index bounds', async () => {
    const hostile: [string, unknown][] = [
      ['i as SQL', [{ i: '6) or (1=1', ids: [X.east] }]],
      ['i with comment', [{ i: '6 --', ids: [X.east] }]],
      ['ids closing the literal', [{ i: 6, ids: ["1}'::int[]) or true or (a.coords[1] = any('{1"] }]],
      ['ids with drop', [{ i: 6, ids: ['1); drop table epm.snapshot; --'] }]],
      ['ids nested arrays', [{ i: 6, ids: [[X.east, X.west]] }]],
      ['ids object', [{ i: 6, ids: { a: X.east } }]],
      ['ids scalar string', [{ i: 6, ids: `${X.east}` }]],
      ['ids float', [{ i: 6, ids: [1.5] }]],
      ['ids huge', [{ i: 6, ids: [99999999999] }]],
      ['i = 1 (cube)', [{ i: 1, ids: [X.cube] }]],
      ['i = 2 (scenario)', [{ i: 2, ids: [X.budget] }]],
      ['i = 3 (version)', [{ i: 3, ids: [X.final] }]],
      ['i = 0', [{ i: 0, ids: [1] }]],
      ['i = -1', [{ i: -1, ids: [1] }]],
      ['i = 17', [{ i: 17, ids: [1] }]],
      ['i huge', [{ i: 2147483648, ids: [1] }]],
      ['i null', [{ i: null, ids: [1] }]],
      ['i missing', [{ ids: [1] }]],
      ['i float', [{ i: 6.5, ids: [1] }]],
      ['filters object', { i: 6, ids: [1] }],
      ['filters string', "[{\"i\":6,\"ids\":[1]}]); drop table epm.snapshot; --"],
    ];
    const before = await counts();
    await asApp(tenantA, adminA, async (c) => {
      for (const [label, filters] of hostile) {
        const r = await tryIn(c, 'select epm.restore_slice($1::jsonb) as r', [slice(X, { as_of_seq: 1, filters })]);
        if (r.ok) {
          // Anything accepted must be a harmless no-op preview-equivalent (nothing outside the filter).
          throw new Error(`${label} was accepted: ${JSON.stringify(r.rows[0].r)}`);
        }
        expect(['NX422', '22P02', '22003', '22023', '42804'], `${label}: ${r.code} ${r.message}`).toContain(r.code);
      }
      // The tables are all still there.
      expect((await c.query("select to_regclass('epm.snapshot') is not null as ok")).rows[0].ok).toBe(true);
    });
    expect(await counts()).toEqual(before);
  });

  it('restore_slice: a well-formed filter restores only inside the filter', async () => {
    await asApp(tenantA, adminA, async (c) => {
      // Back to the start, but only West: nothing was ever written to West in X.
      const r = await c.query('select epm.restore_slice($1::jsonb) as r', [slice(X, { filters: [{ i: 6, ids: [X.west] }] })]);
      expect(r.rows[0].r).toMatchObject({ cells_set: 0, cells_cleared: 0, txn_id: null });
      // Null ids and empty id lists match nothing.
      const n = await c.query('select epm.restore_slice($1::jsonb) as r', [slice(X, { filters: [{ i: 6, ids: [null] }] })]);
      expect(n.rows[0].r).toMatchObject({ cells_set: 0, cells_cleared: 0 });
      const e = await c.query('select epm.restore_slice($1::jsonb) as r', [slice(X, { filters: [{ i: 6, ids: [] }] })]);
      expect(e.rows[0].r).toMatchObject({ cells_set: 0, cells_cleared: 0 });
    });
  });

  it('restore_slice: rejects points in the future and negative points', async () => {
    await asApp(tenantA, adminA, async (c) => {
      expect(await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(X, { as_of_seq: headX + 1 })])).toMatchObject({ ok: false, code: 'NX422' });
      expect(await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(X, { as_of_seq: -1 })])).toMatchObject({ ok: false, code: 'NX422' });
      expect(await tryIn(c, 'select epm.restore_slice($1::jsonb)', [slice(X, { as_of_seq: '1; select 1' })])).toMatchObject({ ok: false, code: '22P02' });
    });
  });

  it("a planner cannot reach a 'restore' write through apply_changes or undo another author's restore", async () => {
    // First a real restore by the admin (committed), then the planner tries to undo it directly.
    const c0 = await h.pool.connect();
    let txn: number;
    try {
      await c0.query('begin');
      await c0.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantA, adminA]);
      txn = (await c0.query('select epm.restore_slice($1::jsonb) as r', [slice(X, { as_of_seq: 1, filters: [{ i: 6, ids: [X.east] }] })])).rows[0].r.txn_id;
      await c0.query('commit');
    } finally {
      c0.release();
    }
    expect(txn!).toBeGreaterThan(0);
    const cell = [X.cube, X.budget, X.working, 0, 0, X.east, X.revenue, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const k = (await su.query<{ coords: number[] }>('select coords from epm.cell_audit where txn_id = $1 limit 1', [txn!])).rows[0]!.coords;
    await asApp(tenantA, plannerA, async (c) => {
      const restore = await tryIn(c, 'select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: X.app, source: 'restore', cells: [{ k, v: 1 }] })]);
      expect(restore).toMatchObject({ ok: false, code: 'NX403' });
      const undo = await tryIn(c, 'select epm.undo_txn($1, true)', [txn!]);
      expect(undo).toMatchObject({ ok: false, code: 'NX403' });
      expect(cell.length).toBe(16);
    });
    // The chain is intact after the direct restore.
    await asApp(tenantA, adminA, async (c) => {
      expect((await c.query('select epm.verify_chain($1) as r', [X.app])).rows[0].r).toMatchObject({ ok: true });
    });
  });

  // ---------------------------------------------------------------------------
  // epm.snapshot rows
  // ---------------------------------------------------------------------------
  it("epm.snapshot: tenant A cannot read, insert, update or delete tenant B's rows", async () => {
    await asApp(tenantA, adminA, async (c) => {
      expect((await c.query('select count(*)::int as n from epm.snapshot where tenant_id = $1', [tenantB])).rows[0].n).toBe(0);
      expect((await c.query('select count(*)::int as n from epm.snapshot where snapshot_id = $1', [snapB])).rows[0].n).toBe(0);
      const ins = await tryIn(
        c,
        `insert into epm.snapshot (tenant_id, app_id, app_name, kind, schema_ver, storage_prefix, status)
         values ($1, $2, 'evil', 'manual', 1, 'x', 'complete')`,
        [tenantB, BX.app],
      );
      expect(ins).toMatchObject({ ok: false, code: '42501' });
      const upd = await tryIn(c, "update epm.snapshot set status = 'expired' where snapshot_id = $1 or tenant_id = $2", [snapB, tenantB]);
      expect(upd.ok && (upd as any).rows).toEqual([]);
      // Moving one of A's own rows into B is refused by the policy's WITH CHECK.
      const move = await tryIn(c, 'update epm.snapshot set tenant_id = $1 where tenant_id = $2', [tenantB, tenantA]);
      expect(move).toMatchObject({ ok: false, code: '42501' });
      const del = await tryIn(c, 'delete from epm.snapshot where tenant_id = $1', [tenantA]);
      expect(del).toMatchObject({ ok: false, code: '42501' });
    });
    expect((await su.query("select status from epm.snapshot where snapshot_id = $1", [snapB])).rows[0].status).toBe('complete');
  });

  it('epm.snapshot: nothing is visible without a tenant in the session', async () => {
    await asApp(null, null, async (c) => {
      expect((await c.query('select count(*)::int as n from epm.snapshot')).rows[0].n).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // snapshot_targets
  // ---------------------------------------------------------------------------
  it('snapshot_targets refuses to run inside a tenant session, and leaves no tenant behind', async () => {
    await asApp(tenantA, adminA, async (c) => {
      expect(await tryIn(c, 'select * from epm.snapshot_targets($1)', [h.db.jobKey])).toMatchObject({ ok: false, code: 'NX422' });
    });
    await asApp(null, null, async (c) => {
      await c.query('select * from epm.snapshot_targets($1)', [h.db.jobKey]);
      // The function switched tenants internally; afterwards the session must hold none.
      expect((await c.query("select coalesce(current_setting('app.tenant_id', true), '') as t")).rows[0].t).toBe('');
      expect((await c.query('select count(*)::int as n from epm.fact')).rows[0].n).toBe(0);
      expect((await c.query('select count(*)::int as n from epm.application')).rows[0].n).toBe(0);
      // In a single statement next to a tenant table read, too.
      const both = await c.query('select (select count(*) from epm.snapshot_targets($1))::int as t, (select count(*) from epm.fact)::int as f', [h.db.jobKey]);
      expect(both.rows[0].f).toBe(0);
    });
  });

  it('the nightly cross-tenant job files each application under its own tenant, with only its own data', async () => {
    const results = await runNightlySnapshots({ db: poolDatabase(h.pool), blobs: h.blobs }, { jobKey: h.db.jobKey });
    expect(results.every((r) => r.status !== 'failed')).toBe(true);
    const rows = (await su.query<{ snapshot_id: string; tenant_id: string; app_id: string; storage_prefix: string; manifest: any }>(
      `select snapshot_id, tenant_id, app_id, storage_prefix, manifest from epm.snapshot where kind = 'nightly'`,
    )).rows;
    expect(new Set(rows.map((r) => r.tenant_id))).toEqual(new Set([tenantA, tenantB]));
    for (const r of rows) {
      const owner = (await su.query<{ t: string }>('select tenant_id as t from epm.application where app_id = $1', [r.app_id])).rows[0]!.t;
      expect(r.tenant_id).toBe(owner);
      expect(r.storage_prefix).toBe(`${owner}/${r.app_id}/snapshots/${r.snapshot_id}`);
      expect(r.manifest).toMatchObject({ tenant_id: owner, app_id: r.app_id });
      const cubes = new Set((await su.query<{ id: number }>('select cube_id as id from epm.cube where app_id = $1', [r.app_id])).rows.map((x) => x.id));
      const members = new Set((await su.query<{ id: number }>(
        'select m.member_id as id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1', [r.app_id])).rows.map((x) => x.id));
      for (const f of r.manifest.files.filter((x: any) => x.name.startsWith('facts-'))) {
        const text = strFromU8(gunzipSync((await h.blobs.get(`${r.storage_prefix}/${f.name}`))!));
        for (const line of text.split('\n').filter(Boolean)) {
          const k = JSON.parse(line) as number[];
          expect(cubes.has(k[0]!)).toBe(true);
          for (const id of k.slice(1, 16)) if (id !== 0) expect(members.has(id), `member ${id} of another app in ${r.app_id}`).toBe(true);
        }
      }
      const meta = JSON.parse(strFromU8(gunzipSync((await h.blobs.get(`${r.storage_prefix}/metadata.json.gz`))!)));
      expect(meta.members.every((m: any) => members.has(m.member_id))).toBe(true);
    }
    const ev = (await su.query<{ tenant_id: string; app_id: string; user_id: string | null }>(
      `select tenant_id, app_id, user_id from epm.security_event where event_type = 'snapshot_created' and detail->>'kind' = 'nightly'`)).rows;
    for (const e of ev) {
      expect(e.user_id).toBeNull();
      expect((await su.query<{ t: string }>('select tenant_id as t from epm.application where app_id = $1', [e.app_id])).rows[0]!.t).toBe(e.tenant_id);
    }
    // No pooled connection keeps a tenant from the job.
    const conns = await Promise.all(Array.from({ length: 4 }, () => h.pool.connect()));
    try {
      for (const c of conns) {
        expect((await c.query("select coalesce(current_setting('app.tenant_id', true), '') as t")).rows[0].t).toBe('');
        expect((await c.query('select count(*)::int as n from epm.snapshot')).rows[0].n).toBe(0);
      }
    } finally {
      for (const c of conns) c.release();
    }
  });

  it('snapshot_targets does not hand the API login role the ids of every tenant and application', async () => {
    // The API role, with no tenant in the session (as during login), learns nothing about tenants
    // from any table (rls.test.ts). The nightly listing must not undo that.
    // Without the job key (held only by the scheduled Worker) the listing is refused.
    const attempts: [string, unknown[]][] = [
      ['select tenant_id, app_id from epm.snapshot_targets()', []],
      ['select tenant_id, app_id from epm.snapshot_targets($1)', [null]],
      ['select tenant_id, app_id from epm.snapshot_targets($1)', ['']],
      ['select tenant_id, app_id from epm.snapshot_targets($1)', ['x'.repeat(43)]],
      ['select tenant_id, app_id from epm.snapshot_targets($1)', [h.db.jobKey.slice(0, -1)]],
    ];
    const leaked: unknown[] = [];
    for (const [sql, params] of attempts) {
      leaked.push(...(await asApp(null, null, async (c) => { const r = await tryIn(c, sql, params); return r.ok ? r.rows : []; })));
      // A tenant-less session that also names a user (the shape of a forged session).
      leaked.push(...(await asApp('', adminA, async (c) => { const r = await tryIn(c, sql, params); return r.ok ? r.rows : []; })));
    }
    const tenants = new Set(leaked.map((r: any) => r.tenant_id));
    expect([...tenants], 'tenant ids disclosed to epm_app with no tenant in the session').toEqual([]);
  });
});
