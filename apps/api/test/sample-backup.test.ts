import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSampleApp, loadSampleImports, loadSampleModel } from '../scripts/sample.js';
import { Api, type Harness, createHarness, expectOk, provisionTenant, signIn } from './helpers.js';

/** Snapshots and restores at sample scale: the Fernhollow model with about 20,000 cells. */
describe('backup and restore of the Fernhollow sample', () => {
  let h: Harness;
  let admin: Api;
  let base: string;
  let facts: number;

  // The P&L Summary form's layout as an ad hoc grid, so any version can be read.
  const pnl = async (b: string, page: Record<string, string>) =>
    expectOk(await admin.post(`${b}/grid/read`, {
      cube: 'Plan',
      pov: { Department: 'All Departments', Product: 'All Products', Channel: 'All Channels', ...page },
      rows: { dimension: 'Account', members: ['@idescendants(Net Income)'] },
      columns: { dimension: 'Period', members: ['Q1', 'Q2', 'Q3', 'Q4', 'YearTotal'] },
    })).values as (number | null)[][];
  const PAGES = [
    { Scenario: 'Actual', Version: 'Final', Years: 'FY26', Entity: 'Fernhollow Consolidated' },
    { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'Portland Kitchen' },
    { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Entity: 'Savannah Kitchen' },
  ];

  /**
   * Bulk data straight through apply_changes (the grid seeding in seed:sample takes too long for a
   * test): FY26 actuals, the FY27 budget and forecast and the FY28 budget for every kitchen,
   * department and expense account by month, plus gross sales by product and channel.
   */
  async function bulkSeed(tenantId: string, appId: string, email: string): Promise<number> {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      const user = (await c.query<{ user_id: string }>('select user_id from epm.app_user where email = $1', [email])).rows[0]!.user_id;
      await c.query("select set_config('app.user_id', $1, true)", [user]);
      const member = async (name: string) =>
        (await c.query<{ member_id: number }>(
          'select m.member_id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1 and m.name = $2',
          [appId, name],
        )).rows[0]!.member_id;
      const leaves = async (parent: string) =>
        (await c.query<{ id: number }>('select descendant_id as id from epm.member_ancestor where ancestor_id = $1 and descendant_is_leaf order by 1', [
          await member(parent),
        ])).rows.map((r) => r.id);
      const slots = new Map((await c.query<{ name: string; slot: number }>('select name, slot from epm.dimension where app_id = $1 and slot is not null', [appId])).rows.map((r) => [r.name, r.slot]));
      const cube = (await c.query<{ cube_id: number }>('select cube_id from epm.cube where app_id = $1', [appId])).rows[0]!.cube_id;
      const months = await leaves('YearTotal');
      const kitchens = await leaves('Fernhollow Consolidated');
      const departments = await leaves('All Departments');
      const expenses = [...(await leaves('Operating Expenses')), ...(await leaves('Cost of Goods Sold'))];
      const products = await leaves('Sauces').then(async (a) => [...a, ...(await leaves('Spice Blends')), ...(await leaves('Cold Brew'))]);
      const channels = [...(await leaves('Grocery')), await member('Foodservice'), ...(await leaves('Direct to Consumer'))];
      const noProduct = await member('No Product');
      const noChannel = await member('No Channel');
      const noDept = await member('No Department');
      const grossSales = await member('Gross Sales');
      const slices: number[][] = [];
      for (const [scenario, version, years] of [['Actual', 'Final', 'FY26'], ['Budget', 'Working', 'FY27'], ['Forecast', 'Working', 'FY27'], ['Budget', 'Working', 'FY28']]) {
        slices.push([await member(scenario!), await member(version!), await member(years!)]);
      }
      const cells: { k: number[]; v: number }[] = [];
      const cell = (sc: number[], period: number, entity: number, account: number, dept: number, product: number, channel: number) => {
        const k = new Array<number>(16).fill(0);
        k[0] = cube; k[1] = sc[0]!; k[2] = sc[1]!; k[3] = sc[2]!; k[4] = period; k[5] = entity; k[6] = account; k[7] = dept;
        k[7 + slots.get('Product')!] = product;
        k[7 + slots.get('Channel')!] = channel;
        cells.push({ k, v: 100 + ((cells.length * 7919) % 9000) });
      };
      for (const sc of slices) for (const e of kitchens) for (const m of months) {
        for (const d of departments) for (const a of expenses) cell(sc, m, e, a, d, noProduct, noChannel);
        for (const p of products) for (const ch of channels) cell(sc, m, e, grossSales, noDept, p, ch);
      }
      for (let i = 0; i < cells.length; i += 10_000) {
        await c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: appId, source: 'api', cells: cells.slice(i, i + 10_000) })]);
      }
      await c.query('commit');
      return cells.length;
    } catch (err) {
      await c.query('rollback');
      throw err;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    h = await createHarness();
    const model = loadSampleModel('fernhollow');
    const tenantId = await provisionTenant(h.db, model.company, null, 'admin@fernhollow.test');
    admin = await signIn(h, 'admin@fernhollow.test');
    const call = async (method: any, url: string, body?: unknown) =>
      expectOk(await admin.call(method, url, body), method === 'POST' && /\/(apps|groups|dimensions|cubes)$/.test(url) ? 201 : 200);
    const appId = await buildSampleApp(call, model);
    base = `/v1/apps/${appId}`;
    facts = await bulkSeed(tenantId, appId, 'admin@fernhollow.test');
    const upload = async (b: string, name: string, data: Uint8Array, purpose: 'import' | 'dataset') => expectOk(await admin.upload(b, name, data, purpose), 201);
    await loadSampleImports(call, upload, appId, model);
  }, 30_000);
  afterAll(async () => h?.close());

  it('snapshots the plan and restores it into a new application that matches', async () => {
    const snap = expectOk(await admin.post(`${base}/snapshots`, {}), 201);
    expect(snap.status).toBe('complete');
    expect(snap.fact_count).toBeGreaterThan(20_000);
    expect(snap.fact_count).toBeGreaterThanOrEqual(facts);

    const restored = expectOk(await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'new_app', name: 'Fernhollow (copy)' }), 201);
    expect(restored.cells).toBe(snap.fact_count);
    const copy = `/v1/apps/${restored.app_id}`;
    for (const page of PAGES) expect(await pnl(copy, page), JSON.stringify(page)).toEqual(await pnl(base, page));

    // A full in-place preview of an unchanged application finds nothing to do.
    const dry = expectOk(await admin.post(`${base}/snapshots/${snap.snapshot_id}/restore`, { target: 'in_place', dry_run: true }));
    expect(dry).toMatchObject({ cells_set: 0, cells_cleared: 0, unchanged: snap.fact_count, skipped: 0 });
  });

  it('rebuilds the FY27 budget as it was before the July actuals were imported, into a new version', async () => {
    const runs = expectOk(await admin.get(`${base}/imports`)).runs;
    const load = runs.find((r: any) => r.status === 'loaded');
    const r = expectOk(await admin.post(`${base}/restore`, {
      cube: 'Plan', scenario: 'Actual', version: 'Final', before_txn: load.txn_id, into_version: 'Before July Load', create_version: true,
    }));
    expect(r.version_created).toBe(true);
    const before = await pnl(base, { Scenario: 'Actual', Version: 'Before July Load', Years: 'FY27', Entity: 'Fernhollow Consolidated' });
    expect(before.flat().every((v) => v === null)).toBe(true); // FY27 actuals arrived with that load
    const fy26 = await pnl(base, { Scenario: 'Actual', Version: 'Before July Load', Years: 'FY26', Entity: 'Fernhollow Consolidated' });
    expect(fy26).toEqual(await pnl(base, PAGES[0]!));
  });
});
