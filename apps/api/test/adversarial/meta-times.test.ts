import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser } from './abuse-helpers.js';
import { byDim, expectOk, type MetaEnv, setupMeta } from './meta-helpers.js';

/**
 * Which moment a metadata restore goes back to: exactly at a deploy or a definition save (to the
 * microsecond), just before it, between deploys, before history, in the future, before the first
 * deploy, and around revisions that epm.add_version_leaf records on its own.
 */
describe('adversarial: metadata restore times', () => {
  let env: MetaEnv;

  const shift = async (iso: string, micros: number) =>
    (await env.su.query<{ t: string }>(
      `select to_char(($1::timestamptz + make_interval(secs => $2::double precision / 1000000)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`,
      [iso, micros],
    )).rows[0]!.t;

  beforeAll(async () => {
    env = await setupMeta('mtime');
  });
  afterAll(async () => env?.close());

  it('a time exactly at a deploy includes that deploy; one microsecond earlier does not', async () => {
    const a = await env.newApp('Times Exact');
    await a.put('Product', [{ name: 'Gizmos', parent: 'All Products' }]);
    const rev = await a.deploy();
    const hist = expectOk(await env.admin.get(`${a.base}/metadata/history`));
    const d = hist.deploys.find((x: { metadata_rev: number }) => x.metadata_rev === rev).deployed_at as string;

    const at = expectOk(await a.restore({ at: d, dimensions: ['Product'], definitions: false, dry_run: true }));
    expect(at.source.metadata_rev).toBe(rev);
    expect(at.changes).toBe(0);
    // The same instant written with another offset.
    const local = (await env.su.query<{ t: string }>(
      `select to_char($1::timestamptz at time zone '+05:30', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '-05:30' as t`, [d])).rows[0]!.t;
    expect(local).not.toBe(d);
    const atLocal = expectOk(await a.restore({ at: local, dimensions: ['Product'], definitions: false, dry_run: true }));
    expect(atLocal.source).toMatchObject({ metadata_rev: rev, at: d });
    const before = expectOk(await a.restore({ at: await shift(d, -1), dimensions: ['Product'], definitions: false, dry_run: true }));
    expect(before.source.metadata_rev).toBe(rev - 1);
    expect(byDim(before).Product.removed).toEqual(['Gizmos']);
  });

  it('a time exactly at a definition save includes that save; one microsecond earlier does not', async () => {
    const a = await env.newApp('Times Defs');
    const def = (months: string[]) => ({
      cube: 'Plan',
      definition: { pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: months } },
    });
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, def(['Jan'])));
    await env.pause();
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, def(['Jan', 'Feb'])));
    const h = expectOk(await env.admin.get(`${a.base}/forms/Entry/history`)).history;
    expect(h.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    const v2 = h[0].changed_at as string;

    const at = expectOk(await a.restore({ at: v2, members: false, dry_run: true }));
    expect(at.definitions.unchanged).toBe(1);
    const before = expectOk(await a.restore({ at: await shift(v2, -1), members: false, dry_run: true }));
    expect(before.definitions.updated).toEqual([{ type: 'form', name: 'Entry' }]);
  });

  it('a time between two deploys restores the earlier one', async () => {
    const a = await env.newApp('Times Between');
    await a.put('Product', [{ name: 'One', parent: 'All Products' }]);
    const r1 = await a.deploy();
    await env.pause();
    const mid = await env.now();
    await env.pause();
    await a.put('Product', [{ name: 'Two', parent: 'All Products' }]);
    await a.deploy();
    const r = expectOk(await a.restore({ at: mid, dimensions: ['Product'], definitions: false, dry_run: true }));
    expect(r.source.metadata_rev).toBe(r1);
    expect(byDim(r).Product.removed).toEqual(['Two']);
  });

  it('refuses times before history, in the future, and before an application was ever deployed', async () => {
    const a = await env.newApp('Times Edges');
    const hist = expectOk(await env.admin.get(`${a.base}/metadata/history`));
    const early = await a.restore({ at: await shift(hist.history_from, -1) });
    expect(early.status).toBe(422);
    expect(early.body.message).toMatch(/history for this application starts/);
    const future = await a.restore({ at: await shift(await env.now(), 60_000_000) });
    expect(future.status).toBe(422);
    expect(future.body.message).toMatch(/future/);
    expect((await a.restore({ at: 'yesterday' })).status).toBe(422);

    // A brand-new application (metadata_rev 0): history starts at its creation, nothing deployed yet.
    const fresh = expectOk(await env.admin.post('/v1/apps', { name: 'Times Fresh' }), 201) as { app_id: string; metadata_rev: number };
    expect(fresh.metadata_rev).toBe(0);
    const fh = expectOk(await env.admin.get(`/v1/apps/${fresh.app_id}/metadata/history`));
    expect(fh.deploys).toEqual([]);
    expect(fh.history_from <= (await env.now())).toBe(true);
    const r = await env.admin.post(`/v1/apps/${fresh.app_id}/metadata/restore`, { at: await env.now() });
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/nothing had been deployed/);
  });

  it('a version added on its own (add_version_leaf) is its own revision, without the saved edits of other dimensions', async () => {
    const a = await env.newApp('Times Leaf');
    const versionDim = (await env.su.query<{ dim_id: number }>(`select dim_id from epm.dimension where app_id = $1 and name = 'Version'`, [a.appId])).rows[0]!.dim_id;
    await a.put('Product', [{ name: 'Gizmos', parent: 'All Products' }]); // saved, not deployed
    await env.pause();
    const t1 = await env.now();
    await env.pause();
    await asUser(env.h.pool, env.tenantId, env.email, (c) => c.query('select epm.add_version_leaf($1, $2)', [versionDim, 'V9']));
    await env.pause();
    const t2 = await env.now();
    await env.pause();
    const r3 = await a.deploy(); // now Gizmos is deployed too

    const hist = expectOk(await env.admin.get(`${a.base}/metadata/history`));
    expect(hist.deploys.map((d: { metadata_rev: number }) => d.metadata_rev).slice(0, 3)).toEqual([r3, r3 - 1, r3 - 2]);

    const atT2 = expectOk(await a.restore({ at: t2, dimensions: ['Product', 'Version'], definitions: false, dry_run: true }));
    expect(atT2.source.metadata_rev).toBe(r3 - 1);
    expect(byDim(atT2).Product.removed).toEqual(['Gizmos']);
    expect(byDim(atT2).Version).toMatchObject({ removed: [], recreated: [], changed: [] });
    const atT1 = expectOk(await a.restore({ at: t1, dimensions: ['Version'], definitions: false, dry_run: true }));
    expect(byDim(atT1).Version.removed).toEqual(['V9']);
  });
});
