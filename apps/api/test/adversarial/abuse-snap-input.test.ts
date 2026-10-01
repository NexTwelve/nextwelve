import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, randomUUID, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, createAbuseHarness, superuser } from './abuse-helpers.js';

const R = { REV: 2 };
const C = { JAN: 0 };

/** The snapshot endpoints with malformed bodies, odd ids and file names, and snapshots in every state. */
describe('adversarial: snapshot endpoints input and states', () => {
  let h: AbuseHarness;
  let admin: Api;
  let appId: string;
  let base: string;
  let otherBase: string;
  let full: any;
  let otherSnap: any;
  const byState: Record<string, any> = {};

  async function edit(b: string, v: number) {
    const g = expectOk(await admin.post(`${b}/grid/read`, planGrid()));
    const values = g.values.map((row: unknown[]) => [...row]);
    values[R.REV][C.JAN] = v;
    return expectOk(await admin.post(`${b}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  }
  async function appCount(): Promise<number> {
    return expectOk(await admin.get('/v1/apps')).apps.length;
  }
  async function download(b: string, id: string, file: string) {
    const res = await h.app.request(`${b}/snapshots/${id}/files/${file}`, { headers: { authorization: `Bearer ${admin.token}` } });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  beforeAll(async () => {
    h = await createAbuseHarness();
    await provisionTenant(h.db, 'Snap Abuse Co', null, 'admin@sa.test');
    admin = await signIn(h as any, 'admin@sa.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    otherBase = `/v1/apps/${await seedPlanApp(admin, 'Other Plan')}`;
    await edit(base, 100);
    await edit(otherBase, 7);
    full = expectOk(await admin.post(`${base}/snapshots`, { comment: 'baseline' }), 201);
    otherSnap = expectOk(await admin.post(`${otherBase}/snapshots`, {}), 201);
    // Complete snapshots whose row is then put in another state: files and manifest stay, only the status says no.
    const su = await superuser(h.db);
    for (const st of ['running', 'failed', 'expired']) {
      byState[st] = expectOk(await admin.post(`${base}/snapshots`, { comment: st }), 201);
      await su.query('update epm.snapshot set status = $2 where snapshot_id = $1', [byState[st].snapshot_id, st]);
    }
    await su.end();
    await edit(base, 250);
  });
  afterAll(async () => h?.close());

  it('refuses malformed snapshot and restore bodies with a 4xx, creating nothing', async () => {
    h.unexpected.length = 0;
    const before = (await admin.get(`${base}/snapshots`)).body.snapshots.length;
    const apps = await appCount();
    const got: string[] = [];
    const check = async (label: string, url: string, body: unknown) => {
      const r = await admin.post(url, body);
      if (r.status < 400 || r.status >= 500) got.push(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
    };
    const snaps = `${base}/snapshots`;
    for (const [label, body] of [
      ['array', []], ['string', 'x'],
      ['scope a string', { scope: 'all' }], ['scope null', { scope: null }],
      ['scenarios empty', { scope: { scenarios: [] } }], ['scenarios blank name', { scope: { scenarios: [''] } }],
      ['scenarios a string', { scope: { scenarios: 'Budget' } }], ['versions numbers', { scope: { versions: [1] } }],
      ['unknown scenario', { scope: { scenarios: ['Plan B'] } }], ['a version named as a scenario', { scope: { scenarios: ['Working'] } }],
      ['comment too long', { comment: 'x'.repeat(501) }], ['comment a number', { comment: 5 }],
    ] as [string, unknown][]) await check(`create ${label}`, snaps, body);
    const restore = `${base}/snapshots/${full.snapshot_id}/restore`;
    for (const [label, body] of [
      ['empty', {}], ['unknown target', { target: 'NEW_APP' }], ['target a number', { target: 1 }],
      ['versions empty', { target: 'in_place', versions: [] }], ['versions a string', { target: 'in_place', versions: 'Working' }],
      ['scenarios blank', { target: 'in_place', scenarios: [''] }], ['dry_run a string', { target: 'in_place', dry_run: 'true' }],
      ['into_version empty', { target: 'in_place', versions: ['Working'], into_version: '' }],
      ['into_version blank', { target: 'in_place', versions: ['Working'], into_version: '   ' }],
      ['into_version without one version', { target: 'in_place', into_version: 'Final' }],
      ['into_version unknown', { target: 'in_place', versions: ['Working'], into_version: 'Nope' }],
      ['versions outside the snapshot scope', { target: 'in_place', versions: ['Final'], dry_run: true }],
      ['comment too long', { target: 'in_place', comment: 'x'.repeat(501) }],
      ['new_app name empty', { target: 'new_app', name: '' }], ['new_app name blank', { target: 'new_app', name: '   ' }],
      ['new_app name 201 chars', { target: 'new_app', name: 'n'.repeat(201) }], ['new_app name a number', { target: 'new_app', name: 42 }],
    ] as [string, unknown][]) {
      // 'versions outside the snapshot scope' needs a scoped snapshot.
      const url = label.startsWith('versions outside') ? `${base}/snapshots/${(expectOk(await admin.post(snaps, { scope: { versions: ['Working'] } }), 201)).snapshot_id}/restore` : restore;
      await check(`restore ${label}`, url, body);
    }
    expect(got).toEqual([]);
    expect(h.unexpected).toEqual([]);
    expect(await appCount()).toBe(apps);
    const after = (await admin.get(`${base}/snapshots`)).body.snapshots;
    expect(after.filter((s: any) => s.status === 'running')).toHaveLength(1); // only the one set up as running
    expect(after.length).toBe(before + 1); // the scoped snapshot made for one case
  });

  it('treats any id that is not a UUID as not found (404), on every snapshot route', async () => {
    const got: string[] = [];
    for (const id of ['nope', '1', '------------------------------------', 'ffffffffffffffffffffffffffffffffffff', randomUUID(), otherSnap.snapshot_id]) {
      const routes: [string, () => Promise<{ status: number }>][] = [
        ['get', () => admin.get(`${base}/snapshots/${id}`)],
        ['file', () => download(base, id, 'manifest.json')],
        ['restore', () => admin.post(`${base}/snapshots/${id}/restore`, { target: 'in_place', dry_run: true })],
      ];
      for (const [name, call] of routes) {
        const r = await call();
        if (r.status !== 404) got.push(`${name} ${id}: ${r.status}`);
      }
    }
    expect(got).toEqual([]);
  });

  it('serves only files listed in the manifest', async () => {
    const id = full.snapshot_id;
    expect((await download(base, id, 'metadata.json.gz')).status).toBe(200);
    for (const f of ['nope.gz', '..%2Fmanifest.json', '..%2F..%2F..%2F' + otherSnap.storage_prefix.split('/').slice(0, 2).join('%2F') + '%2Fmanifest.json',
      'MANIFEST.JSON', 'facts-0002.ndjson.gz', 'x'.repeat(300)]) {
      expect((await download(base, id, f)).status, f).toBe(404);
    }
    // Another app's snapshot through this app's URL.
    expect((await download(base, otherSnap.snapshot_id, 'metadata.json.gz')).status).toBe(404);
  });

  it('logs a snapshot download only when a file was actually served', async () => {
    const su = await superuser(h.db);
    const events = async () => (await su.query(
      `select detail->>'file' as file from epm.security_event where app_id = $1 and event_type = 'snapshot_downloaded'`, [appId])).rows.map((r) => r.file);
    const before = await events();
    expect((await download(base, full.snapshot_id, 'no-such-file.gz')).status).toBe(404);
    expect((await download(base, full.snapshot_id, '<script>alert(1)</script>')).status).toBe(404);
    const added = (await events()).slice(before.length);
    await su.end();
    expect(added).toEqual([]);
  });

  it('refuses to download or restore snapshots that are running, failed or expired, creating nothing', async () => {
    h.unexpected.length = 0;
    const apps = await appCount();
    const v = () => admin.post(`${base}/grid/read`, planGrid()).then((r) => expectOk(r).values[R.REV][C.JAN]);
    for (const st of ['running', 'failed', 'expired']) {
      const id = byState[st].snapshot_id;
      expect((await download(base, id, 'manifest.json')).status, `${st} manifest`).toBeGreaterThanOrEqual(400);
      expect((await download(base, id, 'metadata.json.gz')).status, `${st} metadata`).toBeGreaterThanOrEqual(400);
      const dry = await admin.post(`${base}/snapshots/${id}/restore`, { target: 'in_place', dry_run: true });
      expect([dry.status, dry.body.message], st).toEqual([422, `snapshot is ${st}, not complete`]);
      expect((await admin.post(`${base}/snapshots/${id}/restore`, { target: 'in_place' })).status, `${st} in place`).toBe(422);
      expect((await admin.post(`${base}/snapshots/${id}/restore`, { target: 'new_app' })).status, `${st} new app`).toBe(422);
    }
    expect(await appCount()).toBe(apps);
    expect(await v()).toBe(250);
    expect(h.unexpected).toEqual([]);
  });

  it('an in-place restore naming a version that exists nowhere is refused, not reported as "nothing to change"', async () => {
    const r = await admin.post(`${base}/snapshots/${full.snapshot_id}/restore`, { target: 'in_place', versions: ['Wroking'], dry_run: true });
    expect([r.status, r.body.cells_set, r.body.cells_cleared]).not.toEqual([200, 0, 0]);
    expect(r.status).toBe(422);
  });

  it('names and ids from storage cannot break the download headers', async () => {
    const evil = expectOk(await admin.post('/v1/apps', { name: 'Evil"; filename="x.exe\r\nSet-Cookie: a=b' }), 201);
    const snap = expectOk(await admin.post(`/v1/apps/${evil.app_id}/snapshots`, {}), 201);
    const res = await download(`/v1/apps/${evil.app_id}`, snap.snapshot_id, 'manifest.json');
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toMatch(/^attachment; filename="[\w.-]+"$/);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('NUL characters in snapshot comments, scopes and new application names are a 4xx, not a 500', async () => {
    const got: string[] = [];
    for (const [label, url, body] of [
      ['snapshot comment', `${base}/snapshots`, { comment: 'nul\u0000' }],
      ['snapshot scope', `${base}/snapshots`, { scope: { versions: ['Work\u0000ing'] } }],
      ['new_app name', `${base}/snapshots/${full.snapshot_id}/restore`, { target: 'new_app', name: 'Copy\u0000' }],
    ] as [string, string, unknown][]) {
      const r = await admin.post(url, body);
      if (r.status < 400 || r.status >= 500) got.push(`${label}: ${r.status}`);
    }
    const file = await download(base, full.snapshot_id, 'manifest.json%00');
    if (file.status !== 404) got.push(`file name manifest.json%00: ${file.status}`);
    expect(got).toEqual([]);
  });
});
