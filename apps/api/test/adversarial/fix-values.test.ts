import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Env, expectOk, setupEnv } from './data-helpers.js';
import { rewriteSnapshot } from './fix-helpers.js';

/**
 * Second pass on "values as decimal text" (snapshot format 2). The server writes value::text, but a
 * restore reads whatever text the file holds. Files rewritten with a matching checksum (storage and
 * database access) carrying odd numeric text: does the restore reject them or misstore them?
 */
describe('fix: cell values as text in snapshot files', () => {
  let env: Env;
  let snapId: string;
  let k: number[];

  /** A fresh copy of the snapshot whose single changed cell reads `text`. */
  async function withValue(text: string): Promise<string> {
    const s = expectOk(await env.admin.post(`${env.base}/snapshots`, {}), 201);
    await rewriteSnapshot(env.h.blobs, env.su, s.snapshot_id, { facts: (l) => (l.slice(0, 16).join(',') === k.join(',') ? [...l.slice(0, 16), text] : l) });
    return s.snapshot_id;
  }
  const nanFacts = async () => Number((await env.su.query("select count(*)::int as n from epm.fact where value = 'NaN'")).rows[0].n);
  const value = async () => (await env.su.query<{ v: string }>(
    `select value::text as v from epm.fact where app_id = $1 and cube_id = $2 and scenario_id = $3 and version_id = $4 and years_id = $5
        and period_id = $6 and entity_id = $7 and account_id = $8 and department_id = $9 and c1 = $10`,
    [env.appId, ...k.slice(0, 9)],
  )).rows[0]?.v ?? null;

  beforeAll(async () => {
    env = await setupEnv('values', 'Values Plan');
    k = env.coord({});
    await env.write([{ k, v: '100' }, { k: env.coord({ Entity: 'West' }), v: '5' }]);
    snapId = (expectOk(await env.admin.post(`${env.base}/snapshots`, {}), 201)).snapshot_id;
    expect(snapId).toBeTruthy();
  });
  afterAll(async () => env?.close());

  it('FINDING: "NaN" in a snapshot file is refused, never stored as a cell value', async () => {
    const s = await withValue('NaN');
    const copy = await env.admin.post(`${env.base}/snapshots/${s}/restore`, { target: 'new_app', name: 'NaN Copy' });
    await env.write([{ k, v: '1' }]);
    const inPlace = await env.admin.post(`${env.base}/snapshots/${s}/restore`, { target: 'in_place' });
    expect({ copy: copy.status, inPlace: inPlace.status, nanFacts: await nanFacts() }).toEqual({ copy: 422, inPlace: 422, nanFacts: 0 });
  });

  it('"Infinity" and out-of-range values are refused with a 4xx and leave nothing behind', async () => {
    for (const text of ['Infinity', '-Infinity', '1e30']) {
      const s = await withValue(text);
      const apps = Number((await env.su.query('select count(*)::int as n from epm.application')).rows[0].n);
      const copy = await env.admin.post(`${env.base}/snapshots/${s}/restore`, { target: 'new_app', name: `Bad ${text}` });
      expect([text, copy.status]).toEqual([text, 422]);
      expect(Number((await env.su.query('select count(*)::int as n from epm.application')).rows[0].n)).toBe(apps);
    }
  });

  it('FINDING: decimal text in another spelling ("1e2", "+100", " 100", "100.0000004") restores in place instead of failing as "the data changed"', async () => {
    const out: Record<string, unknown> = {};
    for (const text of ['1e2', '+100', ' 100', '100.0000004']) {
      const s = await withValue(text);
      await env.write([{ k, v: '250' }]);
      const r = await env.admin.post(`${env.base}/snapshots/${s}/restore`, { target: 'in_place' });
      // Either restored (the value is 100) or refused as malformed - never "changed while restoring".
      out[text] = r.status === 200 ? await value() : `${r.status} ${r.body.message}`;
    }
    expect(out).toEqual({ '1e2': '100.000000', '+100': '100.000000', ' 100': '100.000000', '100.0000004': '100.000000' });
  });

  it('a dry run over a snapshot whose text already matches reports nothing to change', async () => {
    const s = await withValue('100.000000');
    await env.write([{ k, v: '100' }]);
    const r = expectOk(await env.admin.post(`${env.base}/snapshots/${s}/restore`, { target: 'in_place', dry_run: true }));
    expect([r.cells_set, r.cells_cleared]).toEqual([0, 0]);
  });
});
