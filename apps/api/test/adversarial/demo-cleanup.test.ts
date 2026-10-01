import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { poolDatabase } from '../../src/db.js';
import { sweepDemoTenants } from '../../src/demo.js';
import { type Api, expectOk, PLAN_POV, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { ADMIN, buildTemplate, createDemoHarness, type DemoHarness, leftovers, sleep, startDemo, startOk, su } from './demo-helpers.js';

/** Removing demo copies: completely, never a real tenant, and under in-flight work or failures. */
describe('adversarial demo: cleanup', () => {
  let h: DemoHarness;
  let realAdmin: Api;
  let realTenant: string;
  let realApp: string;

  const deps = () => ({ db: poolDatabase(h.pool), blobs: h.blobs });
  const expire = (tenantId: string) => su(h, "update epm.tenant set demo_expires_at = now() - interval '1 second' where tenant_id = $1", [tenantId]);
  const read = (api: Api, appId: string) => api.post(`/v1/apps/${appId}/grid/read`, {
    cube: 'Plan', pov: PLAN_POV, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] },
  });
  /** A connection as epm_app, with optional tenant and user in the transaction. */
  const appConn = async () => {
    const c = new pg.Client({ connectionString: h.db.appUrl });
    await c.connect();
    return c;
  };
  /** Coordinates of Plan cells in a copy, as apply_changes wants them. */
  const coords = async (appId: string, accounts: string[]) => {
    const rows = await su<{ dim: string; name: string; member_id: number }>(h,
      'select d.name as dim, m.name, m.member_id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1', [appId]);
    const id = (dim: string, name: string) => rows.find((r) => r.dim === dim && r.name === name)!.member_id;
    const [cube] = await su<{ cube_id: number }>(h, "select cube_id from epm.cube where app_id = $1 and name = 'Plan'", [appId]);
    return accounts.map((a) => {
      const k = new Array<number>(16).fill(0);
      k[0] = cube!.cube_id; k[1] = id('Scenario', 'Actual'); k[2] = id('Version', 'Final'); k[3] = id('Years', 'FY27'); k[4] = id('Period', 'Mar');
      k[5] = id('Entity', 'West'); k[6] = id('Account', a); k[7] = id('Department', 'Operations'); k[8] = id('Product', 'Gadgets');
      return k;
    });
  };

  beforeAll(async () => {
    h = await createDemoHarness();
    realTenant = await provisionTenant(h.db, 'Real Co', null, 'cfo@real.test');
    realAdmin = await signIn(h, 'cfo@real.test');
    realApp = await seedPlanApp(realAdmin, 'Real Plan');
    const g = expectOk(await read(realAdmin, realApp));
    expectOk(await realAdmin.post(`/v1/apps/${realApp}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[777]] }));
    expectOk(await realAdmin.post(`/v1/apps/${realApp}/snapshots`, {}), 201);
    await buildTemplate(h);
  }, 40_000);
  afterAll(async () => h?.close());

  it('the template build leaves nothing behind, and its table and the sign-up log are closed to the API role', async () => {
    const tenants = await su(h, 'select name from epm.tenant');
    expect(tenants.map((t) => t.name)).toEqual(['Real Co']);
    const c = await appConn();
    try {
      for (const sql of ['select * from epm.demo_template', 'select * from epm.demo_signup', 'select epm.purge_tenant($1)']) {
        const err = await c.query(sql, sql.includes('$1') ? [realTenant] : []).then(() => null, (e: { code?: string }) => e.code);
        expect(err, sql).toBe('42501');
      }
      expect((await c.query("select count(*)::int as n from epm.demo_template_files() where name = 'manifest.json'")).rows[0].n).toBe(1);
    } finally {
      await c.end();
    }
  });

  it('no path for the API role marks a tenant as a demo or purges or sweeps one without the key', async () => {
    const c = await appConn();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true)", [realTenant]);
      const upd = await c.query("update epm.tenant set demo_expires_at = now() - interval '1 day'").then(() => null, (e: { code?: string }) => e.code);
      expect(upd).toBe('42501');
      await c.query('rollback');
      // A session of the real tenant cannot end it, start a demo inside it or sweep.
      await c.query('begin');
      const user = (await su(h, "select user_id from epm.app_user where email = 'cfo@real.test'"))[0].user_id;
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [realTenant, user]);
      const end = await c.query('select epm.end_demo()').then(() => null, (e: { code?: string }) => e.code);
      expect(end).toBe('NX403');
      await c.query('rollback');
      for (const [sql, params] of [
        ['select * from epm.sweep_demo_tenants($1)', ['x'.repeat(40)]],
        ['select * from epm.sweep_demo_tenants($1)', [null]],
        ["select epm.start_demo(decode(repeat('ab', 32), 'hex'), 10, 10, 10, 1, '[]')", []],
      ] as [string, unknown[]][]) {
        await c.query('begin');
        await c.query("select set_config('app.tenant_id', $1, true)", [realTenant]);
        const code = await c.query(sql, params).then(() => null, (e: { code?: string }) => e.code);
        expect(['NX403', 'NX422'], sql).toContain(code);
        await c.query('rollback');
      }
      const bad = await c.query('select * from epm.sweep_demo_tenants($1)', ['y'.repeat(40)]).then(() => null, (e: { code?: string }) => e.code);
      expect(bad).toBe('NX403');
    } finally {
      await c.end();
    }
    // The owner's purge refuses a real tenant too.
    const owner = new pg.Client({ connectionString: h.db.ownerUrl });
    await owner.connect();
    try {
      expect((await owner.query('select epm.purge_tenant($1) as ok', [realTenant])).rows[0].ok).toBe(false);
    } finally {
      await owner.end();
    }
    expect(expectOk(await read(realAdmin, realApp)).values).toEqual([[777]]);
  });

  it('ending a copy that used every feature leaves no row in any tenant table and no file', async () => {
    const d = await startOk(h, '198.51.100.1');
    const base = `/v1/apps/${d.appId}`;
    const g = expectOk(await read(d.api, d.appId));
    const sub = expectOk(await d.api.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[5]] }));
    expect(sub).toBeTruthy();
    const csv = expectOk(await d.api.upload(base, 'gl.csv', 'Company,Month,Account,Amount\nE01,Jan,Revenue,5\nW01,Feb,COGS,7\n'), 201);
    expectOk(await d.api.post(`${base}/import-formats/GL/run`, { file_id: csv.file_id }));
    const ds = expectOk(await d.api.upload(base, 'map.csv', 'GL,Plan Account\n4000,Revenue\n', 'dataset'), 201);
    expectOk(await d.api.put(`${base}/datasets/GL Map`, { file_id: ds.file_id }));
    expectOk(await d.api.put(`${base}/dimensions/Product/members`, { members: [{ name: 'Gizmos', parent: 'All Products' }] }));
    expectOk(await d.api.post(`${base}/deploy`));
    expectOk(await d.api.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', locked: false }));
    expectOk(await d.api.put(`${base}/forms/Revenue Entry`, { cube: 'Plan', description: 'changed', definition: (await d.api.get(`${base}/forms/Revenue Entry`)).body.definition }));
    const snap = expectOk(await d.api.post(`${base}/snapshots`, {}), 201);
    expectOk(await d.api.post(`${base}/metadata/restore`, { snapshot_id: snap.snapshot_id }));
    const txn = expectOk(await d.api.get(`${base}/txns`)).txns.find((t: { source: string }) => t.source === 'grid_submit');
    expectOk(await d.api.post(`${base}/txns/${txn.txn_id}/undo`, { force: true }));
    expectOk(await d.api.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' }));
    expect((await d.api.raw('GET', `${base}/definitions/export`)).status).toBe(200);
    const before = await leftovers(h, d.tenantId);
    for (const t of ['fact', 'cell_audit', 'change_txn', 'snapshot', 'stored_file', 'import_run', 'import_line', 'dataset_row', 'artifact_version', 'metadata_rev', 'security_event']) {
      expect(before[t] ?? 0, t).toBeGreaterThan(0);
    }
    expect((await h.store.list(`${d.tenantId}/`)).length).toBeGreaterThan(3);

    expect(expectOk(await d.api.del('/v1/demo/session')).ended).toBe(true);
    expect(await leftovers(h, d.tenantId)).toEqual({});
    expect(await h.store.list(`${d.tenantId}/`)).toEqual([]);
    expect(expectOk(await read(realAdmin, realApp)).values).toEqual([[777]]);
  });

  it('the sweep removes expired copies (rows and files) and nothing else', async () => {
    const d = await startOk(h, '198.51.100.2');
    expectOk(await d.api.post(`/v1/apps/${d.appId}/snapshots`, {}), 201);
    const live = await startOk(h, '198.51.100.3');
    await expire(d.tenantId);
    const swept = await sweepDemoTenants(deps(), h.db.jobKey);
    expect(swept).toContain(d.tenantId);
    expect(swept).not.toContain(live.tenantId);
    expect(await leftovers(h, d.tenantId)).toEqual({});
    expect(await h.store.list(`${d.tenantId}/`)).toEqual([]);
    expect(expectOk(await live.api.get('/v1/apps')).apps).toHaveLength(1);
    expect(expectOk(await read(realAdmin, realApp)).values).toEqual([[777]]);
  });

  it('a copy whose loading fails is removed at once, and the visitor gets the error', async () => {
    const before = (await su(h, 'select count(*)::int as n from epm.tenant'))[0].n;
    let failed = false;
    const hook = (sql: string, params: unknown[] | undefined) => {
      if (!failed && sql.includes('apply_changes') && String(params?.[0] ?? '').includes('"source":"restore"')) {
        failed = true;
        throw Object.assign(new Error('simulated: the database went away mid-load'), { code: 'NX409' });
      }
    };
    h.queryHooks.push(hook);
    try {
      const r = await startDemo(h, '198.51.100.4');
      expect(r.status).toBe(409);
    } finally {
      h.queryHooks.splice(h.queryHooks.indexOf(hook), 1);
    }
    expect(failed).toBe(true);
    expect((await su(h, 'select count(*)::int as n from epm.tenant'))[0].n).toBe(before);
    const orphans = await su(h, `select count(*)::int as n from epm.application a where not exists (select 1 from epm.tenant t where t.tenant_id = a.tenant_id)`);
    expect(orphans[0].n).toBe(0);
    expect(h.unexpected).toEqual([]);
  });

  it('a snapshot being written when its copy ends removes its own files', async () => {
    const d = await startOk(h, '198.51.100.5');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered = false;
    h.blobHooks.beforePut = async (key) => {
      if (key.startsWith(`${d.tenantId}/`) && key.includes('/snapshots/')) { entered = true; await gate; }
    };
    try {
      const pending = d.api.post(`/v1/apps/${d.appId}/snapshots`, {});
      for (let i = 0; i < 100 && !entered; i++) await sleep(20);
      expect(entered).toBe(true);
      expect(expectOk(await d.api.del('/v1/demo/session')).ended).toBe(true);
      release();
      expect((await pending).status).not.toBe(201);
    } finally {
      h.blobHooks.beforePut = undefined;
      release();
    }
    expect(await leftovers(h, d.tenantId)).toEqual({});
    expect(await h.store.list(`${d.tenantId}/`)).toEqual([]);
  });

  it('FINDING: a file uploaded while its copy is ending stays in storage for good', async () => {
    const d = await startOk(h, '198.51.100.6');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered = false;
    h.blobHooks.beforePut = async (key) => {
      if (key.startsWith(`${d.tenantId}/`) && key.includes('/files/')) { entered = true; await gate; }
    };
    try {
      const pending = d.api.upload(`/v1/apps/${d.appId}`, 'late.csv', 'a,b\n1,2\n');
      for (let i = 0; i < 100 && !entered; i++) await sleep(20);
      expect(entered).toBe(true);
      expect(expectOk(await d.api.del('/v1/demo/session')).ended).toBe(true);
      release();
      expect((await pending).status).not.toBe(201);
    } finally {
      h.blobHooks.beforePut = undefined;
      release();
    }
    expect(await leftovers(h, d.tenantId)).toEqual({});
    // A later sweep cannot find it either: the tenant is gone.
    await sweepDemoTenants(deps(), h.db.jobKey);
    // Should be: no file of an ended copy is left (the upload removes its file when its row cannot be written).
    expect(await h.store.list(`${d.tenantId}/`)).toEqual([]);
  });

  it('FINDING: when deleting files fails during the sweep, the rows are gone and the files are never removed', async () => {
    const d = await startOk(h, '198.51.100.7');
    expectOk(await d.api.post(`/v1/apps/${d.appId}/snapshots`, {}), 201);
    expectOk(await d.api.upload(`/v1/apps/${d.appId}`, 'kept.csv', 'a,b\n1,2\n'), 201);
    await expire(d.tenantId);
    h.blobHooks.beforeDelete = () => { throw new Error('R2: 503 Service Unavailable'); };
    try {
      await expect(sweepDemoTenants(deps(), h.db.jobKey)).rejects.toThrow(/R2/);
    } finally {
      h.blobHooks.beforeDelete = undefined;
    }
    expect(await leftovers(h, d.tenantId)).toEqual({});
    // The next sweep runs with storage working again.
    await sweepDemoTenants(deps(), h.db.jobKey);
    // Should be: the files go on a later sweep (files before rows, or a record of what is still to delete).
    expect(await h.store.list(`${d.tenantId}/`)).toEqual([]);
  });

  it('FINDING: cells written while a copy is being ended outlive it as orphaned rows', async () => {
    const d = await startOk(h, '198.51.100.8');
    const userId = (await su(h, 'select user_id from epm.app_user where tenant_id = $1 and email = $2', [d.tenantId, ADMIN.email]))[0].user_id;
    const ks = await coords(d.appId, ['Revenue', 'COGS', 'Opex']);
    const w = await appConn();
    try {
      // A grid submit in flight: apply_changes has run, its transaction has not committed yet.
      await w.query('begin');
      await w.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [d.tenantId, userId]);
      const r = await w.query('select epm.apply_changes($1::jsonb) as r', [JSON.stringify({ app_id: d.appId, source: 'api', cells: ks.map((k) => ({ k, v: 1 })) })]);
      expect(r.rows[0].r.cell_count).toBe(3);
      // "Start over" / end, from another tab.
      const ending = d.api.del('/v1/demo/session');
      for (let i = 0; i < 100; i++) {
        const waiting = await su(h, "select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock' and query like '%end_demo%'");
        if (waiting[0].n > 0) break;
        await sleep(20);
      }
      await w.query('commit');
      expect(expectOk(await ending).ended).toBe(true);
    } finally {
      await w.end();
    }
    expect((await su(h, 'select count(*)::int as n from epm.tenant where tenant_id = $1', [d.tenantId]))[0].n).toBe(0);
    // Should be: nothing of the tenant is left (purge_tenant locks the applications before deleting cells).
    expect(await leftovers(h, d.tenantId)).toEqual({});
  });

  it('FINDING: while the hourly sweep is running, every demo start waits for it to finish', async () => {
    const x = await startOk(h, '198.51.100.9');
    const y = await startOk(h, '198.51.100.10');
    await expire(x.tenantId);
    await expire(y.tenantId);
    const s = await appConn();
    let started: Promise<{ status: number }> | undefined;
    try {
      // The sweep's transaction: it has removed the expired copies and is still going (more copies, files).
      await s.query('begin');
      const swept = await s.query('select tenant_id from epm.sweep_demo_tenants($1)', [h.db.jobKey]);
      expect(swept.rows.length).toBeGreaterThanOrEqual(2);
      started = startDemo(h, '198.51.100.11');
      const winner = await Promise.race([started.then(() => 'start'), sleep(3000).then(() => 'timeout')]);
      // Should be: a new visitor's start does not queue behind the sweep (skip copies another purge has locked).
      expect(winner).toBe('start');
    } finally {
      await s.query('commit').catch(() => undefined);
      await s.end();
      if (started) await started;
    }
  });

  it('two "Start over" clicks at once each get a copy, end the old one once, and raise no errors', async () => {
    const d = await startOk(h, '198.51.100.12');
    const [r1, r2] = await Promise.all([startDemo(h, '198.51.100.12', { token: d.token }), startDemo(h, '198.51.100.12', { token: d.token })]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(await leftovers(h, d.tenantId)).toEqual({});
    expect(h.unexpected).toEqual([]);
  });
});
