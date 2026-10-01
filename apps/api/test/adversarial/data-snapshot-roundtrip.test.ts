import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Cell, type Env, expectOk, rng, setupEnv, sorted } from './data-helpers.js';

/**
 * Snapshot -> heavy changes (new and deleted members, moved parents, a new cube, a changed secured
 * flag, a new version) -> in-place restore. Mapped cells must equal the snapshot, skipped cells must be
 * reported, and data outside the restore's scope must not move.
 */
const ENT = ['East', 'West'];
const ACC = ['Revenue', 'COGS', 'Opex'];
const PER = ['Jan', 'Feb', 'Mar', 'Apr'];
const PRO = ['Widgets', 'Gadgets'];

describe('snapshot round trips over a changed application', () => {
  let env: Env;
  let base: string;
  let snap: any;
  let S0: Map<string, string>; // all facts when the snapshot was taken
  let gadgetsId: number;
  let opsCube: number;

  const key = (k: number[]) => k.join(',');
  const parts = (k: string) => k.split(',').map(Number);
  const plan = (m: Map<string, string>, pred: (k: number[]) => boolean) => new Map([...m].filter(([k]) => pred(parts(k))));

  beforeAll(async () => {
    env = await setupEnv('roundtrip');
    base = env.base;
    const r = rng(4242);
    const cells: Cell[] = [];
    for (const [sc, ve] of [['Budget', 'Working'], ['Budget', 'Final'], ['Actual', 'Working']]) {
      for (const e of ENT) for (const a of ACC) for (const p of PER) for (const pr of PRO) {
        if (r.chance(0.7)) cells.push({ k: env.coord({ Scenario: sc, Version: ve, Entity: e, Account: a, Period: p, Product: pr }), v: String(r.int(100000) / 4) });
      }
    }
    await env.write(cells);
    gadgetsId = env.id('Product', 'Gadgets');
    S0 = await env.allFacts();
    snap = expectOk(await env.admin.post(`${base}/snapshots`, { comment: 'baseline' }), 201);
    expect(snap.fact_count).toBe(S0.size);

    // a. ordinary edits: sets, clears, new cells
    const edits: Cell[] = [];
    for (const k of [...S0.keys()].slice(0, 40)) edits.push({ k: parts(k), v: r.chance(0.4) ? null : String(r.int(1000)) });
    edits.push({ k: env.coord({ Account: 'Opex', Period: 'Jun' }), v: '9' });
    await env.write(edits);
    // b. Gadgets: clear its data everywhere, then delete the member
    await env.write([...(await env.allFacts()).keys()].map(parts).filter((k) => k[8] === gadgetsId).map((k) => ({ k, v: null })));
    expectOk(await env.admin.del(`${base}/dimensions/Product/members/Gadgets`));
    // c. a new entity with data; d. a moved parent; f. a secured flag; g. a new version
    expectOk(await env.admin.put(`${base}/dimensions/Entity/members`, { members: [{ name: 'North', parent: 'Total Company' }] }));
    expectOk(await env.admin.put(`${base}/dimensions/Period/members`, { members: [{ name: 'Feb', parent: 'Q2' }] }));
    expectOk(await env.admin.put(`${base}/dimensions/Version/members`, { members: [{ name: 'V3' }] }));
    expectOk(await env.admin.patch(`${base}/dimensions/Account`, { secured: true }));
    // e. a new cube without Department and Product
    expectOk(await env.admin.post(`${base}/cubes`, { name: 'Ops', dimensions: ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account'] }), 201);
    expectOk(await env.admin.post(`${base}/deploy`));
    await env.refreshIds();
    opsCube = (await env.su.query<{ cube_id: number }>(`select cube_id from epm.cube where app_id = $1 and name = 'Ops'`, [env.appId])).rows[0]!.cube_id;
    const ops = (o: Record<string, string>) => { const k = env.coord(o); k[0] = opsCube; k[7] = 0; k[8] = 0; return k; };
    await env.write([
      { k: env.coord({ Entity: 'North', Account: 'Revenue', Period: 'Jan' }), v: '5' },
      { k: env.coord({ Entity: 'North', Account: 'COGS', Period: 'Feb' }), v: '6' },
      { k: env.coord({ Version: 'V3', Account: 'Revenue', Period: 'Jan' }), v: '7' },
      { k: env.coord({ Version: 'V3', Entity: 'West', Account: 'Opex', Period: 'Mar' }), v: '8' },
      { k: ops({ Account: 'Revenue', Period: 'Jan' }), v: '11' },
      { k: ops({ Account: 'Revenue', Period: 'Jan', Version: 'Final' }), v: '12' },
    ]);
  });
  afterAll(async () => env?.close());

  it('a snapshot taken with a scope never touches data outside it', async () => {
    const scoped = expectOk(await env.admin.post(`${base}/snapshots`, { scope: { scenarios: ['Budget'], versions: ['Final'] } }), 201);
    const now = await env.allFacts();
    // Scope wider than the snapshot is refused.
    expect((await env.admin.post(`${base}/snapshots/${scoped.snapshot_id}/restore`, { target: 'in_place', versions: ['Working'] })).status).toBe(422);
    expect((await env.admin.post(`${base}/snapshots/${scoped.snapshot_id}/restore`, { target: 'in_place', scenarios: ['Actual'] })).status).toBe(422);
    // Change Budget/Final and everything else, then restore the scoped snapshot.
    const bf = [...now.keys()].map(parts).filter((k) => k[1] === env.id('Scenario', 'Budget') && k[2] === env.id('Version', 'Final') && k[0] === env.cubeId);
    await env.write(bf.slice(0, 10).map((k) => ({ k, v: '-1' })));
    const r = expectOk(await env.admin.post(`${base}/snapshots/${scoped.snapshot_id}/restore`, { target: 'in_place' }));
    expect(r.cells_set).toBe(10);
    expect(sorted(await env.allFacts())).toEqual(sorted(now)); // Budget/Final back, nothing else moved
  });

  it('restores the snapshot scenarios and versions: mapped cells exact, deleted members skipped and reported, other cubes untouched', async () => {
    const before = await env.allFacts();
    const scope = { scenarios: ['Budget', 'Actual'], versions: ['Working', 'Final'] };
    const dry = expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', ...scope, dry_run: true }));
    const gadgetCells = [...S0.keys()].filter((k) => parts(k)[8] === gadgetsId).length;
    expect(gadgetCells).toBeGreaterThan(5);
    expect(dry.skipped).toBe(gadgetCells);
    expect(dry.skipped_reasons).toEqual([{ reason: 'Product Gadgets is no longer a deployed leaf', count: gadgetCells }]);
    expect(sorted(await env.allFacts())).toEqual(sorted(before));

    const r = expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', ...scope }));
    expect(r).toMatchObject({ cells_set: dry.cells_set, cells_cleared: dry.cells_cleared, skipped: gadgetCells });
    const after = await env.allFacts();
    const inScope = (k: number[]) => k[0] === env.cubeId && [env.id('Version', 'Working'), env.id('Version', 'Final')].includes(k[2]!);
    // In scope: exactly the snapshot, less the cells of the deleted member (and nothing for North).
    expect(sorted(plan(after, inScope))).toEqual(sorted(plan(S0, (k) => inScope(k) && k[8] !== gadgetsId)));
    // Out of scope: the Ops cube and version V3 did not move.
    expect(sorted(plan(after, (k) => !inScope(k)))).toEqual(sorted(plan(before, (k) => !inScope(k))));
    expect(plan(after, (k) => k[0] === opsCube).size).toBe(2);

    // Undo after a later edit: refused without force; forced, every restored cell goes back.
    const someKey = parts([...plan(S0, (k) => inScope(k) && k[8] !== gadgetsId).keys()][0]!);
    await env.write([{ k: someKey, v: '31337' }]);
    expect((await env.admin.post(`${base}/txns/${r.txn_id}/undo`, {})).status).toBe(409);
    expectOk(await env.admin.post(`${base}/txns/${r.txn_id}/undo`, { force: true }));
    const undone = await env.allFacts();
    expect(sorted(plan(undone, inScope))).toEqual(sorted(plan(before, inScope)));

    // The pre-restore snapshot holds exactly what the restore replaced.
    const pre = expectOk(await env.admin.get(`${base}/snapshots/${r.pre_restore_snapshot_id}`));
    expect(pre.scope).toEqual({ scenarios: expect.arrayContaining(['Budget', 'Actual']), versions: expect.arrayContaining(['Working', 'Final']) });
    expect(pre.fact_count).toBe(plan(before, (k) => inScope(k) || (k[0] === opsCube && k[2] !== env.id('Version', 'V3'))).size);
  });

  it('is idempotent: restoring twice changes nothing the second time; restore, undo, restore lands in the same place', async () => {
    const scope = { versions: ['Working'] };
    const r1 = expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', ...scope }));
    const s1 = await env.allFacts();
    const r2 = expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', ...scope }));
    expect(r2).toMatchObject({ cells_set: 0, cells_cleared: 0, txn_id: null, pre_restore_snapshot_id: null });
    expect(sorted(await env.allFacts())).toEqual(sorted(s1));
    if (r1.txn_id) expectOk(await env.admin.post(`${base}/txns/${r1.txn_id}/undo`, {}));
    expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', ...scope }));
    expect(sorted(await env.allFacts())).toEqual(sorted(s1));
  });

  it('into another version: the target gets exactly the snapshot version, the source and other versions do not move', async () => {
    await env.write([{ k: env.coord({ Version: 'Working', Account: 'Opex', Period: 'Apr', Entity: 'West' }), v: '4444' }]);
    const before = await env.allFacts();
    const r = expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, {
      target: 'in_place', scenarios: ['Budget'], versions: ['Working'], into_version: 'V3',
    }));
    expect(r.skipped).toBeGreaterThan(0);
    const after = await env.allFacts();
    const v3 = env.id('Version', 'V3');
    const budget = env.id('Scenario', 'Budget');
    const target = (k: number[]) => k[0] === env.cubeId && k[1] === budget && k[2] === v3;
    const want = new Map([...plan(S0, (k) => k[0] === env.cubeId && k[1] === budget && k[2] === env.id('Version', 'Working') && k[8] !== gadgetsId)]
      .map(([k, v]) => { const x = parts(k); x[2] = v3; return [key(x), v]; }));
    expect(sorted(plan(after, target))).toEqual(sorted(want));
    expect(sorted(plan(after, (k) => !target(k)))).toEqual(sorted(plan(before, (k) => !target(k))));
  });

  it('restoring the automatic pre-restore snapshot puts the restored scope back exactly', async () => {
    await env.write([
      { k: env.coord({ Entity: 'North', Account: 'Opex', Period: 'Apr' }), v: '-17.25' },
      { k: env.coord({ Entity: 'West', Account: 'COGS', Period: 'Jun' }), v: '0.000001' },
      { k: env.coord({ Version: 'V3', Entity: 'West', Account: 'COGS', Period: 'Jun' }), v: '3' },
    ]);
    for (const body of [{ scenarios: ['Budget'], versions: ['Working'] }, { versions: ['Working'], into_version: 'V3' }]) {
      const before = await env.allFacts();
      const r = expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', ...body }));
      expect(r.cell_count, JSON.stringify(body)).toBeGreaterThan(0);
      const back = expectOk(await env.admin.post(`${base}/snapshots/${r.pre_restore_snapshot_id}/restore`, { target: 'in_place' }));
      expect(back.skipped).toBe(0);
      expect(sorted(await env.allFacts()), JSON.stringify(body)).toEqual(sorted(before));
    }
  });

  it('FINDING: a restore without a scope leaves versions the snapshot never knew (created after it) alone, as it does new cubes', async () => {
    // V3 did not exist when the snapshot was taken; the snapshot has no opinion about its data.
    await env.write([{ k: env.coord({ Version: 'V3', Account: 'COGS', Period: 'Jan', Entity: 'East' }), v: '1' }]);
    const before = await env.allFacts();
    const v3 = env.id('Version', 'V3');
    const v3Cells = plan(before, (k) => k[2] === v3);
    expect(v3Cells.size).toBeGreaterThan(0);
    const dry = expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', dry_run: true }));
    expectOk(await env.admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place' }));
    const after = await env.allFacts();
    expect(plan(after, (k) => k[0] === opsCube).size).toBe(2); // the new cube is untouched ...
    // ... and so should the new version be (today all its cells are cleared).
    expect(dry.cells_cleared).toBeGreaterThan(0);
    expect(sorted(plan(after, (k) => k[2] === v3)), `V3 had ${v3Cells.size} cells; the dry run announced ${dry.cells_cleared} clears`)
      .toEqual(sorted(v3Cells));
  });
});
