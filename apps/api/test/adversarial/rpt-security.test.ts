import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn, superQuery } from '../helpers.js';

/**
 * Member-level security on multi-dimension grids and reports. Entity and Product are both secured.
 *   pat   planner      Entity East write;            Product: read all, Gadgets write
 *   vera  viewer       Entity East read;             Product: read all
 *   tom   planner      Entity Total Company read (member only), West write; Product: write all
 *   paula power_user   Entity East read;             Product: read all
 *   nora  planner      no grants at all
 * Data (Budget/Working/FY27/Sales, Revenue, Jan): East Widgets 100, East Gadgets 200,
 * West Widgets 1000, West Gadgets 2000.
 */
const SALES = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales' };
const names = (tuples: { name: string }[][]) => tuples.map((t) => t.map((m) => m.name).join('/'));

describe('rpt: member-level security on multi-dimension grids and reports', () => {
  let h: Harness;
  let admin: Api;
  let pat: Api;
  let vera: Api;
  let tom: Api;
  let paula: Api;
  let nora: Api;
  let appId: string;
  let base: string;

  const exportEvents = (email: string) =>
    superQuery(h, `select e.detail from epm.security_event e join epm.app_user u on u.user_id = e.user_id
                    where e.event_type = 'report_exported' and u.email = $1 order by e.event_id`, [email]);

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'SecRpt', null, 'admin@sr.test');
    admin = await signIn(h, 'admin@sr.test');
    appId = await seedPlanApp(admin, 'Secured');
    base = `/v1/apps/${appId}`;
    expectOk(await admin.patch(`${base}/dimensions/Product`, { secured: true }));
    const roles: [string, string][] = [['pat', 'planner'], ['vera', 'viewer'], ['tom', 'planner'], ['paula', 'power_user'], ['nora', 'planner']];
    for (const [u, role] of roles) {
      expectOk(await admin.post('/v1/users', { email: `${u}@sr.test` }), 201);
      expectOk(await admin.post(`${base}/roles`, { email: `${u}@sr.test`, role }));
    }
    const g = (user: string, dimension: string, member: string, scope: string, access: string) => ({ principal: { user: `${user}@sr.test` }, dimension, member, scope, access });
    expectOk(await admin.put(`${base}/grants`, {
      grants: [
        g('pat', 'Entity', 'East', 'member', 'write'),
        g('pat', 'Product', 'All Products', 'idescendants', 'read'),
        g('pat', 'Product', 'Gadgets', 'member', 'write'),
        g('vera', 'Entity', 'East', 'member', 'read'),
        g('vera', 'Product', 'All Products', 'idescendants', 'read'),
        g('tom', 'Entity', 'Total Company', 'member', 'read'),
        g('tom', 'Entity', 'West', 'member', 'write'),
        g('tom', 'Product', 'All Products', 'idescendants', 'write'),
        g('paula', 'Entity', 'East', 'member', 'read'),
        g('paula', 'Product', 'All Products', 'idescendants', 'read'),
      ],
    }));
    [pat, vera, tom, paula, nora] = await Promise.all(roles.map(([u]) => signIn(h, `${u}@sr.test`)));

    const seed = expectOk(await admin.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { ...SALES, Account: 'Revenue', Period: 'Jan' },
      rows: [{ dimension: 'Entity', members: ['East', 'West'] }], columns: [{ dimension: 'Product', members: ['Widgets', 'Gadgets'] }],
    }));
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: seed.grid_session_id, values: [[100, 200], [1000, 2000]] }));

    expectOk(await admin.put(`${base}/reports/Entity Page`, {
      cube: 'Plan',
      definition: {
        pov: { ...SALES, Account: 'Revenue' },
        page: { Entity: ['@ichildren(Total Company)'] },
        rows: [{ dimension: 'Product', members: ['@ichildren(All Products)'] }],
        columns: [{ dimension: 'Period', members: ['Jan', 'Q1'] }],
      },
    }));
  });
  afterAll(async () => h?.close());

  it('filters both secured dimensions on rows and columns, and only leaf tuples the user can write are writable', async () => {
    const spec = {
      cube: 'Plan', pov: SALES,
      rows: [{ dimension: 'Entity', members: ['@idescendants(Total Company)'] }, { dimension: 'Account', members: ['Revenue'] }],
      columns: [{ dimension: 'Product', members: ['@idescendants(All Products)'] }, { dimension: 'Period', members: ['Jan'] }],
    };
    const g = expectOk(await pat.post(`${base}/grid/read`, spec));
    expect(names(g.rows.tuples)).toEqual(['East/Revenue']);
    expect(names(g.columns.tuples)).toEqual(['All Products/Jan', 'Widgets/Jan', 'Gadgets/Jan']);
    expect(g.values).toEqual([[300, 100, 200]]);
    expect(g.writable).toEqual([[false, false, true]]);
    // Typing into every cell writes only East/Gadgets.
    const res = expectOk(await pat.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[999, 111, 222]] }));
    expect({ cells: res.cell_count, ignored: res.ignored_readonly }).toEqual({ cells: 1, ignored: 2 });
    const after = expectOk(await admin.post(`${base}/grid/read`, spec));
    expect(after.values[1]).toEqual([322, 100, 222]); // rows for admin: Total Company, East, West
    expectOk(await pat.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[999, 111, 200]] }));
  });

  it('applies read and write access to a secured dimension placed on columns', async () => {
    const spec = {
      cube: 'Plan', pov: { ...SALES, Period: 'Jan' },
      rows: [{ dimension: 'Account', members: ['Revenue', 'COGS'] }],
      columns: [{ dimension: 'Entity', members: ['@ichildren(Total Company)'] }, { dimension: 'Product', members: ['Widgets', 'Gadgets'] }],
    };
    const p = expectOk(await pat.post(`${base}/grid/read`, spec));
    expect(names(p.columns.tuples)).toEqual(['East/Widgets', 'East/Gadgets']);
    expect(p.writable).toEqual([[false, true], [false, true]]);
    expect(p.values[0]).toEqual([100, 200]);
    const t = expectOk(await tom.post(`${base}/grid/read`, spec));
    expect(names(t.columns.tuples)).toEqual(['Total Company/Widgets', 'Total Company/Gadgets', 'West/Widgets', 'West/Gadgets']);
    expect(t.writable).toEqual([[false, false, true, true], [false, false, true, true]]);
    // Read on a parent shows its total (East included), exactly as the single-dimension grid does.
    expect(t.values[0]).toEqual([1100, 2200, 1000, 2000]);
    const single = expectOk(await tom.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { ...SALES, Entity: 'Total Company', Product: 'Widgets' },
      rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] },
    }));
    expect(single.values).toEqual([[1100]]);
    // A viewer gets the same filtering and nothing writable.
    const v = expectOk(await vera.post(`${base}/grid/read`, spec));
    expect(names(v.columns.tuples)).toEqual(['East/Widgets', 'East/Gadgets']);
    expect(v.writable.flat().some(Boolean)).toBe(false);
  });

  it('refuses POV members the user cannot read in grids and reports', async () => {
    const grid = (user: Api, entity: string) => user.post(`${base}/grid/read`, {
      cube: 'Plan', pov: { ...SALES, Entity: entity, Period: 'Jan' },
      rows: [{ dimension: 'Account', members: ['Revenue'] }], columns: [{ dimension: 'Product', members: ['Widgets'] }],
    });
    expect((await grid(pat, 'West')).status).toBe(403);
    expect((await grid(pat, 'Total Company')).status).toBe(403);
    expect((await grid(nora, 'East')).status).toBe(403);
    expect((await grid(pat, 'East')).status).toBe(200);

    expectOk(await admin.put(`${base}/reports/West Only`, {
      cube: 'Plan',
      definition: {
        pov: { ...SALES, Entity: 'West' },
        rows: [{ dimension: 'Account', members: ['Revenue'] }],
        columns: [{ dimension: 'Product', members: ['Widgets'] }, { dimension: 'Period', members: ['Jan'] }],
      },
    }));
    expect((await pat.post(`${base}/reports/West Only/run`, {})).status).toBe(403);
    expect((await pat.raw('POST', `${base}/reports/West Only/run?format=xlsx`, '{}', 'application/json')).status).toBe(403);
    expect(expectOk(await tom.post(`${base}/reports/West Only/run`, {})).values).toEqual([[1000]]);
  });

  it('offers only readable page members and refuses others', async () => {
    const p = expectOk(await pat.post(`${base}/reports/Entity Page/run`, {}));
    expect(p.page).toEqual({ Entity: { selected: 'East', options: ['East'] } });
    expect(names(p.rows.tuples)).toEqual(['All Products', 'Widgets', 'Gadgets']);
    expect(p.values).toEqual([[300, 300], [100, 100], [200, 200]]);
    for (const pick of ['West', 'Total Company', 'west']) {
      expect((await pat.post(`${base}/reports/Entity Page/run`, { page: { Entity: pick } })).status).toBe(422);
    }
    expect((await nora.post(`${base}/reports/Entity Page/run`, {})).status).toBe(403);
    const t = expectOk(await tom.post(`${base}/reports/Entity Page/run`, { page: { entity: 'west' } }));
    expect(t.page).toEqual({ Entity: { selected: 'West', options: ['Total Company', 'West'] } });
    expect(t.values).toEqual([[3000, 3000], [1000, 1000], [2000, 2000]]);
    expect((await tom.post(`${base}/reports/Entity Page/run`, { page: { Entity: 'East' } })).status).toBe(422);
  });

  it('shows each user in a report exactly what the same grid shows them', async () => {
    const layout = {
      pov: { ...SALES, Account: 'Revenue' },
      rows: [{ dimension: 'Entity', members: ['@ichildren(Total Company)'] }, { dimension: 'Product', members: ['@ichildren(All Products)'] }],
      columns: [{ dimension: 'Period', members: ['Jan', 'Feb', 'Q1'] }],
    };
    expectOk(await admin.put(`${base}/reports/Mirror`, { cube: 'Plan', definition: { ...layout, suppress_missing_rows: false } }));
    for (const user of [admin, pat, vera, tom, nora]) {
      const g = expectOk(await user.post(`${base}/grid/read`, { cube: 'Plan', ...layout }));
      const r = expectOk(await user.post(`${base}/reports/Mirror/run`, {}));
      expect(names(r.rows.tuples)).toEqual(names(g.rows.tuples));
      expect(r.values).toEqual(g.values);
    }
  });

  it('refuses every report route without a session', async () => {
    const anon = new Api(h.app);
    expect((await anon.get(`${base}/reports`)).status).toBe(401);
    expect((await anon.get(`${base}/reports/Entity Page`)).status).toBe(401);
    expect((await anon.post(`${base}/reports/Entity Page/run`, {})).status).toBe(401);
    expect((await anon.raw('POST', `${base}/reports/Entity Page/run?format=csv`, '{}', 'application/json')).status).toBe(401);
    expect((await anon.put(`${base}/reports/X`, {})).status).toBe(401);
    expect((await anon.del(`${base}/reports/Entity Page`)).status).toBe(401);
  });

  it('validates display options when a report is saved', async () => {
    const body = (extra: Record<string, unknown>) => ({
      cube: 'Plan',
      definition: { pov: { ...SALES, Entity: 'East', Product: 'Widgets' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] }, ...extra },
    });
    for (const bad of [{ decimals: 7 }, { decimals: -1 }, { decimals: 2.5 }, { scale: 100 }, { scale: '1000' }, { labels: 'code' }, { title: 'x'.repeat(201) }, { instructions: 'x'.repeat(2001) }]) {
      expect((await admin.put(`${base}/reports/Bad Options`, body(bad))).status).toBe(422);
    }
    expect((await admin.put(`${base}/reports/${'n'.repeat(201)}`, body({}))).status).toBe(422);
    // Slashes are allowed in names (as in form names); the URL carries them encoded.
    for (const encoded of ['a%5Cb', 'a%2Fb']) {
      const res = await h.app.request(`${base}/reports/${encoded}`, {
        method: 'PUT', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body({})),
      });
      expect(res.status).toBe(200);
    }
    const bell = await h.app.request(`${base}/reports/bad%07name`, {
      method: 'PUT', headers: { authorization: `Bearer ${admin.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body({})),
    });
    expect(bell.status).toBe(422);
    const ok = expectOk(await admin.put(`${base}/reports/Good Options`, body({ decimals: 6, scale: 1000000, labels: 'both' })));
    expect(ok.version).toBe(1);
    const stored = expectOk(await vera.get(`${base}/reports/Good Options`));
    // The legacy single-object axis is stored in the list form, with defaults filled in.
    expect(stored.definition.rows).toEqual([{ dimension: 'Account', members: ['Revenue'] }]);
    expect(stored.definition).toMatchObject({ suppress_missing_rows: true, suppress_missing_columns: false, decimals: 6, scale: 1000000, labels: 'both' });
    expectOk(await admin.del(`${base}/reports/Good Options`));
  });

  it('lets only power users and admins change reports; viewers and planners can list and run them', async () => {
    const body = {
      cube: 'Plan',
      definition: { pov: { ...SALES, Entity: 'East', Product: 'Widgets' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } },
    };
    for (const user of [vera, pat, nora]) {
      expect((await user.put(`${base}/reports/Mine`, body)).status).toBe(403);
      expect((await user.del(`${base}/reports/Entity Page`)).status).toBe(403);
      expect((await user.get(`${base}/reports/Entity Page/history`)).status).toBe(403);
    }
    expect((await vera.get(`${base}/reports`)).status).toBe(200);
    expect((await vera.get(`${base}/reports/Entity Page`)).status).toBe(200);
    expect(expectOk(await paula.put(`${base}/reports/Paula's`, body)).version).toBe(1);
    expect(expectOk(await vera.post(`${base}/reports/Paula's/run`, {})).values).toEqual([[100]]);
    expect(expectOk(await paula.del(`${base}/reports/Paula's`)).deleted).toBe("Paula's");
    expect((await vera.post(`${base}/reports/Paula's/run`, {})).status).toBe(404);
    const reports = await superQuery(h, "select count(*)::int as n from epm.report where name in ('Mine')");
    expect(reports[0].n).toBe(0);
  });

  it('logs report_exported once per file export with the report and format, and not for JSON or refused runs', async () => {
    const before = (await exportEvents('vera@sr.test')).length;
    expectOk(await vera.post(`${base}/reports/Entity Page/run`, {}));
    expect((await vera.raw('POST', `${base}/reports/Entity Page/run?format=xlsx`, JSON.stringify({ page: { Entity: 'West' } }), 'application/json')).status).toBe(422);
    expect((await vera.raw('POST', `${base}/reports/Entity Page/run?format=pdf`, '{}', 'application/json')).status).toBe(422);
    expect((await exportEvents('vera@sr.test')).length).toBe(before);
    expect((await vera.raw('POST', `${base}/reports/Entity Page/run?format=xlsx`, '{}', 'application/json')).status).toBe(200);
    expect((await vera.raw('POST', `${base}/reports/Entity Page/run?format=csv`, '{}', 'application/json')).status).toBe(200);
    const events = await exportEvents('vera@sr.test');
    expect(events.slice(before).map((e: any) => [e.detail.report, e.detail.format])).toEqual([['Entity Page', 'xlsx'], ['Entity Page', 'csv']]);
  });

  it('closes reports and multi-dimension grids while the application is being restored', async () => {
    await superQuery(h, "update epm.application set state = 'restoring' where app_id = $1", [appId]);
    try {
      expect((await admin.get(`${base}/reports`)).status).toBe(423);
      expect((await admin.get(`${base}/reports/Entity Page`)).status).toBe(423);
      expect((await vera.post(`${base}/reports/Entity Page/run`, {})).status).toBe(423);
      expect((await vera.raw('POST', `${base}/reports/Entity Page/run?format=csv`, '{}', 'application/json')).status).toBe(423);
      expect((await admin.put(`${base}/reports/During Restore`, { cube: 'Plan', definition: { pov: {}, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } } })).status).toBe(423);
      expect((await admin.del(`${base}/reports/Entity Page`)).status).toBe(423);
      expect((await pat.post(`${base}/grid/read`, {
        cube: 'Plan', pov: SALES,
        rows: [{ dimension: 'Entity', members: ['East'] }, { dimension: 'Account', members: ['Revenue'] }],
        columns: [{ dimension: 'Product', members: ['Gadgets'] }, { dimension: 'Period', members: ['Jan'] }],
      })).status).toBe(423);
    } finally {
      await superQuery(h, "update epm.application set state = 'online' where app_id = $1", [appId]);
    }
    expect((await vera.post(`${base}/reports/Entity Page/run`, {})).status).toBe(200);
  });

  it('applies plan windows per cell when Scenario and Period sit on multi-dimension axes', async () => {
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', start_period: 'Feb', end_period: 'Jun' }));
    const spec = {
      cube: 'Plan', pov: { Version: 'Working', Years: 'FY27', Department: 'Sales', Account: 'Revenue' },
      rows: [{ dimension: 'Scenario', members: ['Budget', 'Actual'] }, { dimension: 'Entity', members: ['West'] }],
      columns: [{ dimension: 'Product', members: ['Widgets'] }, { dimension: 'Period', members: ['Jan', 'Feb', 'Q1'] }],
    };
    const g = expectOk(await tom.post(`${base}/grid/read`, spec));
    expect(names(g.rows.tuples)).toEqual(['Budget/West', 'Actual/West']);
    expect(g.writable).toEqual([[false, true, false], [true, true, false]]);
    const res = expectOk(await tom.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[5, 6, 1000], [7, 8, null]] }));
    expect({ cells: res.cell_count, ignored: res.ignored_readonly }).toEqual({ cells: 3, ignored: 1 });
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', locked: true }));
    const locked = expectOk(await tom.post(`${base}/grid/read`, spec));
    expect(locked.writable).toEqual([[false, false, false], [true, true, false]]);
    expect(locked.values).toEqual([[1000, 6, 1006], [7, 8, 15]]);
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', locked: false }));
  });

  it("keeps another tenant out of this application's reports and grids", async () => {
    await provisionTenant(h.db, 'Rival', null, 'admin@rival.test');
    const rival = await signIn(h, 'admin@rival.test');
    const rivalApp = await seedPlanApp(rival, 'Rival Plan');
    expect((await rival.get(`${base}/reports`)).status).toBe(404);
    expect((await rival.get(`${base}/reports/Entity Page`)).status).toBe(404);
    expect((await rival.post(`${base}/reports/Entity Page/run`, {})).status).toBe(404);
    expect((await rival.raw('POST', `${base}/reports/Entity Page/run?format=xlsx`, '{}', 'application/json')).status).toBe(404);
    expect((await rival.put(`${base}/reports/Entity Page`, { cube: 'Plan', definition: { pov: {}, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } } })).status).toBe(404);
    expect((await rival.del(`${base}/reports/Entity Page`)).status).toBe(404);
    // Their own app has no report by that name, even though the name exists in another tenant.
    expect((await rival.post(`/v1/apps/${rivalApp}/reports/Entity Page/run`, {})).status).toBe(404);
    const g = expectOk(await pat.post(`${base}/grid/read`, {
      cube: 'Plan', pov: SALES,
      rows: [{ dimension: 'Entity', members: ['East'] }, { dimension: 'Account', members: ['Revenue'] }],
      columns: [{ dimension: 'Product', members: ['Gadgets'] }, { dimension: 'Period', members: ['Jan'] }],
    }));
    // Someone else's grid session, even with a valid app of their own, is not found.
    expect((await rival.post(`/v1/apps/${rivalApp}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[1]] })).status).toBe(404);
    expect((await tom.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: [[1]] })).status).toBe(404);
  });
});
