import { gunzipSync, strFromU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Cell, type Env, expectOk, num6, rng, setupEnv, sorted } from './data-helpers.js';

/**
 * A snapshot must be one consistent moment: the facts it holds equal the state at its
 * high_chain_seq, whatever other connections commit while it is being written. Writes are injected
 * deterministically from inside the blob store's put(): after the metadata file, after the datasets
 * file, and between the first and second 50,000-row fetches of the facts cursor.
 */
const PRODUCTS = 390; // 72 cells per product per version, two versions: ~56k facts, two fact files

describe('snapshot consistency under concurrent writes', () => {
  let env: Env;
  let base: string;
  let products: string[];
  const R = rng(777);

  const snapshotFacts = async (snap: any) => {
    const out = new Map<string, string>();
    for (const f of snap.manifest.files.filter((x: any) => x.name.startsWith('facts-'))) {
      const bytes = (await env.h.blobs.get(`${snap.storage_prefix}/${f.name}`))!;
      const text = strFromU8(gunzipSync(bytes));
      if (!text) continue;
      for (const line of text.split('\n')) {
        const a = JSON.parse(line) as number[];
        out.set(a.slice(0, 16).join(','), num6(String(a[16])));
      }
    }
    return out;
  };
  /** The application's facts at chain position seq, replayed from the cell audit. */
  const replay = async (seq: number) => {
    const r = await env.su.query<{ k: number[]; v: string | null }>(
      `select distinct on (a.cell_key) a.coords as k, a.new_value::text as v
         from epm.cell_audit a join epm.change_txn t on t.txn_id = a.txn_id
        where a.app_id = $1 and t.app_id = $1 and t.chain_seq <= $2
        order by a.cell_key, t.chain_seq desc`,
      [env.appId, seq],
    );
    return new Map(r.rows.filter((x) => x.v !== null).map((x) => [x.k.join(','), x.v!]));
  };
  const cellOf = (version: string, i: number) =>
    env.coord({ Version: version, Product: products[i % PRODUCTS]!, Period: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'][i % 6]!,
      Entity: i % 2 ? 'East' : 'West', Account: ['Revenue', 'COGS', 'Opex'][Math.floor(i / 6) % 3]!, Department: Math.floor(i / 18) % 2 ? 'Sales' : 'Operations' });

  beforeAll(async () => {
    env = await setupEnv('consist');
    base = env.base;
    products = Array.from({ length: PRODUCTS }, (_, i) => `P${String(i).padStart(4, '0')}`);
    expectOk(await env.admin.put(`${base}/dimensions/Product/members`, { members: products.map((name) => ({ name, parent: 'All Products' })) }));
    expectOk(await env.admin.post(`${base}/deploy`));
    await env.refreshIds();
    const cells: Cell[] = [];
    for (const version of ['Working', 'Final']) {
      for (const p of products) for (const e of ['East', 'West']) for (const a of ['Revenue', 'COGS', 'Opex'])
        for (const per of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']) for (const d of ['Sales', 'Operations']) {
          cells.push({ k: env.coord({ Version: version, Product: p, Entity: e, Account: a, Period: per, Department: d }), v: String(cells.length % 9973) + '.5' });
        }
    }
    for (let i = 0; i < cells.length; i += 15_000) await env.write(cells.slice(i, i + 15_000));
  }, 40_000);
  afterAll(async () => env?.close());

  it('holds exactly the state at its high_chain_seq while writers commit during the export', async () => {
    const injected: string[] = [];
    const realPut = env.h.blobs.put.bind(env.h.blobs);
    env.h.blobs.put = async (key: string, data: Uint8Array, type: string) => {
      await realPut(key, data, type);
      const name = key.split('/').pop()!;
      if (!key.includes('/snapshots/') || !['metadata.json.gz', 'datasets.json.gz', 'facts-0001.ndjson.gz'].includes(name)) return;
      injected.push(name);
      // Sets, clears and new cells in both versions, early and late in the cursor's order.
      const batch = new Map<string, Cell>();
      for (let n = 0; n < 40; n++) {
        const k = cellOf(R.chance(0.5) ? 'Working' : 'Final', R.int(PRODUCTS * 72));
        batch.set(k.join(','), { k, v: R.chance(0.3) ? null : String(R.int(1000)) });
      }
      const fresh = env.coord({ Scenario: 'Actual', Version: 'Final', Product: products[R.int(PRODUCTS)]! });
      batch.set(fresh.join(','), { k: fresh, v: '1' });
      await env.write([...batch.values()]);
      // A metadata change too: a new product, deployed.
      expectOk(await env.admin.put(`${base}/dimensions/Product/members`, { members: [{ name: `Late ${name}`, parent: 'All Products' }] }));
      expectOk(await env.admin.post(`${base}/deploy`));
    };
    let snap: any;
    const headBefore = await env.head();
    try {
      snap = expectOk(await env.admin.post(`${base}/snapshots`, {}), 201);
    } finally {
      env.h.blobs.put = realPut;
    }
    expect(injected).toEqual(['metadata.json.gz', 'datasets.json.gz', 'facts-0001.ndjson.gz']);
    expect(snap.manifest.files.filter((f: any) => f.name.startsWith('facts-'))).toHaveLength(2);
    expect(snap.high_chain_seq).toBe(headBefore);
    expect(await env.head()).toBe(headBefore + 3);

    const inFile = await snapshotFacts(snap);
    expect(inFile.size).toBe(snap.fact_count);
    expect(sorted(inFile)).toEqual(sorted(await replay(snap.high_chain_seq)));

    // The metadata is the same moment: none of the products added during the export.
    const meta = JSON.parse(strFromU8(gunzipSync((await env.h.blobs.get(`${snap.storage_prefix}/metadata.json.gz`))!)));
    expect(meta.members.filter((m: any) => m.name.startsWith('Late '))).toEqual([]);
    expect(meta.application.metadata_rev).toBe(snap.metadata_rev);

    // An in-place restore of that snapshot brings back exactly that moment.
    expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' }));
    expect(sorted(await env.allFacts())).toEqual(sorted(inFile));

    // And a point-in-time restore to the snapshot's chain position agrees with it, slice by slice.
    const next = (await env.su.query<{ txn_id: number }>('select txn_id from epm.change_txn where app_id = $1 and chain_seq = $2', [env.appId, snap.high_chain_seq + 1])).rows[0]!.txn_id;
    expectOk(await env.admin.post(`${base}/restore`, { cube: 'Plan', scenario: 'Budget', version: 'Final', before_txn: next, into_version: 'At Snapshot', create_version: true }));
    await env.refreshIds();
    const pit = await env.facts({ scenario: 'Budget', version: 'At Snapshot' }, true);
    const finalId = String(env.id('Version', 'Final'));
    const fromSnap = new Map([...inFile].filter(([k]) => k.split(',')[2] === finalId && k.split(',')[1] === String(env.id('Scenario', 'Budget')))
      .map(([k, v]) => [k.split(',').map((x, j) => (j === 2 ? '*' : x)).join(','), v]));
    expect(pit.size).toBeGreaterThan(20_000);
    expect(sorted(pit)).toEqual(sorted(fromSnap));
  }, 40_000);
});
