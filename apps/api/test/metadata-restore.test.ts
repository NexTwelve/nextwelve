import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, provisionTenant, seedPlanApp, signIn, superQuery } from './helpers.js';

const POV = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Product: 'Widgets' };

describe('metadata restore to a point in time and from a snapshot', () => {
  let h: Harness;
  let admin: Api;
  let base: string;
  let appId: string;

  const now = async () => (await superQuery(h, `select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`))[0].t as string;
  const pause = () => new Promise((r) => setTimeout(r, 5));
  const members = async (dim: string) =>
    (expectOk(await admin.get(`${base}/dimensions/${dim}/members`)).members as { name: string; parent: string | null; alias: string | null }[]);
  const memberRow = async (dim: string, name: string) =>
    (await superQuery(h, `select m.member_id, m.name, p.name as parent, m.alias, m.tree_ordinal is not null as deployed
                            from epm.member m join epm.dimension d on d.dim_id = m.dim_id left join epm.member p on p.member_id = m.parent_id
                           where d.app_id = $1 and d.name = $2 and m.name = $3`, [appId, dim, name]))[0];
  const write = async (pov: Record<string, string>, rows: string[], cols: string[], values: (number | null)[][]) => {
    const g = expectOk(await admin.post(`${base}/grid/read`, { cube: 'Plan', pov, rows: { dimension: 'Account', members: rows }, columns: { dimension: 'Period', members: cols } }));
    return expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values }));
  };
  const read = async (pov: Record<string, string>, rows: string[], cols: string[]) =>
    expectOk(await admin.post(`${base}/grid/read`, { cube: 'Plan', pov, rows: { dimension: 'Account', members: rows }, columns: { dimension: 'Period', members: cols } })).values;
  const restore = (body: Record<string, unknown>) => admin.post(`${base}/metadata/restore`, body);

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Meta', null, 'admin@meta.test');
    admin = await signIn(h, 'admin@meta.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    await write({ ...POV, Department: 'Sales' }, ['Revenue', 'COGS', 'Opex'], ['Jan', 'Feb'], [[100, 110], [40, 44], [20, 22]]);
    expectOk(await admin.put(`${base}/forms/Opex Entry`, {
      cube: 'Plan',
      definition: { pov: { ...POV, Department: 'Sales' }, rows: { dimension: 'Account', members: ['Opex'] }, columns: { dimension: 'Period', members: ['Jan', 'Feb'] } },
    }));
    expectOk(await admin.put(`${base}/reports/Margin`, {
      cube: 'Plan',
      definition: { pov: { ...POV }, rows: [{ dimension: 'Department', members: ['@ichildren(All Departments)'] }, { dimension: 'Account', members: ['Revenue'] }], columns: { dimension: 'Period', members: ['Q1'] } },
    }));
  });
  afterAll(async () => h?.close());

  it('refuses times outside the history and needs app_admin', async () => {
    expect((await restore({ at: '2001-01-01T00:00:00Z' })).body.message).toMatch(/history for this application starts/);
    expect((await restore({ at: '2999-01-01T00:00:00Z' })).body.message).toMatch(/future/);
    expect((await restore({})).status).toBe(422);
    expectOk(await admin.post('/v1/users', { email: 'pu@meta.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'pu@meta.test', role: 'power_user' }));
    const pu = await signIn(h, 'pu@meta.test');
    expect((await pu.post(`${base}/metadata/restore`, { at: await now() })).status).toBe(403);
  });

  it('previews and then undoes renames, moves, deletes and additions, keeping new members that hold data', async () => {
    await pause();
    const t0 = await now();
    const opsId = (await memberRow('Department', 'Operations')).member_id;
    await pause();

    // After t0: rename, move, alias, delete, two additions (one gets data), definition edits.
    expectOk(await admin.put(`${base}/dimensions/Account/members`, { members: [{ name: 'Opex', alias: 'Operating costs' }, { name: 'COGS', parent: 'Net Income' }] }));
    await superQuery(h, `update epm.member m set name = 'Operating Expenses' from epm.dimension d where d.dim_id = m.dim_id and d.app_id = $1 and m.name = 'Opex'`, [appId]);
    expectOk(await admin.del(`${base}/dimensions/Department/members/Operations`));
    expectOk(await admin.put(`${base}/dimensions/Department/members`, { members: [{ name: 'Marketing', parent: 'All Departments' }, { name: 'Legal', parent: 'All Departments' }] }));
    expectOk(await admin.post(`${base}/deploy`));
    await write({ ...POV, Department: 'Marketing' }, ['Revenue'], ['Jan'], [[7]]);
    expectOk(await admin.put(`${base}/forms/Opex Entry`, {
      cube: 'Plan',
      definition: { pov: { ...POV, Department: 'Sales' }, rows: { dimension: 'Account', members: ['Operating Expenses'] }, columns: { dimension: 'Period', members: ['Jan'] } },
    }));
    expectOk(await admin.put(`${base}/forms/Temp Form`, {
      cube: 'Plan',
      definition: { pov: { ...POV, Department: 'Sales' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } },
    }));
    const reportId = expectOk(await admin.get(`${base}/reports/Margin`)).report_id;
    expectOk(await admin.del(`${base}/reports/Margin`));
    const revBefore = (await superQuery(h, 'select metadata_rev from epm.application where app_id = $1', [appId]))[0].metadata_rev;

    const preview = expectOk(await restore({ at: t0, dry_run: true }));
    expect(preview.dry_run).toBe(true);
    const dept = preview.members.dimensions.find((d: { dimension: string }) => d.dimension === 'Department');
    expect(dept).toMatchObject({ recreated: ['Operations'], removed: ['Legal'], kept: [{ name: 'Marketing', cells: 1 }] });
    const acct = preview.members.dimensions.find((d: { dimension: string }) => d.dimension === 'Account');
    expect(acct.changed).toEqual(expect.arrayContaining([
      { name: 'Opex', was: 'Operating Expenses', fields: ['name', 'alias'] },
      { name: 'COGS', fields: ['parent'] },
    ]));
    expect(preview.definitions).toMatchObject({ created: [{ type: 'report', name: 'Margin' }], updated: [{ type: 'form', name: 'Opex Entry' }], kept_new: [{ type: 'form', name: 'Temp Form' }] });
    // Nothing changed yet.
    expect((await superQuery(h, 'select metadata_rev from epm.application where app_id = $1', [appId]))[0].metadata_rev).toBe(revBefore);
    expect(await memberRow('Department', 'Operations')).toBeUndefined();

    const done = expectOk(await restore({ at: t0 }));
    expect(done.members.deployed).toBe(true);
    expect(done.members.metadata_rev).toBe(revBefore + 1);
    expect(done.pre_restore_snapshot_id).toBeTruthy();
    expect(done.members.notes[0]).toMatch(/access grants/);

    expect(await memberRow('Department', 'Operations')).toMatchObject({ member_id: opsId, parent: 'All Departments', deployed: true });
    expect(await memberRow('Department', 'Legal')).toBeUndefined();
    expect(await memberRow('Department', 'Marketing')).toMatchObject({ parent: 'All Departments', deployed: true });
    expect(await memberRow('Account', 'Opex')).toMatchObject({ alias: null, parent: 'Net Income' });
    expect(await memberRow('Account', 'COGS')).toMatchObject({ parent: 'Gross Margin' });
    // Rollups follow the restored tree; the kept member keeps its data.
    expect(await read({ ...POV, Department: 'Sales' }, ['Gross Margin'], ['Jan'])).toEqual([[60]]);
    expect(await read({ ...POV, Department: 'Marketing' }, ['Revenue'], ['Jan'])).toEqual([[7]]);

    const form = expectOk(await admin.get(`${base}/forms/Opex Entry`));
    expect(form.definition.rows).toEqual([{ dimension: 'Account', members: ['Opex'] }]);
    expect(expectOk(await admin.get(`${base}/reports/Margin`)).report_id).toBe(reportId);
    expect((await admin.get(`${base}/forms/Temp Form`)).status).toBe(200);
    const ev = await superQuery(h, "select detail from epm.security_event where event_type = 'metadata_restored'");
    expect(ev).toHaveLength(1);

    // Restoring to the same moment again changes nothing.
    const again = expectOk(await restore({ at: t0 }));
    expect(again.changes).toBe(0);
    expect(again.pre_restore_snapshot_id).toBeNull();
  });

  it('brings back data on members that come back when data is restored too', async () => {
    await pause();
    const t1 = await now();
    await pause();
    // Q2's months go; Q2 becomes a leaf and takes data.
    for (const m of ['Apr', 'May', 'Jun']) expectOk(await admin.del(`${base}/dimensions/Period/members/${m}`));
    expectOk(await admin.post(`${base}/deploy`));
    await write({ ...POV, Department: 'Sales' }, ['Revenue'], ['Q2', 'Jan'], [[500, 999]]);

    const refused = await restore({ at: t1, definitions: false });
    expect(refused.status).toBe(422);
    expect(refused.body.message).toMatch(/Period Q2 holds data but had children/);

    const preview = expectOk(await restore({ at: t1, definitions: false, data: true, dry_run: true }));
    expect(preview.data).toMatchObject({ parents_cleared: 1, cells_set: 1, over_limit: false });
    const done = expectOk(await restore({ at: t1, definitions: false, data: true }));
    expect(done.members.dimensions.find((d: { dimension: string }) => d.dimension === 'Period').recreated).toEqual(['Apr', 'May', 'Jun']);
    expect(await read({ ...POV, Department: 'Sales' }, ['Revenue'], ['Jan', 'Q2'])).toEqual([[100, null]]);
    expect(done.data.txn_ids.length).toBeGreaterThan(0);
  });

  it('refuses while another dimension has saved changes that are not deployed', async () => {
    const t = await now();
    expectOk(await admin.put(`${base}/dimensions/Product/members`, { members: [{ name: 'Gizmos', parent: 'All Products' }] }));
    const r = await restore({ at: t, dimensions: ['Account'], definitions: false });
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Product has saved changes that are not deployed/);
    // Including Product discards the saved addition.
    const ok = expectOk(await restore({ at: t, dimensions: ['Account', 'Product'], definitions: false, dry_run: true }));
    const prod = ok.members.dimensions.find((d: { dimension: string }) => d.dimension === 'Product');
    expect(prod).toMatchObject({ removed: ['Gizmos'], pending_discarded: 1 });
    expectOk(await admin.post(`${base}/deploy`));
  });

  it('restores metadata, definitions, access and data from a snapshot', async () => {
    expectOk(await admin.post('/v1/users', { email: 'eve@meta.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'eve@meta.test', role: 'planner' }));
    expectOk(await admin.put(`${base}/dimensions/Entity/members`, { members: [{ name: 'North', parent: 'Total Company' }] }));
    expectOk(await admin.post(`${base}/deploy`));
    expectOk(await admin.put(`${base}/grants`, {
      grants: [{ principal: { user: 'eve@meta.test' }, dimension: 'Entity', member: 'North', scope: 'member', access: 'write' }],
    }));
    const snap = expectOk(await admin.post(`${base}/snapshots`, { comment: 'before North goes' }), 201);
    expect(snap.manifest.schema_ver).toBe(3);
    const northId = (await memberRow('Entity', 'North')).member_id;

    expectOk(await admin.del(`${base}/dimensions/Entity/members/North`));
    expectOk(await admin.post(`${base}/deploy`));
    expectOk(await admin.del(`${base}/forms/Temp Form`));
    await write({ ...PLAN_POV }, ['Revenue'], ['Feb'], [[123456]]);

    const r = expectOk(await admin.post(`${base}/metadata/restore`, { snapshot_id: snap.snapshot_id, data: true }));
    expect(r.source).toMatchObject({ type: 'snapshot', snapshot_id: snap.snapshot_id });
    expect(r.members.dimensions.find((d: { dimension: string }) => d.dimension === 'Entity').recreated).toEqual(['North']);
    expect(r.members.grants_restored).toBe(1);
    expect(r.definitions.created).toEqual([{ type: 'form', name: 'Temp Form' }]);
    expect(r.data.cells_set + r.data.cells_cleared).toBeGreaterThan(0);
    expect(await memberRow('Entity', 'North')).toMatchObject({ member_id: northId, deployed: true });
    expect(await read({ ...PLAN_POV }, ['Revenue'], ['Feb'])).toEqual([[110]]);
    const eve = await signIn(h, 'eve@meta.test');
    const g = expectOk(await eve.post(`${base}/grid/read`, { cube: 'Plan', pov: { ...POV, Entity: 'North', Department: 'Sales' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } }));
    expect(g.writable).toEqual([[true]]);
  });

  it('a copy restored into a new application has nothing pending: its deployed state matches the source', async () => {
    const snap = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    const copy = expectOk(await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Meta Copy' }), 201);
    await pause();
    const r = expectOk(await admin.post(`/v1/apps/${copy.app_id}/metadata/restore`, { at: await now(), definitions: false, dry_run: true }));
    expect(r.changes).toBe(0);
    expect(r.members.dimensions.map((d: { pending_discarded: number; changed: unknown[] }) => [d.pending_discarded, d.changed.length]))
      .toEqual(r.members.dimensions.map(() => [0, 0]));
  });

  it('lists deploys and definition changes to choose a moment from', async () => {
    const hist = expectOk(await admin.get(`${base}/metadata/history`));
    expect(hist.history_from).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(hist.deploys[0].metadata_rev).toBeGreaterThan(hist.deploys[hist.deploys.length - 1].metadata_rev);
    expect(hist.deploys[0].deployed_by).toBe('admin@meta.test');
    expect(hist.definitions.some((d: { name: string; deleted: boolean }) => d.name === 'Margin' && d.deleted)).toBe(true);
  });
});
