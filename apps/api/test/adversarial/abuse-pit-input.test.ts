import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, createAbuseHarness, superuser } from './abuse-helpers.js';

// planGrid(): rows Net Income, Gross Margin, Revenue, COGS, Opex; columns Jan, Feb, Mar, Q1.
const R = { REV: 2, COGS: 3, OPEX: 4 };
const C = { JAN: 0, FEB: 1 };

/** POST /v1/apps/:app/restore (point-in-time) with malformed and hostile bodies. */
describe('adversarial: point-in-time restore input', () => {
  let h: AbuseHarness;
  let admin: Api;
  let appId: string;
  let base: string;
  const txn: number[] = [];
  const slice = { cube: 'Plan', scenario: 'Budget', version: 'Working' };

  async function edit(edits: [number, number, number | null][], pov = PLAN_POV): Promise<number> {
    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid(pov)));
    const values = g.values.map((row: unknown[]) => [...row]);
    for (const [i, j, v] of edits) values[i][j] = v;
    return expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values })).txn_id;
  }
  async function raw(body: string) {
    const res = await h.app.request(`${base}/restore`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  async function versionMembers(): Promise<{ name: string; deployed: boolean }[]> {
    return expectOk(await admin.get(`${base}/dimensions/Version/members`)).members;
  }

  beforeAll(async () => {
    h = await createAbuseHarness();
    await provisionTenant(h.db, 'Pit Abuse Co', null, 'admin@pit.test');
    admin = await signIn(h as any, 'admin@pit.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    txn.push(await edit([[R.REV, C.JAN, 100], [R.OPEX, C.JAN, 30]]));
    txn.push(await edit([[R.REV, C.JAN, 150], [R.COGS, C.FEB, 40]]));
    // A parent in the Version dimension (with an empty leaf below it), to aim into_version at.
    expectOk(await admin.put(`${base}/dimensions/Version/members`, { members: [{ name: 'Scenarios Parent' }, { name: 'Scratch', parent: 'Scenarios Parent' }] }));
    expectOk(await admin.post(`${base}/deploy`));
  });
  afterAll(async () => h?.close());

  /** Sends each body; returns the ones that did not get a 4xx. */
  async function not4xx(cases: [string, unknown][]): Promise<string[]> {
    const got: string[] = [];
    for (const [label, body] of cases) {
      const r = await admin.post(`${base}/restore`, body);
      if (r.status < 400 || r.status >= 500) got.push(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
    return got;
  }
  const ok = () => ({ ...slice, before_txn: txn[1], dry_run: true });

  it('answers malformed bodies with a 4xx and writes nothing', async () => {
    const got = await not4xx([
      ['array body', []],
      ['null body', null],
      ['string body', 'restore please'],
      ['number body', 42],
      ['empty object', {}],
      ['neither at nor before_txn', { ...slice }],
      ['both at and before_txn', { ...ok(), at: '2026-01-01T00:00:00Z' }],
      ['cube wrong type', { ...ok(), cube: 123 }],
      ['cube empty', { ...ok(), cube: '' }],
      ['cube unknown', { ...ok(), cube: 'Nope' }],
      ['scenario blank', { ...ok(), scenario: '   ' }],
      ['scenario with quotes', { ...ok(), scenario: "Budget'; drop table epm.fact; --" }],
      ['scenario unterminated function', { ...ok(), scenario: '@leaves(' }],
      ['scenario is a version member', { ...ok(), scenario: 'Working' }],
      ['version unknown', { ...ok(), version: 'Nope' }],
      ['filters not an object', { ...ok(), filters: 'East' }],
      ['filter value not an array', { ...ok(), filters: { Entity: 'East' } }],
      ['filter empty array', { ...ok(), filters: { Entity: [] } }],
      ['filter empty member name', { ...ok(), filters: { Entity: [''] } }],
      ['filter unknown dimension', { ...ok(), filters: { Colour: ['Red'] } }],
      ['filter on the version dimension', { ...ok(), filters: { Version: ['Final'] } }],
      ['filter on the scenario dimension', { ...ok(), filters: { scenario: ['Actual'] } }],
      ['filter unknown member', { ...ok(), filters: { Entity: ['Atlantis'] } }],
      ['filter broken expression', { ...ok(), filters: { Entity: ['@leaves('] } }],
      ['filter member with a quote', { ...ok(), filters: { Entity: ["O'Brien"] } }],
      ['at without offset', { ...slice, at: '2026-10-01T10:00:00' }],
      ['at not a date', { ...slice, at: 'yesterday' }],
      ['at a number', { ...slice, at: 1759312800000 }],
      ['at on 30 February', { ...slice, at: '2026-02-30T00:00:00Z' }],
      ['before_txn zero', { ...slice, before_txn: 0 }],
      ['before_txn negative', { ...slice, before_txn: -1 }],
      ['before_txn fractional', { ...slice, before_txn: 1.5 }],
      ['before_txn above 2^53', { ...slice, before_txn: 2 ** 53 + 2 }],
      ['before_txn a string', { ...slice, before_txn: String(txn[1]) }],
      ['before_txn unknown', { ...slice, before_txn: Number.MAX_SAFE_INTEGER }],
      ['into_version empty', { ...ok(), into_version: '' }],
      ['into_version blank', { ...ok(), into_version: '   ' }],
      ['into_version 201 chars', { ...ok(), into_version: 'x'.repeat(201), create_version: true }],
      ['into_version unknown without create', { ...ok(), into_version: 'Brand New' }],
      ['into_version is a parent', { ...ok(), into_version: 'Scenarios Parent' }],
      ['create_version a string', { ...ok(), into_version: 'X', create_version: 'yes' }],
      ['dry_run a string', { ...ok(), dry_run: 'false' }],
      ['comment too long', { ...ok(), comment: 'x'.repeat(501) }],
      ['comment wrong type', { ...ok(), comment: { text: 'hi' } }],
    ]);
    const bad = await raw('{"cube": "Plan", ');
    if (bad.status !== 400) got.push(`truncated JSON: ${bad.status}`);
    expect(got).toEqual([]);
    expect(h.unexpected).toEqual([]);
    // Nothing above may have written: the slice still holds the second edit.
    const v = expectOk(await admin.post(`${base}/grid/read`, planGrid())).values;
    expect([v[R.REV][C.JAN], v[R.COGS][C.FEB]]).toEqual([150, 40]);
  });

  it('a member expression that resolves to no member is a 422, not a 500', async () => {
    // @children of a leaf is empty: leafMember() dereferences the missing first result.
    expect(await not4xx([
      ['scenario @children(Budget)', { ...ok(), scenario: '@children(Budget)' }],
      ['version @descendants(Working)', { ...ok(), version: '@descendants(Working)' }],
    ])).toEqual([]);
  });

  it('timestamps the schema accepts but Postgres rejects are a 422, not a 500', async () => {
    expect(await not4xx([
      ['at in year 0', { ...slice, at: '0000-01-01T00:00:00Z', dry_run: true }],
      ['at with a +23:59 offset', { ...slice, at: '2026-10-01T10:00:00+23:59', dry_run: true }],
    ])).toEqual([]);
  });

  it('NUL characters in names and comments are a 422, not a 500', async () => {
    expect(await not4xx([
      ['NUL in scenario', { ...ok(), scenario: 'Bud\u0000get' }],
      ['NUL in a filter member', { ...ok(), filters: { Entity: ['Ea\u0000st'] } }],
      ['NUL in into_version', { ...ok(), into_version: 'New\u0000Version', create_version: true }],
      ['NUL in comment (real run)', { ...slice, before_txn: txn[1], comment: 'oops\u0000', filters: { Entity: ['East'] } }],
    ])).toEqual([]);
  });

  it('bounds the work a filter list can cause (refuses or de-duplicates thousands of expressions)', async () => {
    // Each expression costs two sequential round trips inside one transaction; a 25 MB body holds ~800,000.
    let queries = 0;
    const count = () => { queries++; };
    h.queryHooks.push(count);
    try {
      const r = await admin.post(`${base}/restore`, { ...ok(), filters: { Entity: Array(3000).fill('@idescendants(Total Company)') } });
      expect({ status: r.status, queriesBounded: r.status === 422 || queries < 200 }).toMatchObject({ queriesBounded: true });
    } finally {
      h.queryHooks.splice(h.queryHooks.indexOf(count), 1);
    }
  });

  it('accepts the far past and far future as points in time', async () => {
    const past = expectOk(await admin.post(`${base}/restore`, { ...slice, at: '1970-01-01T00:00:00Z', dry_run: true }));
    expect(past.as_of).toMatchObject({ chain_seq: 0, txn_id: null });
    expect(past.cells_cleared).toBeGreaterThan(0);
    const future = expectOk(await admin.post(`${base}/restore`, { ...slice, at: '9999-12-31T23:59:59.999999999Z', dry_run: true }));
    expect(future).toMatchObject({ cells_set: 0, cells_cleared: 0 });
  });

  it('trims into_version and matches it case-insensitively instead of creating look-alikes', async () => {
    const r = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: txn[1], into_version: '  final  ', create_version: true, dry_run: true }));
    expect(r).toMatchObject({ target_version: 'Final', version_created: false });
    const same = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: txn[1], into_version: 'WORKING', dry_run: true }));
    expect(same.target_version).toBe('Working'); // the source version: an in-place restore
    expect((await versionMembers()).map((m) => m.name)).not.toContain('final');
  });

  it('a 200-character new version name works, and a dry run leaves no member behind', async () => {
    const long = 'V'.repeat(200);
    const dry = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: txn[1], into_version: long, create_version: true, dry_run: true }));
    expect(dry).toMatchObject({ version_created: false, target_version: long });
    expect((await versionMembers()).map((m) => m.name)).not.toContain(long);
  });

  it('creating the target version does not deploy unrelated pending metadata changes', async () => {
    // Another admin's half-finished edit: a new Product member, saved but not deployed.
    expectOk(await admin.put(`${base}/dimensions/Product/members`, { members: [{ name: 'Prototype', parent: 'All Products' }] }));
    const pending = async () =>
      (expectOk(await admin.get(`${base}/dimensions/Product/members`)).members as { name: string; deployed: boolean }[]).find((m) => m.name === 'Prototype');
    expect((await pending())!.deployed).toBe(false);
    const r = expectOk(await admin.post(`${base}/restore`, { ...slice, before_txn: txn[1], into_version: 'Rebuilt', create_version: true }));
    expect(r).toMatchObject({ version_created: true, target_version: 'Rebuilt' });

    // The restore needed the new version deployed; it must not have published the pending Product edit.
    const su = await superuser(h.db);
    const deploys = (await su.query(
      `select count(*)::int as n from epm.security_event where app_id = $1 and event_type = 'metadata_deploy'
        and created_at >= now() - interval '1 minute'`, [appId])).rows[0].n;
    await su.end();
    expect({ pendingMemberDeployed: (await pending())!.deployed, recentDeploys: deploys }).toMatchObject({ pendingMemberDeployed: false });
  });
});
