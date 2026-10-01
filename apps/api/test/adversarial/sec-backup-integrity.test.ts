import { gzipSync, strFromU8, strToU8 } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/files/hash.js';
import { SCHEMA_VER } from '../../src/backup/snapshots.js';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Adversarial: the integrity of restores (hash chain after restores and undos), of snapshot
 * files against someone who can write to object storage but not the database, and of the
 * download route's file name handling.
 */
const R = { REV: 2, COGS: 3, OPEX: 4 };
const C = { JAN: 0, FEB: 1, MAR: 2 };

describe('backup integrity', () => {
  let h: Harness;
  let su: pg.Client;
  let tenantId: string;
  let admin: Api;
  let appId: string;
  let base: string;
  let snap: any; // a complete snapshot
  let snap2: any; // a second, different snapshot of the same app
  const pit = { cube: 'Plan', scenario: 'Budget', version: 'Working' };

  async function edit(api: Api, edits: [number, number, number | null][], pov = PLAN_POV): Promise<number> {
    const g = expectOk(await api.post(`${base}/grid/read`, planGrid(pov)));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await api.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).txn_id;
  }
  async function grid(pov = PLAN_POV, b = base) {
    return expectOk(await admin.post(`${b}/grid/read`, planGrid(pov))).values as (number | null)[][];
  }
  async function verify(b = base) {
    return expectOk(await admin.post(`${b}/audit/verify`));
  }
  async function raw(path: string, method = 'GET') {
    return h.app.request(path, { method, headers: { authorization: `Bearer ${admin.token}` } });
  }
  async function counts() {
    const r = await su.query<{ apps: number; txns: number; snaps: number }>(
      `select (select count(*)::int from epm.application) as apps, (select count(*)::int from epm.change_txn) as txns,
              (select count(*)::int from epm.snapshot) as snaps`,
    );
    return r.rows[0]!;
  }
  const key = (s: any, file: string) => `${tenantId}/${appId}/snapshots/${s.snapshot_id}/${file}`;

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    tenantId = await provisionTenant(h.db, 'Integrity Co', null, 'admin@int.test');
    admin = await signIn(h, 'admin@int.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    await edit(admin, [[R.REV, C.JAN, 100], [R.REV, C.FEB, 200], [R.OPEX, C.JAN, 30]]);
    await edit(admin, [[R.REV, C.JAN, 9]], { ...PLAN_POV, Version: 'Final' });
    snap = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    await edit(admin, [[R.REV, C.JAN, 150], [R.COGS, C.JAN, 40]]);
    snap2 = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  // ---------------------------------------------------------------------------
  // Hash chain after restores and their undos
  // ---------------------------------------------------------------------------
  it('keeps the audit chain valid through point-in-time restores (in place and into a new version) and undos', async () => {
    const t = await edit(admin, [[R.REV, C.FEB, null], [R.OPEX, C.JAN, 35]]);
    const inPlace = expectOk(await admin.post(`${base}/restore`, { ...pit, before_txn: t }));
    expect(inPlace.cell_count).toBeGreaterThan(0);
    expect(await verify()).toMatchObject({ ok: true });
    expectOk(await admin.post(`${base}/txns/${inPlace.txn_id}/undo`, {}));
    expect(await verify()).toMatchObject({ ok: true });

    const into = expectOk(await admin.post(`${base}/restore`, { ...pit, before_txn: t, into_version: 'PIT Copy', create_version: true }));
    expect(into).toMatchObject({ version_created: true });
    expect(await verify()).toMatchObject({ ok: true });
    // A later change, then a forced undo of the restore.
    await edit(admin, [[R.REV, C.JAN, 1]], { ...PLAN_POV, Version: 'PIT Copy' });
    expect((await admin.post(`${base}/txns/${into.txn_id}/undo`, {})).status).toBe(409);
    expectOk(await admin.post(`${base}/txns/${into.txn_id}/undo`, { force: true }));
    expect(await verify()).toMatchObject({ ok: true });
  });

  it('keeps the audit chain valid through snapshot restores in place, into a version, into a new app, and undos', async () => {
    const r = expectOk(await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' }));
    expect(r.cell_count).toBeGreaterThan(0);
    expect(await verify()).toMatchObject({ ok: true });
    const v = await grid();
    expect([v[R.REV]![C.JAN], v[R.REV]![C.FEB], v[R.COGS]![C.JAN], v[R.OPEX]![C.JAN]]).toEqual([100, 200, null, 30]);
    expectOk(await admin.post(`${base}/txns/${r.txn_id}/undo`, {}));
    expect(await verify()).toMatchObject({ ok: true });

    const into = expectOk(await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'], into_version: 'PIT Copy' }));
    expect(into.cell_count).toBeGreaterThan(0);
    expect(await verify()).toMatchObject({ ok: true });

    const n = expectOk(await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Integrity Copy' }), 201);
    expect(await verify(`/v1/apps/${n.app_id}`)).toMatchObject({ ok: true, checked: 1 });
    const nv = await grid(PLAN_POV, `/v1/apps/${n.app_id}`);
    expect([nv[R.REV]![C.JAN], nv[R.REV]![C.FEB], nv[R.OPEX]![C.JAN]]).toEqual([100, 200, 30]);
  });

  it("an in-place restore of a scoped snapshot never clears data outside the snapshot's scope", async () => {
    const scoped = expectOk(await admin.post(`${base}/snapshots`, { scope: { versions: ['Working'], scenarios: ['Budget'] } }), 201);
    await edit(admin, [[R.REV, C.MAR, 5]], { ...PLAN_POV, Version: 'Final' });
    await edit(admin, [[R.REV, C.MAR, 6]], { ...PLAN_POV, Scenario: 'Actual' });
    const finalBefore = await grid({ ...PLAN_POV, Version: 'Final' });
    const actualBefore = await grid({ ...PLAN_POV, Scenario: 'Actual' });
    // No scenarios/versions in the request: the snapshot's own scope applies.
    expectOk(await admin.post(`${base}/snapshots/${scoped.snapshot_id}/restore`, { target: 'in_place' }));
    expect(await grid({ ...PLAN_POV, Version: 'Final' })).toEqual(finalBefore);
    expect(await grid({ ...PLAN_POV, Scenario: 'Actual' })).toEqual(actualBefore);
    // Asking for a version the snapshot does not hold is refused rather than treated as "clear it".
    expect((await admin.post(`${base}/snapshots/${scoped.snapshot_id}/restore`, { target: 'in_place', versions: ['Final'] })).status).toBe(422);
    expect((await admin.post(`${base}/snapshots/${scoped.snapshot_id}/restore`, { target: 'in_place', scenarios: ['Actual'] })).status).toBe(422);
    expect(await grid({ ...PLAN_POV, Version: 'Final' })).toEqual(finalBefore);
    expect(await verify()).toMatchObject({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Someone who can write object storage but not the database
  // ---------------------------------------------------------------------------
  async function expectRefused(s: any, status: number, pattern: RegExp) {
    const before = await counts();
    for (const body of [{ target: 'in_place', dry_run: true }, { target: 'in_place' }, { target: 'new_app', name: `Tampered ${Math.random()}` }]) {
      const res = await admin.post(`${base}/snapshots/${s.snapshot_id}/restore`, body);
      expect(res.status, JSON.stringify(body)).toBe(status);
      expect(res.body.message).toMatch(pattern);
    }
    expect(await counts()).toEqual(before); // no app, no transaction, no pre-restore snapshot
  }

  it('refuses tampered metadata, datasets and facts files, and a re-gzipped forgery', async () => {
    for (const file of ['metadata.json.gz', 'datasets.json.gz', 'facts-0001.ndjson.gz']) {
      const s = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
      const orig = (await h.blobs.get(key(s, file)))!;
      // A well-formed forgery: valid gzip of edited content (here: the facts doubled / roles added).
      const text = strFromU8((await import('fflate')).gunzipSync(orig));
      const forged = file === 'metadata.json.gz'
        ? JSON.stringify({ ...JSON.parse(text), roles: [{ email: 'evil@int.test', role: 'app_admin' }] })
        : file === 'facts-0001.ndjson.gz'
          ? text.split('\n').map((l) => { const a = JSON.parse(l); a[16] = a[16] * 2; return JSON.stringify(a); }).join('\n')
          : JSON.stringify([{ name: 'Evil', description: null, version: 1, sheets: [], rows: [] }]);
      expect(Buffer.from(gzipSync(strToU8(forged))).equals(Buffer.from(orig)), file).toBe(false);
      await h.blobs.put(key(s, file), gzipSync(strToU8(forged)), 'application/gzip');
      await expectRefused(s, 422, /checksum/);
      // The download route refuses it too.
      expect((await raw(`${base}/snapshots/${s.snapshot_id}/files/${file}`)).status).toBe(422);
    }
  });

  it('refuses even when the attacker also rewrites manifest.json in storage to match the forgery', async () => {
    const s = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    const forged = gzipSync(strToU8(JSON.stringify([0])));
    await h.blobs.put(key(s, 'facts-0001.ndjson.gz'), forged, 'application/gzip');
    const manifest = JSON.parse(strFromU8((await h.blobs.get(key(s, 'manifest.json')))!));
    for (const f of manifest.files) if (f.name === 'facts-0001.ndjson.gz') Object.assign(f, { bytes: forged.byteLength, sha256: await sha256Hex(forged) });
    await h.blobs.put(key(s, 'manifest.json'), strToU8(JSON.stringify(manifest)), 'application/json');
    await expectRefused(s, 422, /checksum/);
  });

  it('ignores extra files dropped into a snapshot folder, and files swapped in from another snapshot', async () => {
    // Swap snapshot 2's facts into snapshot 1's folder.
    const s1 = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    const other = (await h.blobs.get(key(snap2, 'facts-0001.ndjson.gz')))!;
    const mine = (await h.blobs.get(key(s1, 'facts-0001.ndjson.gz')))!;
    expect(Buffer.from(other).equals(Buffer.from(mine))).toBe(false);
    await h.blobs.put(key(s1, 'facts-0001.ndjson.gz'), other, 'application/gzip');
    await expectRefused(s1, 422, /checksum/);

    // An extra fact file that is not in the database's manifest is never read.
    const s2 = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    await h.blobs.put(key(s2, 'facts-0002.ndjson.gz'), gzipSync(strToU8(JSON.stringify([...new Array(16).fill(1), 123]))), 'application/gzip');
    const dry = expectOk(await admin.post(`${base}/snapshots/${s2.snapshot_id}/restore`, { target: 'in_place', dry_run: true }));
    expect(dry).toMatchObject({ cells_set: 0, cells_cleared: 0, skipped: 0 });
    expect((await raw(`${base}/snapshots/${s2.snapshot_id}/files/facts-0002.ndjson.gz`)).status).toBe(404);
  });

  it('refuses a snapshot whose files were deleted from storage, writing nothing', async () => {
    const s = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    await h.blobs.delete([key(s, 'metadata.json.gz')]);
    await expectRefused(s, 410, /no longer in storage/);
  });

  it('serves manifest.json as the database recorded it, not whatever storage now holds', async () => {
    const s = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    const fake = { ...s.manifest, tenant_id: '00000000-0000-0000-0000-000000000000', fact_count: 999999,
      files: s.manifest.files.map((f: any) => ({ ...f, sha256: '0'.repeat(64) })) };
    await h.blobs.put(key(s, 'manifest.json'), strToU8(JSON.stringify(fake)), 'application/json');
    const res = await raw(`${base}/snapshots/${s.snapshot_id}/files/manifest.json`);
    // Either refuse (422) or serve the trusted copy; never hand out storage's altered index as genuine.
    if (res.status === 200) expect(await res.json()).toEqual(s.manifest);
    else expect(res.status).toBe(422);
  });

  // ---------------------------------------------------------------------------
  // Download names
  // ---------------------------------------------------------------------------
  it('download names cannot traverse out of the snapshot or reach another snapshot', async () => {
    const id = snap.snapshot_id;
    const other = snap2.snapshot_id;
    const names = [
      '..', '.', '../manifest.json', '..%2Fmanifest.json', '%2e%2e%2fmanifest.json', '%2E%2E/manifest.json',
      `..%2F${other}%2Fmanifest.json`, `..%2F..%2F..%2F..%2F${tenantId}%2F${appId}%2Fsnapshots%2F${other}%2Fmanifest.json`,
      'manifest.json%2F..%2F..%2Fmanifest.json', 'MANIFEST.JSON', 'manifest.json%20', '%20manifest.json',
      'metadata.json.gz%3F', 'facts-0001.ndjson.gz%23', 'facts-1.ndjson.gz', 'facts-0001.ndjson',
      `%2F${tenantId}%2F${appId}%2Fsnapshots%2F${other}%2Fmanifest.json`, '%5C..%5Cmanifest.json',
    ];
    const got: Record<string, number> = {};
    for (const n of names) {
      const res = await raw(`${base}/snapshots/${id}/files/${n}`);
      got[n] = res.status;
      if (res.status === 200) {
        const body = await res.text();
        expect(body, n).not.toContain(other);
      }
    }
    for (const [n, status] of Object.entries(got)) expect([400, 404], `${n} -> ${status}`).toContain(status);
  });

  it('a control character in the download name is a clean 404, not a server error', async () => {
    const res = await raw(`${base}/snapshots/${snap.snapshot_id}/files/facts-0001.ndjson.gz%00`);
    expect(res.status).toBe(404);
  });

  // ---------------------------------------------------------------------------
  // Snapshots that are not complete
  // ---------------------------------------------------------------------------
  it('refuses downloads and restores of running, failed and expired snapshots', async () => {
    for (const status of ['running', 'failed', 'expired']) {
      const s = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
      await su.query('update epm.snapshot set status = $2 where snapshot_id = $1', [s.snapshot_id, status]);
      for (const f of ['manifest.json', 'metadata.json.gz', 'facts-0001.ndjson.gz']) {
        expect((await raw(`${base}/snapshots/${s.snapshot_id}/files/${f}`)).status, `${status} ${f}`).toBe(422);
      }
      await expectRefused(s, 422, new RegExp(status));
    }
  });

  it('refuses a snapshot written by a newer server format', async () => {
    const s = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    await su.query(`update epm.snapshot set manifest = jsonb_set(manifest, '{schema_ver}', to_jsonb($2::int)) where snapshot_id = $1`, [s.snapshot_id, SCHEMA_VER + 1]);
    await expectRefused(s, 422, /newer/);
  });
});
