import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { byDim, expectOk, type MetaEnv, setupMeta, shape } from './meta-helpers.js';

/**
 * Metadata restore to a point in time: is the tree that comes back the tree that was deployed then?
 * Chains of deleted parents, moves, sort order, aggregation, name swaps and clashes, cycles saved
 * since, members kept because they hold data (and their saved-but-undeployed edits), plan windows
 * and grants on members added since, and which saved-but-undeployed edits a restore publishes.
 */
describe('adversarial: the tree a metadata restore brings back', () => {
  let env: MetaEnv;

  beforeAll(async () => {
    env = await setupMeta('mtree');
  });
  afterAll(async () => env?.close());

  const mark = async () => {
    await env.pause();
    const t = await env.now();
    await env.pause();
    return t;
  };

  it('brings back a chain of deleted parents under their original ids, undoes a move, sort order and aggregation, and rolls up as before', async () => {
    const a = await env.newApp('Tree Chain');
    await a.put('Product', [
      { name: 'Hardware', parent: 'All Products', sort_order: 30 },
      { name: 'Tools', parent: 'Hardware' },
      { name: 'Drills', parent: 'Tools' },
      { name: 'Saws', parent: 'Tools', agg_op: '-' },
    ]);
    await a.deploy();
    await a.write([{ at: { Product: 'Drills' }, v: 5 }, { at: { Product: 'Saws' }, v: 7 }, { at: { Product: 'Widgets' }, v: 1 }]);
    const before = await a.tree('Product');
    expect(await a.rollup('All Products')).toBe(-1); // 1 + (5 - 7)
    const t = await mark();

    // After t: the chain's data cleared and the chain deleted bottom-up; Widgets moved under Gadgets
    // with '-' aggregation; Gadgets reordered.
    await a.write([{ at: { Product: 'Drills' }, v: null }, { at: { Product: 'Saws' }, v: null }]);
    for (const n of ['Drills', 'Saws', 'Tools', 'Hardware']) await a.del('Product', n);
    await a.put('Product', [{ name: 'Widgets', parent: 'Gadgets', agg_op: '-' }, { name: 'Gadgets', sort_order: 5 }]);
    await a.deploy();

    const r = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false, data: true }));
    expect([...byDim(r).Product.recreated].sort()).toEqual(['Drills', 'Hardware', 'Saws', 'Tools']);
    const after = await a.tree('Product');
    expect(shape(after)).toEqual(shape(before));
    expect(after.every((m) => m.deployed)).toBe(true);
    expect(await a.closureMismatch()).toBe(0);
    expect(await a.value({ Product: 'Drills' })).toBe('5.000000');
    expect(await a.rollup('Tools')).toBe(-2);
    expect(await a.rollup('All Products')).toBe(-1);
    expect(await a.orphanFacts()).toBe(0);
  });

  it('keeps a new member with data together with the new parents it hangs under, and removes the unused new members', async () => {
    const a = await env.newApp('Tree Kept');
    const t = await mark();
    await a.put('Product', [
      { name: 'Sets', parent: 'All Products' }, { name: 'Sets East', parent: 'Sets' }, { name: 'Sets East A', parent: 'Sets East' },
      { name: 'Empty', parent: 'Sets East' }, { name: 'Gadgets', parent: 'Sets' },
    ]);
    await a.deploy();
    await a.write([{ at: { Product: 'Sets East A' }, v: 9 }, { at: { Product: 'Gadgets' }, v: 4 }]);

    const r = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false }));
    const p = byDim(r).Product;
    expect(p.removed).toEqual(['Empty']);
    expect(p.kept.map((k: { name: string }) => k.name).sort()).toEqual(['Sets', 'Sets East', 'Sets East A']);
    expect(await a.member('Product', 'Gadgets')).toMatchObject({ parent: 'All Products', deployed: true });
    expect(await a.member('Product', 'Sets East A')).toMatchObject({ parent: 'Sets East', deployed: true, is_leaf: true });
    expect(await a.member('Product', 'Sets')).toMatchObject({ parent: 'All Products', deployed: true });
    expect(await a.value({ Product: 'Sets East A' })).toBe('9.000000');
    expect(await a.rollup('All Products')).toBe(13);
    expect(await a.closureMismatch()).toBe(0);
    expect(await a.orphanFacts()).toBe(0);
  });

  it('a member deleted since whose name a kept member now holds (in another case) stays gone; its old child comes back under the nearest ancestor', async () => {
    const a = await env.newApp('Tree Clash');
    await a.put('Product', [{ name: 'Promo', parent: 'All Products' }, { name: 'Promo A', parent: 'Promo' }]);
    await a.deploy();
    const oldPromo = (await a.member('Product', 'Promo'))!.member_id;
    const promoA = (await a.member('Product', 'Promo A'))!.member_id;
    const t = await mark();
    await a.del('Product', 'Promo A');
    await a.del('Product', 'Promo');
    await a.put('Product', [{ name: 'promo', parent: 'All Products' }]);
    await a.deploy();
    await a.write([{ at: { Product: 'promo' }, v: 3 }]);

    const r = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false }));
    const p = byDim(r).Product;
    expect(p.recreated).toEqual(['Promo A']);
    expect(p.kept).toEqual([{ name: 'promo', cells: 1 }]);
    expect(p.conflicts.join(' ')).toMatch(/Promo was not brought back/);
    const rows = await a.tree('Product');
    expect(rows.find((m) => m.member_id === oldPromo)).toBeUndefined();
    expect(rows.find((m) => m.member_id === promoA)).toMatchObject({ parent: 'All Products', deployed: true });
    expect(await a.value({ Product: 'promo' })).toBe('3.000000');
    expect(await a.closureMismatch()).toBe(0);
  });

  it('swapped names (A <-> B) are swapped back; data follows the member ids', async () => {
    const a = await env.newApp('Tree Swap');
    await a.put('Product', [{ name: 'Alpha', parent: 'All Products' }, { name: 'Beta', parent: 'All Products' }]);
    await a.deploy();
    await a.write([{ at: { Product: 'Alpha' }, v: 10 }, { at: { Product: 'Beta' }, v: 20 }]);
    const alpha = (await a.member('Product', 'Alpha'))!.member_id;
    const beta = (await a.member('Product', 'Beta'))!.member_id;
    const t = await mark();
    // There is no rename in the API yet; the restore is built to undo renames, so make them directly.
    await env.su.query(`update epm.member set name = 'tmp-swap' where member_id = $1`, [alpha]);
    await env.su.query(`update epm.member set name = 'Alpha' where member_id = $1`, [beta]);
    await env.su.query(`update epm.member set name = 'Beta' where member_id = $1`, [alpha]);
    await a.deploy();
    expect(await a.value({ Product: 'Alpha' })).toBe('20.000000');

    const r = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false }));
    expect(byDim(r).Product.changed).toEqual(expect.arrayContaining([
      { name: 'Alpha', was: 'Beta', fields: ['name'] }, { name: 'Beta', was: 'Alpha', fields: ['name'] },
    ]));
    expect((await a.member('Product', 'Alpha'))!.member_id).toBe(alpha);
    expect(await a.value({ Product: 'Alpha' })).toBe('10.000000');
    expect(await a.rollup('Beta')).toBe(20);
  });

  it('a cycle saved after the restore point (never deployable) is discarded, and the deploy succeeds', async () => {
    const a = await env.newApp('Tree Cycle');
    const before = await a.tree('Product');
    const t = await mark();
    await a.del('Product', 'Gadgets');
    await a.deploy();
    await a.put('Product', [{ name: 'All Products', parent: 'Widgets' }]);
    expect((await env.admin.post(`${a.base}/deploy`)).status).toBe(422);

    const r = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false }));
    expect(r.members.deployed).toBe(true);
    const after = await a.tree('Product');
    expect(shape(after).map(({ id: _id, ...x }) => x)).toEqual(shape(before).map(({ id: _id, ...x }) => x));
    expect(await a.closureMismatch()).toBe(0);
  });

  it('keeps a new version a plan window uses; removes a new member that only has access grants (and its grants)', async () => {
    const a = await env.newApp('Tree Windows');
    const t = await mark();
    await a.put('Version', [{ name: 'V2' }]);
    await a.put('Entity', [{ name: 'South', parent: 'Total Company' }]);
    await a.deploy();
    expectOk(await env.admin.put(`${a.base}/plan-windows`, { scenario: 'Budget', version: 'V2', years: 'FY27', locked: true }));
    expectOk(await env.admin.put(`${a.base}/grants`, {
      grants: [{ principal: { user: env.email }, dimension: 'Entity', member: 'South', scope: 'member', access: 'write' }],
    }));

    const r = expectOk(await a.restore({ at: t, definitions: false }));
    expect(byDim(r).Version.kept).toEqual([{ name: 'V2', cells: 0 }]);
    expect(byDim(r).Entity.removed).toEqual(['South']);
    expect(await a.member('Version', 'V2')).toMatchObject({ deployed: true });
    expect(await a.member('Entity', 'South')).toBeUndefined();
    expect(expectOk(await env.admin.get(`${a.base}/grants`)).grants).toEqual([]);
  });

  it('a pre_restore snapshot undoes a metadata-only restore: the same tree under the same ids', async () => {
    const a = await env.newApp('Tree Undo');
    const t = await mark();
    await a.del('Product', 'Gadgets');
    await a.put('Product', [{ name: 'Gizmos', parent: 'All Products', sort_order: 1 }, { name: 'Widgets', alias: 'W' }]);
    await a.deploy();
    const mid = await a.tree('Product');

    const r = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false }));
    expect(r.pre_restore_snapshot_id).toBeTruthy();
    const back = expectOk(await a.restore({ snapshot_id: r.pre_restore_snapshot_id, dimensions: ['Product'], definitions: false }));
    expect(byDim(back).Product.recreated).toEqual(['Gizmos']);
    expect(shape(await a.tree('Product'))).toEqual(shape(mid));
    expect(await a.closureMismatch()).toBe(0);
  });

  it('a leaf that became a parent since gets its data back with data: true once its new children go; a kept child keeps it a parent (cells reported skipped)', async () => {
    const a = await env.newApp('Tree Leaf Again');
    await a.write([{ at: { Department: 'Sales' }, v: 100 }, { at: { Department: 'Operations' }, v: 50 }]);
    const t = await mark();
    await a.write([{ at: { Department: 'Sales' }, v: null }, { at: { Department: 'Operations' }, v: null }]);
    await a.put('Department', [{ name: 'Sales East', parent: 'Sales' }, { name: 'Ops East', parent: 'Operations' }]);
    await a.deploy();
    await a.write([{ at: { Department: 'Ops East' }, v: 5 }]);

    const r = expectOk(await a.restore({ at: t, dimensions: ['Department'], definitions: false, data: true }));
    expect(byDim(r).Department).toMatchObject({ removed: ['Sales East'], kept: [{ name: 'Ops East', cells: 1 }] });
    expect(await a.member('Department', 'Sales')).toMatchObject({ is_leaf: true, deployed: true });
    expect(await a.value({ Department: 'Sales' })).toBe('100.000000');
    expect(await a.member('Department', 'Operations')).toMatchObject({ is_leaf: false });
    expect(await a.value({ Department: 'Operations' })).toBeNull();
    expect(r.data.skipped).toBe(1);
    expect(await a.value({ Department: 'Ops East' })).toBe('5.000000');
    expect(await a.orphanFacts()).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Findings
  // ---------------------------------------------------------------------------------------------

  it("FINDING: a kept member's saved-but-undeployed move is applied (not discarded), so the restore refuses with a false 'had children at the restore point'", async () => {
    const a = await env.newApp('Tree Kept Pending');
    await a.write([{ at: { Department: 'Sales' }, v: 100 }]);
    const t = await mark();
    await a.put('Department', [{ name: 'Marketing', parent: 'All Departments' }]);
    await a.deploy();
    await a.write([{ at: { Department: 'Marketing' }, v: 7 }]);
    // Saved, not deployed: Marketing under Sales (a leaf with data, so this could never be deployed as is).
    await a.put('Department', [{ name: 'Marketing', parent: 'Sales' }]);

    // In-scope saved edits are discarded: Marketing stays where it is deployed, Sales stays a leaf with its data.
    const r = await a.restore({ at: t, dimensions: ['Department'], definitions: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await a.member('Department', 'Marketing')).toMatchObject({ parent: 'All Departments', deployed: true });
    expect(await a.member('Department', 'Sales')).toMatchObject({ is_leaf: true });
    expect(await a.value({ Department: 'Sales' })).toBe('100.000000');
  });

  it("FINDING: with data: true the same restore wipes the data of a member that was a leaf with data at the restore point, and deploys a hierarchy that never existed", async () => {
    const a = await env.newApp('Tree Kept Pending Data');
    await a.write([{ at: { Department: 'Sales' }, v: 100 }]);
    const t = await mark();
    await a.put('Department', [{ name: 'Marketing', parent: 'All Departments' }]);
    await a.deploy();
    await a.write([{ at: { Department: 'Marketing' }, v: 7 }]);
    await a.put('Department', [{ name: 'Marketing', parent: 'Sales' }]);

    const r = expectOk(await a.restore({ at: t, dimensions: ['Department'], definitions: false, data: true }));
    // Sales was a leaf holding 100 at t, and nothing changed it since: it must still hold 100.
    expect(await a.value({ Department: 'Sales' })).toBe('100.000000');
    expect(r.data.parents_cleared).toBe(0);
    expect(await a.member('Department', 'Marketing')).toMatchObject({ parent: 'All Departments' });
  });

  it('FINDING: when only saved-but-undeployed edits differ from the restore point, the restore reports them removed/discarded but changes nothing', async () => {
    const a = await env.newApp('Tree Pending Only');
    const t = await mark();
    await a.put('Product', [{ name: 'Gizmos', parent: 'All Products' }, { name: 'Widgets', alias: 'Wdg' }]);

    const preview = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false, dry_run: true }));
    expect(byDim(preview).Product).toMatchObject({ removed: ['Gizmos'], pending_discarded: 2 });
    const done = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false }));
    expect(done.dry_run).toBe(false);
    expect(byDim(done).Product.removed).toEqual(['Gizmos']);
    // What the response says was done must have been done.
    expect(await a.member('Product', 'Gizmos')).toBeUndefined();
    expect((await a.member('Product', 'Widgets'))!.alias).toBeNull();
  });

  it('FINDING: a dimension with nothing deployed at the restore point is reported "left as it is", yet its saved-but-undeployed members are deployed by the restore', async () => {
    const a = await env.newApp('Tree New Dim');
    const t = await mark();
    expectOk(await env.admin.post(`${a.base}/dimensions`, { name: 'Region', type: 'custom' }), 201);
    await a.put('Region', [{ name: 'All Regions' }, { name: 'North', parent: 'All Regions' }]);

    const r = await a.restore({ at: t, definitions: false });
    if (r.status === 200) {
      expect(byDim(r.body).Region.note).toMatch(/left as it is/);
      // Left as it is: work in progress nobody deployed must not be published by a restore.
      expect((await a.tree('Region')).some((m) => m.deployed)).toBe(false);
    } else {
      // Or refused, as for undeployed edits outside the restore's scope.
      expect(r.status).toBe(409);
    }
  });

  it('FINDING: naming a dimension twice (in another case) makes the restore fail with a duplicate-key 409', async () => {
    const a = await env.newApp('Tree Dup Dim');
    const t = await mark();
    await a.del('Product', 'Gadgets');
    await a.deploy();

    const r = await a.restore({ at: t, dimensions: ['Product', 'product'], definitions: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await a.member('Product', 'Gadgets')).toMatchObject({ deployed: true });
  });

  it('FINDING: a member renamed since onto the name of a member that comes back, while a kept member holds its old name, breaks the restore (unique violation)', async () => {
    const a = await env.newApp('Tree Rename Clash');
    await a.put('Product', [{ name: 'Alpha', parent: 'All Products' }, { name: 'Beta', parent: 'All Products' }]);
    await a.deploy();
    const alpha = (await a.member('Product', 'Alpha'))!.member_id;
    const t = await mark();
    await a.del('Product', 'Beta');
    await env.su.query(`update epm.member set name = 'Beta' where member_id = $1`, [alpha]); // a rename (no API for it yet)
    await a.put('Product', [{ name: 'Alpha', parent: 'All Products' }]);
    await a.deploy();
    await a.write([{ at: { Product: 'Alpha' }, v: 1 }]);

    // Old Alpha keeps "Beta" (its old name is held by the kept new Alpha), so old Beta cannot come back as "Beta":
    // it should be reported as a conflict, not crash the whole restore.
    const r = await a.restore({ at: t, dimensions: ['Product'], definitions: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await a.value({ Product: 'Alpha' })).toBe('1.000000');
    expect((await a.tree('Product')).find((m) => m.member_id === alpha)).toMatchObject({ deployed: true });
    expect(await a.closureMismatch()).toBe(0);
  });
});
