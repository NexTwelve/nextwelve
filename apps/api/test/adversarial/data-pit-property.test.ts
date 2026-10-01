import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Cell, type Env, expectOk, rng, setupEnv, sorted } from './data-helpers.js';

/**
 * Ground truth for epm.restore_slice: a seeded random history of sets, clears, re-creates, undos and
 * forced undos (with awkward numeric values), with the exact Budget/Working slice recorded after every
 * transaction. Then every recorded point is restored (dry run, real, undo; in place, into another
 * version, with member filters) and compared cell by cell, as numeric text.
 */
const SEED = 20261001;
const VALUES = ['0', '-0.5', '0.000001', '123456789012.123456', '1', '2.5', '999999999999999999.999999', '-123.456789',
  '-999999999999999999.999999', '0.1', null, null, null] as const;
const ENTITIES = ['East', 'West'];
const ACCOUNTS = ['Revenue', 'COGS', 'Opex'];
const PERIODS = ['Jan', 'Feb', 'Apr'];
const DEPTS = ['Sales', 'Operations'];
const PRODUCTS = ['Widgets', 'Gadgets'];

interface Point { seq: number; txn: number | null; slice: Map<string, string> }

describe('point-in-time restore against a recorded random history', () => {
  let env: Env;
  let base: string;
  const points: Point[] = [];
  let headSlice: Map<string, string>;
  let headOther: Map<string, string>;
  const SLICE = { cube: 'Plan', scenario: 'Budget', version: 'Working' };

  const sliceNow = () => env.facts({ scenario: 'Budget', version: 'Working' });
  /** Every fact outside Budget/Working (and outside the Scratch version the into-version test fills). */
  const otherNow = async () => {
    const all = await env.allFacts();
    const s = await sliceNow();
    for (const k of s.keys()) all.delete(k);
    const scratch = env.ids.get('Version/Scratch');
    if (scratch !== undefined) for (const k of [...all.keys()]) if (k.split(',')[2] === String(scratch)) all.delete(k);
    return all;
  };
  /** body of a restore to recorded point i */
  const to = (i: number): Record<string, unknown> =>
    i + 1 < points.length ? { before_txn: points[i + 1]!.txn } : { at: '2999-01-01T00:00:00Z' };

  function diffCounts(from: Map<string, string>, target: Map<string, string>, only?: (k: string) => boolean) {
    let set = 0;
    let cleared = 0;
    for (const k of new Set([...from.keys(), ...target.keys()])) {
      if (only && !only(k)) continue;
      const a = from.get(k);
      const b = target.get(k);
      if (b === undefined && a !== undefined) cleared++;
      else if (b !== undefined && a !== b) set++;
    }
    return { set, cleared };
  }

  beforeAll(async () => {
    env = await setupEnv('pitprop');
    base = env.base;
    const r = rng(SEED);
    const inSlice: number[][] = [];
    for (const e of ENTITIES) for (const a of ACCOUNTS) for (const p of PERIODS) for (const d of DEPTS) for (const pr of PRODUCTS) {
      inSlice.push(env.coord({ Entity: e, Account: a, Period: p, Department: d, Product: pr }));
    }
    const outside = [
      ...inSlice.slice(0, 20).map((k) => { const x = [...k]; x[2] = env.id('Version', 'Final'); return x; }),
      ...inSlice.slice(30, 50).map((k) => { const x = [...k]; x[1] = env.id('Scenario', 'Actual'); return x; }),
    ];
    points.push({ seq: await env.head(), txn: null, slice: await sliceNow() });
    expect(points[0]!.seq).toBe(0);

    const txns: number[] = [];
    const kinds = { set: 0, undo: 0, forced: 0, noop: 0 };
    for (let n = 0; n < 28; n++) {
      let res: { txn_id: number | null; chain_seq: number | null };
      const roll = r.next();
      if (roll < 0.2 && txns.length > 2) {
        const victim = r.pick(txns);
        try {
          res = await env.undo(victim, false);
          kinds.undo++;
        } catch (err: any) {
          if (err.code !== 'NX409') throw err;
          res = await env.undo(victim, true); // forced undo over later changes
          kinds.forced++;
        }
      } else {
        const want = roll > 0.9 ? 10 + r.int(10) : 1 + r.int(6);
        const chosen = new Map<string, Cell>();
        for (let i = 0; i < want; i++) {
          const k = r.pick(inSlice);
          chosen.set(k.join(','), { k, v: r.pick(VALUES) });
        }
        for (let i = r.int(3); i > 0; i--) {
          const k = r.pick(outside);
          chosen.set(k.join(','), { k, v: r.pick(VALUES) });
        }
        res = await env.write([...chosen.values()]);
        kinds.set++;
      }
      if (res.txn_id === null) { kinds.noop++; continue; } // nothing changed: no new chain position
      txns.push(res.txn_id);
      points.push({ seq: res.chain_seq!, txn: res.txn_id, slice: await sliceNow() });
    }
    // Consecutive chain positions, one per recorded transaction.
    points.forEach((p, i) => expect(p.seq).toBe(i));
    headSlice = points[points.length - 1]!.slice;
    headOther = await otherNow();
    expect(points.length).toBeGreaterThan(20);
    expect(kinds.undo + kinds.forced, JSON.stringify(kinds)).toBeGreaterThanOrEqual(3);
    expect(kinds.forced, JSON.stringify(kinds)).toBeGreaterThanOrEqual(1);
    // The history is not trivial: some points differ a lot from the head.
    expect(Math.max(...points.map((p) => diffCounts(headSlice, p.slice).set + diffCounts(headSlice, p.slice).cleared))).toBeGreaterThan(10);
  }, 30_000);
  afterAll(async () => env?.close());

  it('dry runs report exactly the cells that differ from every recorded point, and change nothing', async () => {
    for (let i = 0; i < points.length; i++) {
      const r = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(i), dry_run: true }));
      const d = diffCounts(headSlice, points[i]!.slice);
      expect({ i, set: r.cells_set, cleared: r.cells_cleared, skipped: r.skipped, seq: r.as_of.chain_seq })
        .toEqual({ i, set: d.set, cleared: d.cleared, skipped: 0, seq: points[i]!.seq });
    }
    expect(sorted(await sliceNow())).toEqual(sorted(headSlice));
  });

  it('restores in place to every recorded point exactly, touches nothing else, and undoes cleanly', async () => {
    for (let i = 0; i < points.length; i++) {
      const r = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(i) }));
      expect(sorted(await sliceNow()), `point ${i} (seq ${points[i]!.seq})`).toEqual(sorted(points[i]!.slice));
      expect(sorted(await otherNow()), `other slices after restoring point ${i}`).toEqual(sorted(headOther));
      if (r.txn_id !== null) {
        expectOk(await env.admin.post(`${base}/txns/${r.txn_id}/undo`, {}));
      } else {
        expect(diffCounts(headSlice, points[i]!.slice)).toEqual({ set: 0, cleared: 0 });
      }
      expect(sorted(await sliceNow()), `after undoing the restore of point ${i}`).toEqual(sorted(headSlice));
    }
  });

  it('restores every recorded point into another version exactly, leaving the source alone', async () => {
    let created = false;
    const anyVersion = (m: Map<string, string>) => new Map([...m].map(([k, v]) => [k.split(',').map((x, j) => (j === 2 ? '*' : x)).join(','), v]));
    // Newest first, then a shuffled order, so the target always holds some other point's cells.
    const order = [...points.keys()].reverse();
    const r = rng(SEED + 2);
    for (let n = 0; n < 10; n++) order.push(r.int(points.length));
    for (const i of order) {
      const target = created ? await env.facts({ scenario: 'Budget', version: 'Scratch' }, true) : new Map<string, string>();
      const want = anyVersion(points[i]!.slice);
      const dry = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(i), into_version: 'Scratch', create_version: true, dry_run: true }));
      const d = diffCounts(target, want);
      expect({ i, set: dry.cells_set, cleared: dry.cells_cleared }).toEqual({ i, set: d.set, cleared: d.cleared });
      expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(i), into_version: 'Scratch', create_version: true }));
      if (!created) { await env.refreshIds(); created = true; }
      const got = await env.facts({ scenario: 'Budget', version: 'Scratch' }, true);
      expect(sorted(got), `point ${i} into Scratch`).toEqual(sorted(want));
      expect(sorted(await sliceNow())).toEqual(sorted(headSlice));
    }
  });

  it('member filters (leaf, parent and function expressions) restore only the matching cells', async () => {
    const r = rng(SEED + 1);
    const FILTERS: { body: Record<string, string[]>; match: Record<number, string[]> }[] = [
      { body: { Entity: ['East'] }, match: { 5: ['Entity/East'] } },
      { body: { Account: ['Gross Margin'], Period: ['Q1'] }, match: { 6: ['Account/Revenue', 'Account/COGS'], 4: ['Period/Jan', 'Period/Feb', 'Period/Mar'] } },
      { body: { Product: ['Gadgets'], Department: ['Operations'] }, match: { 8: ['Product/Gadgets'], 7: ['Department/Operations'] } },
      { body: { Entity: ['Total Company'], Account: ['Opex', 'Revenue'], Period: ['@leaves(Q2)'] },
        match: { 5: ['Entity/East', 'Entity/West'], 6: ['Account/Opex', 'Account/Revenue'], 4: ['Period/Apr', 'Period/May', 'Period/Jun'] } },
      { body: { Years: ['FY27'], Period: ['Feb', 'Apr'] }, match: { 4: ['Period/Feb', 'Period/Apr'] } },
    ];
    for (let n = 0; n < 12; n++) {
      const i = r.int(points.length);
      const f = r.pick(FILTERS);
      const allowed = Object.entries(f.match).map(([pos, names]) => [Number(pos), new Set(names.map((x) => { const [d, m] = x.split('/'); return env.id(d!, m!); }))] as const);
      const matches = (key: string) => { const k = key.split(',').map(Number); return allowed.every(([pos, set]) => set.has(k[pos]!)); };
      const want = new Map<string, string>();
      for (const k of new Set([...headSlice.keys(), ...points[i]!.slice.keys()])) {
        const v = matches(k) ? points[i]!.slice.get(k) : headSlice.get(k);
        if (v !== undefined) want.set(k, v);
      }
      const d = diffCounts(headSlice, points[i]!.slice, matches);
      const dry = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(i), filters: f.body, dry_run: true }));
      expect({ n, i, set: dry.cells_set, cleared: dry.cells_cleared }).toEqual({ n, i, set: d.set, cleared: d.cleared });
      const res = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(i), filters: f.body }));
      expect(sorted(await sliceNow()), `filter ${JSON.stringify(f.body)} to point ${i}`).toEqual(sorted(want));
      if (res.txn_id !== null) expectOk(await env.admin.post(`${base}/txns/${res.txn_id}/undo`, {}));
      expect(sorted(await sliceNow())).toEqual(sorted(headSlice));
    }
  });

  it('chain positions after restores still reproduce exactly (restore of restores), and repeating a restore is a no-op', async () => {
    const a = 5;
    const b = 2;
    const ra = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(a) }));
    expect(sorted(await sliceNow())).toEqual(sorted(points[a]!.slice));
    const again = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(a) }));
    expect(again).toMatchObject({ cells_set: 0, cells_cleared: 0, txn_id: null });
    const rb = expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, ...to(b) }));
    expect(sorted(await sliceNow())).toEqual(sorted(points[b]!.slice));
    // Just before the second restore = the state the first restore produced.
    expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, before_txn: rb.txn_id }));
    expect(sorted(await sliceNow())).toEqual(sorted(points[a]!.slice));
    // Just before the first restore = the original head.
    expectOk(await env.admin.post(`${base}/restore`, { ...SLICE, before_txn: ra.txn_id }));
    expect(sorted(await sliceNow())).toEqual(sorted(headSlice));
    expect(sorted(await otherNow())).toEqual(sorted(headOther));
  });
});
