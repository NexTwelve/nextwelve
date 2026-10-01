import { createHash } from 'node:crypto';
import { gzipSync, strToU8 } from 'fflate';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, createAbuseHarness, keysUnder, superuser } from './abuse-helpers.js';

const R = { REV: 2, OPEX: 4 };
const C = { JAN: 0, FEB: 1 };

/** Snapshots and restores when object storage misbehaves, or hands back bytes that do not parse. */
describe('adversarial: storage failures and corrupt snapshots', () => {
  let h: AbuseHarness;
  let admin: Api;
  let tenantId: string;
  let appId: string;
  let base: string;
  let good: any;

  async function edit(edits: [number, number, number | null][]) {
    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  }
  const cells = async () => {
    const v = expectOk(await admin.post(`${base}/grid/read`, planGrid())).values;
    return [v[R.REV][C.JAN], v[R.REV][C.FEB], v[R.OPEX][C.JAN]];
  };
  const snapshots = async () => expectOk(await admin.get(`${base}/snapshots`)).snapshots as any[];
  const apps = async () => expectOk(await admin.get('/v1/apps')).apps as any[];
  const txnCount = async () => expectOk(await admin.get(`${base}/txns?limit=200`)).txns.length;

  /** Replace a file and make the manifest in Postgres agree with it, so only parsing can catch it. */
  async function tamper(snap: any, name: string, bytes: Uint8Array) {
    await h.store.put(`${snap.storage_prefix}/${name}`, bytes, 'application/gzip');
    const sha = createHash('sha256').update(bytes).digest('hex');
    const su = await superuser(h.db);
    await su.query(
      `update epm.snapshot set manifest = jsonb_set(manifest, '{files}', (
         select jsonb_agg(case when f->>'name' = $2 then f || jsonb_build_object('bytes', $3::int, 'sha256', $4::text) else f end)
           from jsonb_array_elements(manifest->'files') f))
        where snapshot_id = $1`,
      [snap.snapshot_id, name, bytes.byteLength, sha],
    );
    await su.end();
  }
  const freshSnapshot = async () => expectOk(await admin.post(`${base}/snapshots`, {}), 201);

  beforeAll(async () => {
    h = await createAbuseHarness();
    tenantId = await provisionTenant(h.db, 'Storage Abuse Co', null, 'admin@st.test');
    admin = await signIn(h as any, 'admin@st.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    await edit([[R.REV, C.JAN, 100], [R.REV, C.FEB, 200]]);
    good = await freshSnapshot();
    await edit([[R.REV, C.JAN, 111], [R.OPEX, C.JAN, 5]]);
  });
  beforeEach(() => {
    h.blobHooks.beforePut = undefined;
    h.blobHooks.afterGet = undefined;
    h.unexpected.length = 0;
  });
  afterAll(async () => h?.close());

  it('a failed write marks the snapshot failed with its reason and removes what was written', async () => {
    h.blobHooks.beforePut = (key) => { if (key.endsWith('/datasets.json.gz')) throw new Error('R2 is unavailable'); };
    const r = await admin.post(`${base}/snapshots`, { comment: 'doomed' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    const s = (await snapshots()).find((x) => x.comment === 'doomed');
    expect(s).toMatchObject({ status: 'failed', error: 'R2 is unavailable' });
    expect(keysUnder(h, s.storage_prefix)).toEqual([]);
  });

  it('a failed manifest write leaves nothing behind either', async () => {
    h.blobHooks.beforePut = (key) => { if (key.endsWith('/manifest.json')) throw new Error('quota exceeded'); };
    expect((await admin.post(`${base}/snapshots`, { comment: 'no manifest' })).status).toBeGreaterThanOrEqual(500);
    const s = (await snapshots()).find((x) => x.comment === 'no manifest');
    expect(s.status).toBe('failed');
    expect(keysUnder(h, s.storage_prefix)).toEqual([]);
  });

  it('a write that stored its bytes but then reported an error (a timeout) leaves no orphaned file', async () => {
    h.blobHooks.beforePut = (key) => (key.endsWith('/facts-0001.ndjson.gz') ? 'store-then-throw' : undefined);
    expect((await admin.post(`${base}/snapshots`, { comment: 'timeout' })).status).toBeGreaterThanOrEqual(500);
    const s = (await snapshots()).find((x) => x.comment === 'timeout');
    expect(s.status).toBe('failed');
    expect(keysUnder(h, s.storage_prefix)).toEqual([]);
  });

  it('a snapshot is never left "running" with its manifest in storage when finishing it fails', async () => {
    // The admin is disabled while the export runs (or the database drops the connection at the end):
    // the final update fails, and so does the attempt to mark the snapshot failed, which reuses the same session.
    const su = await superuser(h.db);
    h.blobHooks.beforePut = async (key) => {
      if (key.endsWith('/manifest.json')) await su.query(`update epm.app_user set status = 'disabled' where email = 'admin@st.test'`);
    };
    let status: number;
    try {
      status = (await admin.post(`${base}/snapshots`, { comment: 'cut off' })).status;
    } finally {
      await su.query(`update epm.app_user set status = 'active' where email = 'admin@st.test'`);
    }
    expect(status).toBeGreaterThanOrEqual(400);
    const row = (await su.query(`select status, storage_prefix from epm.snapshot where comment = 'cut off'`)).rows[0];
    await su.end();
    expect({ status: row.status, files: keysUnder(h, row.storage_prefix) }).toEqual({ status: 'failed', files: [] });
  });

  it('truncated bytes from storage are refused before anything is written', async () => {
    h.blobHooks.afterGet = (key, data) => (data && key.endsWith('/facts-0001.ndjson.gz') ? data.slice(0, data.length - 7) : data);
    const before = await cells();
    const nApps = (await apps()).length;
    const nSnaps = (await snapshots()).length;
    const r = await admin.post(`${base}/snapshots/${good.snapshot_id}/restore`, { target: 'in_place' });
    expect([r.status, r.body.message]).toEqual([422, 'facts-0001.ndjson.gz does not match its checksum; the snapshot cannot be trusted']);
    expect((await admin.post(`${base}/snapshots/${good.snapshot_id}/restore`, { target: 'new_app' })).status).toBe(422);
    expect(await cells()).toEqual(before);
    expect((await apps()).length).toBe(nApps);
    expect((await snapshots()).length).toBe(nSnaps); // no pre-restore snapshot either
  });

  it('a missing file is 410 and changes nothing', async () => {
    h.blobHooks.afterGet = (key, data) => (key.endsWith('/metadata.json.gz') ? null : data);
    expect((await admin.post(`${base}/snapshots/${good.snapshot_id}/restore`, { target: 'in_place', dry_run: true })).status).toBe(410);
    expect((await admin.post(`${base}/snapshots/${good.snapshot_id}/restore`, { target: 'new_app' })).status).toBe(410);
  });

  it('a metadata file that is not JSON, or JSON of the wrong shape, fails without creating an application', async () => {
    const nApps = (await apps()).length;
    const before = await cells();
    for (const content of ['this is not json', '{}', '{"dimensions": 5, "members": "x", "cubes": null}']) {
      const snap = await freshSnapshot();
      await tamper(snap, 'metadata.json.gz', gzipSync(strToU8(content)));
      for (const body of [{ target: 'in_place' }, { target: 'new_app' }]) {
        const r = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, body);
        expect(r.status, `${content} ${body.target}`).toBeGreaterThanOrEqual(400);
      }
    }
    expect((await apps()).length).toBe(nApps);
    expect(await cells()).toEqual(before);
  });

  it('a garbage (non-gzip) file with a matching checksum fails without creating an application', async () => {
    const nApps = (await apps()).length;
    const snap = await freshSnapshot();
    await tamper(snap, 'datasets.json.gz', strToU8('PK\u0003\u0004 definitely not gzip'));
    expect((await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app' })).status).toBeGreaterThanOrEqual(400);
    expect((await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', dry_run: true })).status).toBeGreaterThanOrEqual(400);
    expect((await apps()).length).toBe(nApps);
  });

  it('a corrupt facts file fails an in-place restore before the pre-restore snapshot and before any write', async () => {
    const snap = await freshSnapshot();
    await edit([[R.REV, C.JAN, 123]]);
    await tamper(snap, 'facts-0001.ndjson.gz', gzipSync(strToU8('[1,2,3]\n{"broken": ')));
    const before = await cells();
    const nSnaps = (await snapshots()).length;
    const nTxns = await txnCount();
    const r = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await cells()).toEqual(before);
    expect((await snapshots()).length).toBe(nSnaps);
    expect(await txnCount()).toBe(nTxns);
  });

  it('a corrupt facts file does not leave a half-built application behind on a new-app restore', async () => {
    const snap = await freshSnapshot();
    // The first 2 lines are fine; the third is not JSON.
    const facts = (await h.store.get(`${snap.storage_prefix}/facts-0001.ndjson.gz`))!;
    const { gunzipSync, strFromU8 } = await import('fflate');
    const lines = strFromU8(gunzipSync(facts)).split('\n');
    await tamper(snap, 'facts-0001.ndjson.gz', gzipSync(strToU8([...lines.slice(0, 2), '[oops', ...lines.slice(2)].join('\n'))));
    const r = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Corrupt Copy' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    const left = (await apps()).filter((a) => a.name.startsWith('Corrupt Copy'));
    expect(left.map((a) => `${a.name}: ${a.state}`)).toEqual([]);
  });

  it('an internal failure during a new-app restore is reported as unexpected and not echoed to the client', async () => {
    const snap = await freshSnapshot();
    await tamper(snap, 'facts-0001.ndjson.gz', gzipSync(strToU8('not json at all')));
    const r = await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Odd Copy' });
    expect(r.status).toBe(500);
    // Every other 500 goes through onUnexpectedError and says only "internal error".
    expect({ reported: h.unexpected.length > 0, leaksParserText: /Unexpected token|not valid JSON/.test(r.body.message) })
      .toEqual({ reported: true, leaksParserText: false });
  });

  it('a failing pre-restore snapshot stops the in-place restore', async () => {
    await edit([[R.REV, C.JAN, 321]]);
    const before = await cells();
    const nTxns = await txnCount();
    h.blobHooks.beforePut = () => { throw new Error('bucket is read-only'); };
    const r = await admin.post(`${base}/snapshots/${good.snapshot_id}/restore`, { target: 'in_place' });
    expect(r.status).toBeGreaterThanOrEqual(500);
    expect(await cells()).toEqual(before);
    expect(await txnCount()).toBe(nTxns);
    const pre = (await snapshots()).find((s) => s.kind === 'pre_restore' && s.status !== 'complete');
    expect(pre).toMatchObject({ status: 'failed', error: 'bucket is read-only' });
    expect(tenantId).toBeTruthy();
  });
});
