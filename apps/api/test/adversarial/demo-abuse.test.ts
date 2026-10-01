import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDemoConfig } from '../../src/config.js';
import { DEMO_MAX_SNAPSHOTS } from '../../src/backup/snapshots.js';
import { DEMO_MAX_UPLOAD } from '../../src/demo.js';
import { Api, expectOk } from '../helpers.js';
import { buildTemplate, createDemoHarness, DEMO, type DemoHarness, startDemo, startOk, streamed, su } from './demo-helpers.js';

/** What an anonymous visitor can do to the demo's limits: starts, uploads, snapshots, growth. */
describe('adversarial demo: abuse of limits', () => {
  let h: DemoHarness;

  /** Forget every start and close every live copy, so each test begins with an empty demo. */
  const reset = async () => {
    await su(h, 'delete from epm.demo_signup');
    await su(h, "update epm.tenant set demo_expires_at = now() - interval '1 second' where demo_expires_at > now()");
  };
  const liveCopies = async () => (await su(h, 'select count(*)::int as n from epm.tenant where demo_expires_at > now()'))[0].n as number;

  beforeAll(async () => {
    h = await createDemoHarness({ ...DEMO, maxLive: 6, perIpHour: 3 });
    await buildTemplate(h);
  }, 40_000);
  afterAll(async () => h?.close());

  it('the per-network limit follows CF-Connecting-IP; a spoofed X-Forwarded-For does not reset it', async () => {
    await reset();
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      codes.push((await startDemo(h, '198.51.100.20', { headers: { 'x-forwarded-for': `10.0.0.${i}, 198.51.100.20` } })).status);
    }
    expect(codes).toEqual([201, 201, 201, 429]);
    // Without any address the visitor shares one bucket ("unknown"), so leaving headers off does not help either.
    await reset();
    const anon: number[] = [];
    for (let i = 0; i < 4; i++) anon.push((await startDemo(h, null)).status);
    expect(anon).toEqual([201, 201, 201, 429]);
  });

  it('FINDING: addresses from one IPv6 /64 each get their own allowance, so one machine can fill every slot', async () => {
    await reset();
    // Any IPv6 host controls at least a /64 (2^64 addresses); here four of them.
    const codes: number[] = [];
    for (let i = 1; i <= 4; i++) codes.push((await startDemo(h, `2001:db8:1234:5678::${i.toString(16)}`)).status);
    // Should be: the fourth start from the same /64 is refused like the fourth from one IPv4 address.
    expect(codes).toEqual([201, 201, 201, 429]);
  });

  it('FINDING: one address takes every live slot by starting a few copies each hour (the limit counts an hour, copies live a day)', async () => {
    await reset();
    const ip = '198.51.100.25';
    for (let i = 0; i < 3; i++) expect((await startDemo(h, ip)).status).toBe(201);
    // An hour later (the copies still have 23 hours to live), the same address starts three more.
    await su(h, "update epm.demo_signup set created_at = created_at - interval '61 minutes'");
    for (let i = 0; i < 3; i++) await startDemo(h, ip);
    // Should be: one address cannot hold every copy; another visitor still gets one.
    const other = await startDemo(h, '203.0.113.200');
    expect(other.status, JSON.stringify(other.body)).toBe(201);
  });

  it('the cap on live copies holds when many visitors start at once', async () => {
    await reset();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => startDemo(h, `192.0.2.${100 + i}`)));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(6);
    expect(codes.filter((c) => c === 503)).toHaveLength(4);
    expect(await liveCopies()).toBe(6);
    expect(h.unexpected).toEqual([]);
  });

  it('FINDING: "Start over" when the new start is refused (rate limit) destroys the copy the visitor still had', async () => {
    await reset();
    const ip = '198.51.100.30';
    await startOk(h, ip);
    await startOk(h, ip);
    const third = await startOk(h, ip);
    const again = await startDemo(h, ip, { token: third.token });
    expect(again.status).toBe(429);
    // Should be: the refused restart leaves the visitor's current copy as it was.
    expect((await third.api.get('/v1/apps')).status).toBe(200);
  });

  it('JSON bodies over 1 MB are refused when they say how long they are', async () => {
    await reset();
    const d = await startOk(h, '198.51.100.40');
    const body = JSON.stringify({ replace: true, rules: rules(15_000, 'x'.repeat(80)) });
    expect(body.length).toBeGreaterThan(DEMO_MAX_UPLOAD);
    const r = await h.app.request(`/v1/apps/${d.appId}/import-formats/GL/mappings`, {
      method: 'PUT', body,
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json', 'content-length': String(body.length) },
    });
    expect(r.status).toBe(413);
  });

  it('definition imports and file uploads over 1 MB are refused whatever the headers say', async () => {
    const d = await startOk(h, '198.51.100.46');
    const big = new Uint8Array(DEMO_MAX_UPLOAD + 10).fill(65);
    const raw = await d.api.raw('POST', `/v1/apps/${d.appId}/definitions/import?name=defs.csv`, big, 'text/csv');
    expect(raw.status).toBe(413);
    const form = new FormData();
    form.append('a', new Blob([big.slice(0, 600_000)]), 'a.csv');
    form.append('b', new Blob([big.slice(0, 600_000)]), 'b.csv');
    expect((await d.api.raw('POST', `/v1/apps/${d.appId}/definitions/import`, form)).status).toBe(413);
    const upload = await h.app.request(`/v1/apps/${d.appId}/files?name=x.csv&purpose=import`, {
      method: 'POST', body: streamed('a'.repeat(DEMO_MAX_UPLOAD + 10)), duplex: 'half',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/octet-stream' },
    } as RequestInit);
    expect(upload.status).toBe(413);
    expect(await h.store.list(`${d.tenantId}/`)).toEqual([]);
  });

  it('FINDING: the same JSON body over 1 MB is accepted and stored when sent without a Content-Length (chunked)', async () => {
    const d = await startOk(h, '198.51.100.41');
    const body = JSON.stringify({ replace: true, rules: rules(30_000, 'x'.repeat(80)) });
    expect(body.length).toBeGreaterThan(3 * DEMO_MAX_UPLOAD);
    const r = await h.app.request(`/v1/apps/${d.appId}/import-formats/GL/mappings`, {
      method: 'PUT', body: streamed(body), duplex: 'half',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
    } as RequestInit);
    const [row] = await su(h, 'select count(*)::int as n from epm.mapping_rule where tenant_id = $1', [d.tenantId]);
    // Should be 413 with the template's rules untouched, as with a Content-Length: the guard only reads the header.
    expect({ status: r.status, rules: row.n }).toEqual({ status: 413, rules: 2 });
  });

  it('FINDING: replace:false appends mapping rules past the 50,000 limit, so a copy\'s rows grow without bound', async () => {
    const d = await startOk(h, '198.51.100.42');
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const body = JSON.stringify({ replace: false, rules: rules(10_000, `b${i}-`) });
      expect(body.length).toBeLessThan(DEMO_MAX_UPLOAD);
      statuses.push((await d.api.put(`/v1/apps/${d.appId}/import-formats/GL/mappings`, JSON.parse(body))).status);
    }
    const [row] = await su(h, 'select count(*)::int as n from epm.mapping_rule where tenant_id = $1', [d.tenantId]);
    // Should be: no format ends up with more rules than one request may set (or the demo has a row quota).
    expect(row.n).toBeLessThanOrEqual(50_000);
    expect(statuses.some((s) => s !== 200)).toBe(true);
  });

  it('FINDING: a copy may store any number of 1 MB uploads (no total), unlike its snapshots', async () => {
    await reset();
    const d = await startOk(h, '198.51.100.43');
    const file = new Uint8Array(DEMO_MAX_UPLOAD - 1024).fill(65);
    let accepted = 0;
    for (let i = 0; i < 64; i++) {
      const r = await d.api.upload(`/v1/apps/${d.appId}`, `junk-${i}.csv`, file);
      if (r.status !== 201) break;
      accepted++;
    }
    const stored = (await h.store.list(`${d.tenantId}/`)).length;
    expect(stored).toBe(accepted);
    // Should be: a demo copy's stored files have a total limit well under 64 MB.
    expect(accepted).toBeLessThan(64);
  });

  it(`FINDING: concurrent snapshot requests get past the cap of ${DEMO_MAX_SNAPSHOTS} snapshots per copy`, async () => {
    const d = await startOk(h, '198.51.100.44');
    const results = await Promise.all(Array.from({ length: 40 }, () => d.api.post(`/v1/apps/${d.appId}/snapshots`, {})));
    const made = results.filter((r) => r.status === 201).length;
    const [row] = await su(h, 'select count(*)::int as n from epm.snapshot where tenant_id = $1', [d.tenantId]);
    expect(results.every((r) => r.status === 201 || r.status === 429)).toBe(true);
    // Should be: never more than the cap, however the requests arrive.
    expect(row.n).toBeLessThanOrEqual(DEMO_MAX_SNAPSHOTS);
    expect(made).toBeLessThanOrEqual(DEMO_MAX_SNAPSHOTS);
  });

  it(`FINDING: once a copy holds ${DEMO_MAX_SNAPSHOTS} snapshots, every restore fails (its pre-restore snapshot is refused) and none can be deleted`, async () => {
    await reset();
    const d = await startOk(h, '198.51.100.45');
    const base = `/v1/apps/${d.appId}`;
    const first = expectOk(await d.api.post(`${base}/snapshots`, {}), 201);
    for (let i = 1; i < DEMO_MAX_SNAPSHOTS; i++) expectOk(await d.api.post(`${base}/snapshots`, {}), 201);
    const g = expectOk(await d.api.post(`${base}/grid/read`, { cube: 'Plan', pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } }));
    expectOk(await d.api.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[123]] }));
    expect(expectOk(await d.api.post(`${base}/snapshots/${first.snapshot_id}/restore`, { target: 'in_place', dry_run: true })).cells_set).toBe(1);
    const r = await d.api.post(`${base}/snapshots/${first.snapshot_id}/restore`, { target: 'in_place' });
    // Should be: the restore the demo exists to show still works (pre-restore snapshots outside the cap, or the oldest dropped).
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe('adversarial demo: browser check configuration', () => {
  it('a configured check is required, and a failed one ends nothing', async () => {
    const seen: (string | null)[] = [];
    const h = await createDemoHarness({ ...DEMO, verifyTurnstile: async (t, ip) => { seen.push(ip); return t === 'good'; } });
    try {
      await buildTemplate(h);
      const first = await startDemo(h, '203.0.113.60', { body: { turnstile_token: 'good' } });
      expect(first.status).toBe(201);
      // "Start over" with a bad token: refused before the old copy is touched.
      const bad = await startDemo(h, '203.0.113.60', { token: first.token, body: { turnstile_token: 'bad' } });
      expect(bad.status).toBe(403);
      expect((await first.api.get('/v1/apps')).status).toBe(200);
      expect((await startDemo(h, '203.0.113.60', { body: {} })).status).toBe(403);
      // The address checked is Cloudflare's, not a header the visitor wrote.
      await startDemo(h, '203.0.113.61', { headers: { 'x-forwarded-for': '6.6.6.6' }, body: { turnstile_token: 'good' } });
      expect(seen.at(-1)).toBe('203.0.113.61');
      // "Start over" from inside a live copy needs no new check; with an ended copy's token it does.
      const over = await startDemo(h, '203.0.113.62', { token: first.token, body: {} });
      expect(over.status).toBe(201);
      expect((await first.api.get('/v1/apps')).status).toBe(401);
      expect((await startDemo(h, '203.0.113.62', { token: first.token, body: {} })).status).toBe(403);
    } finally {
      await h.close();
    }
  }, 30_000);

  it('FINDING: a Turnstile site key without its secret shows the check but never enforces it', async () => {
    // As wrangler.jsonc invites: TURNSTILE_SITE_KEY in vars, `wrangler secret put TURNSTILE_SECRET` forgotten.
    const config = loadDemoConfig({ DEMO_ENABLED: 'true', SESSION_SECRET: 'x'.repeat(32), TURNSTILE_SITE_KEY: '0x4AAAAAAA-site-key' });
    const h = await createDemoHarness(config);
    try {
      await buildTemplate(h);
      expect(expectOk(await new Api(h.app).get('/v1/demo')).turnstile_site_key).toBe('0x4AAAAAAA-site-key');
      const r = await startDemo(h, '203.0.113.50', { body: {} });
      // Should be: refused (403 without a browser-check token, or 503 while half-configured), not a new copy.
      expect(r.status).not.toBe(201);
    } finally {
      await h.close();
    }
  }, 30_000);
});

/** n explicit Entity mapping rules (about 90 bytes each in JSON). */
function rules(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({ dimension: 'Entity', rule_type: 'explicit', source: `${prefix}${i}`, target: 'East' }));
}
