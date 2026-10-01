import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byDim, expectOk, type MetaApp, type MetaEnv, setupMeta } from './meta-helpers.js';

const POV = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' };
const form = (months: string[]) => ({ cube: 'Plan', definition: { pov: POV, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: months } } });
const report = { cube: 'Plan', definition: { pov: { ...POV }, rows: [{ dimension: 'Account', members: ['Revenue'] }], columns: { dimension: 'Period', members: ['Q1'] } } };

/**
 * A preview runs the whole restore in a savepoint and rolls it back: it must leave no trace at all
 * (rows, metadata_rev, security events, storage), however much it exercises: members recreated,
 * kept and removed, parents cleared of data, definitions created, updated and removed, data
 * restored. Then the real run: the audit trail it leaves, kept cells, and the snapshot data path.
 */
describe('adversarial: metadata restore previews and data', () => {
  let env: MetaEnv;
  let a: MetaApp;
  let t: string;

  /** Every table in epm (partitions through their parent): row count and a digest of the rows. */
  async function fingerprint(): Promise<Record<string, string>> {
    const tables = (await env.su.query<{ t: string }>(
      `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'epm' and c.relkind in ('r', 'p') and not c.relispartition order by 1`,
    )).rows.map((r) => r.t);
    const out: Record<string, string> = {};
    for (const tb of tables) {
      const r = await env.su.query<{ f: string }>(`select count(*) || ':' || coalesce(md5(string_agg(x::text, '|' order by x::text)), '') as f from epm.${tb} x`);
      out[tb] = r.rows[0]!.f;
    }
    return out;
  }

  beforeAll(async () => {
    env = await setupMeta('mprev');
    a = await env.newApp('Preview');
    await a.write([{ at: { Product: 'Widgets', Period: 'Jan' }, v: 100 }, { at: { Product: 'Gadgets', Period: 'Feb' }, v: 50 }]);
    expectOk(await env.admin.put(`${a.base}/forms/F1`, form(['Jan'])));
    expectOk(await env.admin.put(`${a.base}/reports/R1`, report));
    await env.pause();
    t = await env.now();
    await env.pause();

    // After t: every kind of change the restore undoes.
    await a.write([{ at: { Product: 'Gadgets', Period: 'Feb' }, v: null }, { at: { Product: 'Widgets', Period: 'Jan' }, v: 101 }]);
    await a.del('Product', 'Gadgets');
    await a.put('Product', [{ name: 'Gizmos', parent: 'All Products' }, { name: 'Junk', parent: 'All Products' }]);
    for (const m of ['Apr', 'May', 'Jun']) await a.del('Period', m);
    await a.deploy();
    await a.write([{ at: { Product: 'Gizmos', Period: 'Jan' }, v: 7 }, { at: { Product: 'Widgets', Period: 'Q2' }, v: 500 }]);
    expectOk(await env.admin.put(`${a.base}/forms/F1`, form(['Jan', 'Feb'])));
    expectOk(await env.admin.put(`${a.base}/forms/F2`, form(['Feb'])));
    expectOk(await env.admin.del(`${a.base}/reports/R1`));
  }, 30_000);
  afterAll(async () => env?.close());

  it('a preview that exercises every path leaves no trace: no rows, no metadata_rev, no security event, no stored file', async () => {
    const before = await fingerprint();
    const keys = env.h.store.keys().length;
    const rev = await a.metadataRev();

    const p = expectOk(await a.restore({ at: t, data: true, remove_new_definitions: true, dry_run: true }));
    expect(p.dry_run).toBe(true);
    expect(byDim(p).Product).toMatchObject({ recreated: ['Gadgets'], removed: ['Junk'], kept: [{ name: 'Gizmos', cells: 1 }] });
    expect(byDim(p).Period.recreated).toEqual(['Apr', 'May', 'Jun']);
    expect(p.data).toMatchObject({ parents_cleared: 1, cells_set: 2, over_limit: false });
    expect(p.data.kept).toBeGreaterThan(0);
    expect(p.definitions).toMatchObject({ created: [{ type: 'report', name: 'R1' }], updated: [{ type: 'form', name: 'F1' }], removed: [{ type: 'form', name: 'F2' }] });
    expect(p.members.deployed).toBe(true);

    expect(await fingerprint()).toEqual(before);
    expect(env.h.store.keys().length).toBe(keys);
    expect(await a.metadataRev()).toBe(rev);
  });

  it('the real run: one pre_restore snapshot, restore transactions on the hash chain, one security event naming them, kept cells untouched', async () => {
    const head = (await env.su.query<{ s: number }>('select coalesce(max(chain_seq), 0)::int as s from epm.change_txn where app_id = $1', [a.appId])).rows[0]!.s;
    const r = expectOk(await a.restore({ at: t, data: true, remove_new_definitions: true }));
    expect(r.data.txn_ids.length).toBeGreaterThan(0);

    const txns = (await env.su.query<{ txn_id: number; source: string; comment: string }>(
      'select txn_id::int, source, comment from epm.change_txn where app_id = $1 and chain_seq > $2 order by chain_seq', [a.appId, head],
    )).rows;
    expect(txns.every((x) => x.source === 'restore')).toBe(true);
    expect(txns.length).toBe(r.data.txn_ids.length + 1); // plus the one clearing Q2
    expect(txns.map((x) => x.txn_id)).toEqual(expect.arrayContaining(r.data.txn_ids));
    expect(expectOk(await env.admin.post(`${a.base}/audit/verify`))).toMatchObject({ ok: true });

    const ev = (await env.su.query<{ detail: any }>(`select detail from epm.security_event where app_id = $1 and event_type = 'metadata_restored'`, [a.appId])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail.data.txn_ids).toEqual(r.data.txn_ids);
    const snap = expectOk(await env.admin.get(`${a.base}/snapshots/${r.pre_restore_snapshot_id}`));
    expect(snap).toMatchObject({ kind: 'pre_restore', status: 'complete' });

    expect(await a.value({ Product: 'Widgets', Period: 'Jan' })).toBe('100.000000');
    expect(await a.value({ Product: 'Gadgets', Period: 'Feb' })).toBe('50.000000');
    expect(await a.value({ Product: 'Gizmos', Period: 'Jan' })).toBe('7.000000');
    expect(await a.rollup('All Products', 'Q2')).toBeNull();
    expect(await a.orphanFacts()).toBe(0);
    expect(await a.closureMismatch()).toBe(0);
  });

  it('from a snapshot with data: kept members keep their cells, parents are cleared, the rest comes back', async () => {
    const b = await env.newApp('Preview Snap');
    await b.write([{ at: { Product: 'Widgets', Period: 'Jan' }, v: 1 }, { at: { Product: 'Gadgets', Period: 'Apr' }, v: 2 }]);
    const snap = expectOk(await env.admin.post(`${b.base}/snapshots`, {}), 201);
    await b.write([{ at: { Product: 'Gadgets', Period: 'Apr' }, v: null }, { at: { Product: 'Widgets', Period: 'Jan' }, v: 9 }]);
    for (const m of ['Apr', 'May', 'Jun']) await b.del('Period', m);
    await b.put('Product', [{ name: 'Gizmos', parent: 'All Products' }]);
    await b.deploy();
    await b.write([{ at: { Product: 'Gizmos', Period: 'Jan' }, v: 3 }, { at: { Product: 'Widgets', Period: 'Q2' }, v: 4 }]);

    const before = await fingerprint();
    const p = expectOk(await b.restore({ snapshot_id: snap.snapshot_id, data: true, dry_run: true }));
    expect(p.data).toMatchObject({ parents_cleared: 1, kept: 1, over_limit: false });
    expect(await fingerprint()).toEqual(before);

    const r = expectOk(await b.restore({ snapshot_id: snap.snapshot_id, data: true }));
    expect(byDim(r).Period.recreated).toEqual(['Apr', 'May', 'Jun']);
    expect(await b.value({ Product: 'Widgets', Period: 'Jan' })).toBe('1.000000');
    expect(await b.value({ Product: 'Gadgets', Period: 'Apr' })).toBe('2.000000');
    expect(await b.value({ Product: 'Gizmos', Period: 'Jan' })).toBe('3.000000');
    expect(await b.rollup('Widgets', 'Q2')).toBeNull();
    expect(await b.orphanFacts()).toBe(0);
  });
});
