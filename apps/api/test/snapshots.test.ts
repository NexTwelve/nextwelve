import { gunzipSync, strFromU8 } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRetention, runNightlySnapshots } from '../src/backup/snapshots.js';
import { poolDatabase } from '../src/db.js';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, randomUUID, seedPlanApp, signIn } from './helpers.js';

const R = { REV: 2, OPEX: 4 };
const C = { JAN: 0, FEB: 1 };

describe('application snapshots', () => {
  let h: Harness;
  let admin: Api;
  let ann: Api;
  let tenantId: string;
  let appId: string;
  let base: string;
  let full: any;

  async function edit(api: Api, edits: [number, number, number | null][], pov: Record<string, string> = PLAN_POV) {
    const g = expectOk(await api.post(`${base}/grid/read`, planGrid(pov)));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await api.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  }
  async function cells(api: Api, b: string, pov: Record<string, string> = PLAN_POV) {
    const v = expectOk(await api.post(`${b}/grid/read`, planGrid(pov))).values;
    return { revJan: v[R.REV][C.JAN], revFeb: v[R.REV][C.FEB], opexJan: v[R.OPEX][C.JAN] };
  }
  async function download(snapshotId: string, file: string): Promise<Response> {
    return h.app.request(`${base}/snapshots/${snapshotId}/files/${file}`, { headers: { authorization: `Bearer ${admin.token}` } });
  }
  const FINAL = { ...PLAN_POV, Version: 'Final' };
  const ACTUAL = { ...PLAN_POV, Scenario: 'Actual' };

  beforeAll(async () => {
    h = await createHarness();
    tenantId = await provisionTenant(h.db, 'Snap Co', null, 'admin@snap.test');
    admin = await signIn(h, 'admin@snap.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    expectOk(await admin.post('/v1/users', { email: 'ann@snap.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'ann@snap.test', role: 'planner' }));
    expectOk(await admin.post('/v1/groups', { name: 'East Planners' }), 201);
    expectOk(await admin.put('/v1/groups/East Planners/members', { emails: ['ann@snap.test'] }));
    expectOk(await admin.put(`${base}/grants`, { grants: [{ principal: { group: 'East Planners' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' }] }));
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Actual', version: 'Final', years: 'FY27', locked: true }));
    expectOk(await admin.put(`${base}/forms/Revenue`, { cube: 'Plan', folder: 'Inputs', definition: {
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Product: 'Widgets' },
      page: { Entity: ['East', 'West'] },
      rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan', 'Feb'] } } }));
    const f = expectOk(await admin.upload(base, 'codes.csv', 'Code,Member\nR,Revenue\nO,Opex\n', 'dataset'), 201);
    expectOk(await admin.put(`${base}/datasets/Codes`, { file_id: f.file_id }));
    expectOk(await admin.put(`${base}/import-formats/Loader`, { cube: 'Plan', definition: {
      dimensions: { Scenario: { value: 'Budget' }, Version: { value: 'Working' }, Years: { value: 'FY27' }, Period: { value: 'Mar' },
                    Entity: { value: 'East' }, Department: { value: 'Sales' }, Product: { value: 'Widgets' }, Account: { column: 'Code' } },
      amount: { column: 'Amount' } } }));
    expectOk(await admin.put(`${base}/import-formats/Loader/mappings`, { rules: [
      { dimension: 'Account', rule_type: 'dataset', source: 'Codes', target: 'Member', options: { key_column: 'Code' } }] }));
    ann = await signIn(h, 'ann@snap.test');

    await edit(ann, [[R.REV, C.JAN, 100], [R.REV, C.FEB, 200]]);
    await edit(admin, [[R.REV, C.JAN, 50]], FINAL);
    await edit(admin, [[R.REV, C.JAN, 80]], ACTUAL);
  });
  afterAll(async () => h?.close());

  it('takes a consistent snapshot with checksummed files in storage', async () => {
    full = expectOk(await admin.post(`${base}/snapshots`, { comment: 'before the reforecast' }), 201);
    expect(full).toMatchObject({ kind: 'manual', status: 'complete', fact_count: 4, comment: 'before the reforecast', created_by: 'admin@snap.test', scope: {} });
    expect(full.manifest.files.map((f: any) => f.name)).toEqual(['metadata.json.gz', 'datasets.json.gz', 'facts-0001.ndjson.gz']);
    expect(full.manifest.files.every((f: any) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
    expect(h.blobs.keys()).toContain(`${tenantId}/${appId}/snapshots/${full.snapshot_id}/manifest.json`);

    const list = expectOk(await admin.get(`${base}/snapshots`)).snapshots;
    expect(list[0]).toMatchObject({ snapshot_id: full.snapshot_id, status: 'complete' });
    expect(list[0].manifest).toBeUndefined();

    const manifest = await (await download(full.snapshot_id, 'manifest.json')).json();
    expect(manifest).toMatchObject({ format: 'nextwelve-snapshot', snapshot_id: full.snapshot_id, fact_count: 4 });
    const facts = strFromU8(gunzipSync(new Uint8Array(await (await download(full.snapshot_id, 'facts-0001.ndjson.gz')).arrayBuffer()))).split('\n');
    expect(facts).toHaveLength(4);
    expect(JSON.parse(facts[0]!)).toHaveLength(17);
    expect((await download(full.snapshot_id, 'nope.gz')).status).toBe(404);
  });

  it('can cover chosen scenarios and versions only', async () => {
    const working = expectOk(await admin.post(`${base}/snapshots`, { scope: { versions: ['working'] } }), 201);
    expect(working).toMatchObject({ fact_count: 2 + 1, scope: { versions: ['Working'] } });
    expect((await admin.post(`${base}/snapshots`, { scope: { scenarios: ['Plan B'] } })).status).toBe(422);
  });

  it('restores data in place: a preview, then one undoable transaction after a pre-restore snapshot', async () => {
    await edit(ann, [[R.REV, C.JAN, 111], [R.REV, C.FEB, null], [R.OPEX, C.JAN, 5]]);
    await edit(admin, [[R.REV, C.JAN, 55]], FINAL);

    const dry = expectOk(await admin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'in_place', dry_run: true }));
    expect(dry).toMatchObject({ dry_run: true, cells_set: 3, cells_cleared: 1, unchanged: 1, skipped: 0, txn_id: null });
    expect(await cells(admin, base)).toEqual({ revJan: 111, revFeb: null, opexJan: 5 });

    const r = expectOk(await admin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'] }));
    expect(r).toMatchObject({ dry_run: false, cells_set: 2, cells_cleared: 1, cell_count: 3 });
    expect(await cells(admin, base)).toEqual({ revJan: 100, revFeb: 200, opexJan: null });
    expect((await cells(admin, base, FINAL)).revJan).toBe(55); // outside the chosen versions

    const pre = expectOk(await admin.get(`${base}/snapshots/${r.pre_restore_snapshot_id}`));
    expect(pre).toMatchObject({ kind: 'pre_restore', status: 'complete', scope: { versions: ['Working'] } });
    expect(pre.expires_at).not.toBeNull();

    expectOk(await admin.post(`${base}/txns/${r.txn_id}/undo`, {}));
    expect(await cells(admin, base)).toEqual({ revJan: 111, revFeb: null, opexJan: 5 });
  });

  it('restores one version of a snapshot into another version', async () => {
    expect((await admin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'in_place', into_version: 'Final' })).status).toBe(422);
    expect((await admin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'], into_version: 'Nope' })).status).toBe(422);
    const r = expectOk(await admin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'], into_version: 'Final' }));
    expect(r).toMatchObject({ cells_set: 3, cells_cleared: 0 });
    expect(await cells(admin, base, FINAL)).toEqual({ revJan: 100, revFeb: 200, opexJan: null });
    expect((await cells(admin, base, { ...ACTUAL, Version: 'Final' })).revJan).toBe(80);
  });

  it('restores into a new application with its metadata, security, forms, imports and datasets', async () => {
    const r = expectOk(await admin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'new_app', access: 'copy' }), 201);
    expect(r).toMatchObject({ target: 'new_app', cells: 4, skipped: 0, access: 'copy', grants_copied: 1, missing_users: [], missing_groups: [] });
    expect(r.roles_granted).toEqual([{ email: 'ann@snap.test', role: 'planner' }]);
    expect(r.name).toMatch(/^FY27 Plan \(restored \d{4}-\d\d-\d\d \d\d:\d\d\)$/);
    const nb = `/v1/apps/${r.app_id}`;

    const apps = expectOk(await admin.get('/v1/apps')).apps;
    expect(apps.find((a: any) => a.app_id === r.app_id)).toMatchObject({ state: 'online' });
    const dims = (b: string) => admin.get(`${b}/dimensions`).then((x) => expectOk(x));
    expect(await dims(nb)).toEqual(await dims(base));
    expect(expectOk(await admin.get(`${nb}/dimensions/Period/members`)).members).toEqual(expectOk(await admin.get(`${base}/dimensions/Period/members`)).members);
    expect(expectOk(await admin.get(`${nb}/forms`)).forms.map((f: any) => [f.name, f.folder])).toEqual([['Revenue', 'Inputs']]);
    expect(expectOk(await admin.get(`${nb}/datasets/Codes/rows`)).rows.map((x: any) => x.data.Member)).toEqual(['Revenue', 'Opex']);
    expect(expectOk(await admin.get(`${nb}/import-formats/Loader/mappings`)).rules).toHaveLength(1);
    expect(expectOk(await admin.get(`${nb}/grants`)).grants).toEqual(expectOk(await admin.get(`${base}/grants`)).grants);

    // The data, as the snapshot had it, and the planner's role and grants came along.
    expect(await cells(ann, nb)).toEqual({ revJan: 100, revFeb: 200, opexJan: null });
    expect((await ann.post(`${nb}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'West' }))).status).toBe(403);
    expect(expectOk(await admin.post(`${nb}/audit/verify`))).toMatchObject({ ok: true });
    // Restored rows still go through the import path: the dataset mapping works in the copy.
    const file = expectOk(await admin.upload(nb, 'mar.csv', 'Code,Amount\nO,9\n'), 201);
    expect(expectOk(await admin.post(`${nb}/import-formats/Loader/run`, { file_id: file.file_id }))).toMatchObject({ status: 'loaded', cells: 1 });

    // Without access: 'copy' the copy starts with no application roles or member grants.
    const again = expectOk(await admin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'new_app' }), 201);
    expect(again).toMatchObject({ name: `${r.name} 2`, access: 'none', roles_granted: [], grants_copied: 0, access_in_snapshot: { roles: 1, grants: 1 } });
    expect((await ann.post(`/v1/apps/${again.app_id}/grid/read`, planGrid())).status).toBe(403);
  });

  it('refuses a snapshot whose files changed or disappeared in storage', async () => {
    const snap = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    const key = `${tenantId}/${appId}/snapshots/${snap.snapshot_id}/facts-0001.ndjson.gz`;
    const bytes = (await h.blobs.get(key))!;
    bytes[bytes.length - 5] ^= 0xff;
    await h.blobs.put(key, bytes, 'application/gzip');
    const bad = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', dry_run: true });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/checksum/);
    await h.blobs.delete([key]);
    expect((await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', dry_run: true })).status).toBe(410);
  });

  it('is for application admins; a new application needs a service admin', async () => {
    expect((await ann.get(`${base}/snapshots`)).status).toBe(403);
    expect((await ann.post(`${base}/snapshots`, {})).status).toBe(403);
    expect((await ann.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'in_place', dry_run: true })).status).toBe(403);
    expectOk(await admin.post('/v1/users', { email: 'aa@snap.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'aa@snap.test', role: 'app_admin' }));
    const appAdmin = await signIn(h, 'aa@snap.test');
    expectOk(await appAdmin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'in_place', dry_run: true }));
    expect((await appAdmin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'new_app' })).status).toBe(403);

    await provisionTenant(h.db, 'Other Co', null, 'admin@other.test');
    const other = await signIn(h, 'admin@other.test');
    expect((await other.get(`${base}/snapshots`)).status).toBe(404);
    expect((await other.get(`${base}/snapshots/${full.snapshot_id}/files/manifest.json`)).status).toBe(404);
  });

  it('takes nightly snapshots of applications that changed, across tenants', async () => {
    const deps = { db: poolDatabase(h.pool), blobs: h.blobs };
    const first = await runNightlySnapshots(deps, { jobKey: h.db.jobKey });
    expect(first.find((r) => r.app_id === appId)).toMatchObject({ status: 'taken' });
    expect(first.every((r) => r.status !== 'failed')).toBe(true);
    const second = await runNightlySnapshots(deps, { jobKey: h.db.jobKey });
    expect(second.find((r) => r.app_id === appId)).toMatchObject({ status: 'unchanged' });

    await edit(ann, [[R.REV, C.FEB, 201]]);
    expect((await runNightlySnapshots(deps, { jobKey: h.db.jobKey })).find((r) => r.app_id === appId)).toMatchObject({ status: 'taken' });

    // The cross-tenant listing refuses to run inside a tenant session.
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      await expect(c.query('select * from epm.snapshot_targets($1)', [h.db.jobKey])).rejects.toMatchObject({ code: 'NX422' });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });

  it('keeps 30 daily and 12 monthly nightly snapshots, and expires pre-restore ones', async () => {
    const fakeApp = randomUUID();
    const su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    const now = new Date('2026-10-01T12:00:00Z');
    try {
      for (let i = 1; i <= 40; i++) {
        await su.query(
          `insert into epm.snapshot (tenant_id, app_id, app_name, kind, schema_ver, storage_prefix, status, created_at)
           values ($1, $2, 'Old', 'nightly', 1, $3, 'complete', $4)`,
          [tenantId, fakeApp, `x/${i}`, new Date(now.getTime() - i * 86_400_000)],
        );
      }
      await su.query(
        `insert into epm.snapshot (tenant_id, app_id, app_name, kind, schema_ver, storage_prefix, status, created_at, expires_at)
         values ($1, $2, 'Old', 'pre_restore', 1, 'x/pre', 'complete', $3, $4), ($1, $2, 'Old', 'manual', 1, 'x/man', 'complete', $3, null)`,
        [tenantId, fakeApp, new Date('2026-05-01T00:00:00Z'), new Date('2026-08-01T00:00:00Z')],
      );
      // Days 1-30 back are September; days 31-40 back are August, whose newest (Aug 31) is kept as its monthly.
      const expired = await applyRetention({ db: poolDatabase(h.pool), blobs: h.blobs }, { tenantId, userId: null }, fakeApp, now);
      expect(expired).toHaveLength(9 + 1);
      const left = await su.query<{ kind: string; n: number }>(
        `select kind, count(*)::int as n from epm.snapshot where app_id = $1 and status = 'complete' group by kind order by kind`,
        [fakeApp],
      );
      expect(left.rows).toEqual([{ kind: 'manual', n: 1 }, { kind: 'nightly', n: 31 }]);
    } finally {
      await su.end();
    }
  });
});
