import { gunzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRetention, runNightlySnapshots } from '../../src/backup/snapshots.js';
import { poolDatabase } from '../../src/db.js';
import { randomUUID } from '../helpers.js';
import { type Env, expectOk, setupEnv } from './data-helpers.js';

/**
 * The nightly job and retention. A nightly snapshot is the backup an application falls back on, so
 * "unchanged since the last one" must really mean unchanged, and retention must never remove what
 * it promises to keep.
 */
describe('nightly snapshots and retention', () => {
  let env: Env;
  let base: string;
  let deps: { db: ReturnType<typeof poolDatabase>; blobs: Env['h']['blobs'] };

  const latestNightly = async () =>
    (await env.su.query(`select * from epm.snapshot where app_id = $1 and kind = 'nightly' and status = 'complete' order by created_at desc limit 1`, [env.appId])).rows[0];
  const datasetsIn = async (snap: any) =>
    JSON.parse(strFromU8(gunzipSync((await env.h.blobs.get(`${snap.storage_prefix}/datasets.json.gz`))!)));
  const metadataIn = async (snap: any) =>
    JSON.parse(strFromU8(gunzipSync((await env.h.blobs.get(`${snap.storage_prefix}/metadata.json.gz`))!)));

  beforeAll(async () => {
    env = await setupEnv('retention');
    base = env.base;
    deps = { db: poolDatabase(env.h.pool), blobs: env.h.blobs };
    await env.write([{ k: env.coord(), v: '1' }]);
    const f = expectOk(await env.admin.upload(base, 'codes.csv', 'Code,Member\nR,Revenue\n', 'dataset'), 201);
    expectOk(await env.admin.put(`${base}/datasets/Codes`, { file_id: f.file_id }));
  });
  afterAll(async () => env?.close());

  it('two nightly runs at once both finish, leave nothing running, and the newest nightly stays restorable', async () => {
    const [a, b] = await Promise.all([runNightlySnapshots(deps, { jobKey: env.h.db.jobKey }), runNightlySnapshots(deps, { jobKey: env.h.db.jobKey })]);
    for (const res of [a, b]) expect(res.find((x) => x.app_id === env.appId)?.status).not.toBe('failed');
    const running = (await env.su.query(`select count(*)::int as n from epm.snapshot where status = 'running'`)).rows[0].n;
    expect(running).toBe(0);
    const newest = await latestNightly();
    expect(newest).toBeDefined();
    for (const f of newest.manifest.files) expect(await env.h.blobs.get(`${newest.storage_prefix}/${f.name}`)).not.toBeNull();
    const dry = expectOk(await env.admin.post(`${base}/snapshots/${newest.snapshot_id}/restore`, { target: 'in_place', dry_run: true }));
    expect(dry).toMatchObject({ cells_set: 0, cells_cleared: 0, skipped: 0 });
  });

  it('retention keeps manual snapshots, the newest nightly, unexpired pre-restore snapshots and other applications\' snapshots', async () => {
    const appX = randomUUID();
    const appY = randomUUID();
    const now = new Date('2026-10-01T12:00:00Z');
    const ins = async (app: string, kind: string, daysAgo: number, expires: Date | null = null) => {
      const prefix = `${env.tenantId}/${app}/snapshots/${randomUUID()}`;
      await env.h.blobs.put(`${prefix}/manifest.json`, new Uint8Array([1]), 'application/json');
      await env.h.blobs.put(`${prefix}/facts-0001.ndjson.gz`, new Uint8Array([1]), 'application/gzip');
      const created = new Date(now.getTime() - daysAgo * 86_400_000);
      const row = await env.su.query<{ snapshot_id: string }>(
        `insert into epm.snapshot (tenant_id, app_id, app_name, kind, schema_ver, storage_prefix, status, created_at, expires_at, manifest)
         values ($1, $2, 'X', $3, 1, $4, 'complete', $5, $6, $7) returning snapshot_id`,
        [env.tenantId, app, kind, prefix, created, expires,
         JSON.stringify({ files: [{ name: 'facts-0001.ndjson.gz' }] })],
      );
      return { id: row.rows[0]!.snapshot_id, prefix, created };
    };
    const nightly = [];
    for (let i = 0; i < 400; i += 3) nightly.push(await ins(appX, 'nightly', i + 0.5));
    const manualOld = await ins(appX, 'manual', 900);
    const preLive = await ins(appX, 'pre_restore', 10, new Date(now.getTime() + 80 * 86_400_000));
    const preDead = await ins(appX, 'pre_restore', 100, new Date(now.getTime() - 10 * 86_400_000));
    const otherApp = [await ins(appY, 'nightly', 500), await ins(appY, 'pre_restore', 300, new Date('2000-01-01'))];

    const expired = new Set(await applyRetention(deps, { tenantId: env.tenantId, userId: null }, appX, now));
    expect(expired.has(nightly[0]!.id)).toBe(false);
    for (const keep of [manualOld, preLive, ...otherApp]) {
      expect(expired.has(keep.id)).toBe(false);
      expect(await env.h.blobs.get(`${keep.prefix}/manifest.json`)).not.toBeNull();
    }
    expect(expired.has(preDead.id)).toBe(true);
    // 30 newest nightlies, plus the newest of each of the 12 newest months (UTC).
    const want = new Set(nightly.slice(0, 30).map((n) => n.id));
    const months = new Set<string>();
    for (const n of nightly) {
      const m = n.created.toISOString().slice(0, 7);
      if (months.has(m)) continue;
      if (months.size >= 12) break;
      months.add(m);
      want.add(n.id);
    }
    expect(nightly.filter((n) => !expired.has(n.id)).map((n) => n.id).sort()).toEqual([...want].sort());
    for (const n of nightly.filter((x) => expired.has(x.id))) {
      expect(await env.h.blobs.get(`${n.prefix}/manifest.json`)).toBeNull();
      expect(await env.h.blobs.get(`${n.prefix}/facts-0001.ndjson.gz`)).toBeNull();
    }
    // Running it again expires nothing more.
    expect(await applyRetention(deps, { tenantId: env.tenantId, userId: null }, appX, now)).toEqual([]);
  });

  it('FINDING: a new dataset version is captured by the next nightly snapshot', async () => {
    const first = await runNightlySnapshots(deps, { jobKey: env.h.db.jobKey });
    expect(first.find((x) => x.app_id === env.appId)?.status).not.toBe('failed');
    const f = expectOk(await env.admin.upload(base, 'codes2.csv', 'Code,Member\nR,Revenue\nO,Opex\n', 'dataset'), 201);
    expectOk(await env.admin.put(`${base}/datasets/Codes`, { file_id: f.file_id }));
    const res = await runNightlySnapshots(deps, { jobKey: env.h.db.jobKey });
    const latest = await latestNightly();
    const codes = (await datasetsIn(latest)).find((d: any) => d.name === 'Codes');
    expect({ status: res.find((x) => x.app_id === env.appId)?.status, version: codes.version, rows: codes.rows.length })
      .toEqual({ status: 'taken', version: 2, rows: 2 });
  });

  it('FINDING: changed forms, grants and plan windows are captured by the next nightly snapshot', async () => {
    await runNightlySnapshots(deps, { jobKey: env.h.db.jobKey });
    expectOk(await env.admin.put(`${base}/forms/New Form`, { cube: 'Plan', definition: {
      pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Product: 'Widgets', Entity: 'East' },
      rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } } }));
    expectOk(await env.admin.put(`${base}/plan-windows`, { scenario: 'Actual', version: 'Final', years: 'FY27', locked: true }));
    expectOk(await env.admin.post('/v1/users', { email: 'zed@retention.test' }), 201);
    expectOk(await env.admin.put(`${base}/grants`, { grants: [{ principal: { user: 'zed@retention.test' }, dimension: 'Entity', member: 'East', access: 'write' }] }));
    await runNightlySnapshots(deps, { jobKey: env.h.db.jobKey });
    const meta = await metadataIn(await latestNightly());
    expect({ forms: meta.forms.map((x: any) => x.name), windows: meta.plan_windows.length, grants: meta.grants.length })
      .toEqual({ forms: ['New Form'], windows: 1, grants: 1 });
  });
});
