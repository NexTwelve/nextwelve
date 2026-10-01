import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSampleApp, loadSampleImports, loadSampleModel } from '../scripts/sample.js';
import { type Harness, createHarness, expectOk, provisionTenant, signIn } from './helpers.js';

/** The Fernhollow Foods sample model must load, deploy and open every form through the API. */
describe('Fernhollow sample model', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());

  it('builds, deploys and opens each sample form', async () => {
    const model = loadSampleModel('fernhollow');
    await provisionTenant(h.db, model.company, null, 'admin@fernhollow.test');
    const admin = await signIn(h, 'admin@fernhollow.test');
    const call = async (method: any, url: string, body?: unknown) => expectOk(await admin.call(method, url, body), method === 'POST' && /\/(apps|groups|dimensions|cubes)$/.test(url) ? 201 : 200);
    const appId = await buildSampleApp(call, model);

    const dims = expectOk(await admin.get(`/v1/apps/${appId}/dimensions`));
    expect(dims.dimensions.map((d: any) => d.name)).toEqual(model.dimensions.map((d) => d.name));
    expect(dims.dimensions.find((d: any) => d.name === 'Department')).toMatchObject({ type: 'department', secured: true });

    const forms = expectOk(await admin.get(`/v1/apps/${appId}/forms`));
    expect(forms.forms.map((f: any) => f.name).sort()).toEqual(model.forms.map((f) => f.name).sort());
    for (const f of model.forms) {
      const opened = expectOk(await admin.post(`/v1/apps/${appId}/forms/${f.name}/open`, {}));
      expect(opened.grid.rows.tuples.length, f.name).toBeGreaterThan(0);
    }
    const pnl = expectOk(await admin.post(`/v1/apps/${appId}/forms/P&L Summary/open`, {}));
    expect(pnl.grid.rows.members[0]).toMatchObject({ name: 'Net Income', level: 0 });

    // July FY27 actuals: an ERP export mapped through the crosswalk workbook (a dataset).
    const upload = async (b: string, name: string, data: Uint8Array, purpose: 'import' | 'dataset') => expectOk(await admin.upload(b, name, data, purpose), 201);
    const [run] = await loadSampleImports(call, upload, appId, model);
    expect(run).toMatchObject({ status: 'loaded', lines_read: 992, lines_mapped: 992, lines_rejected: 0 });
    expect(run.datasets_used).toEqual([{ dataset: 'Fernhollow Crosswalk', version: 1 }]);

    const julyPnl = expectOk(await admin.post(`/v1/apps/${appId}/forms/P&L Summary/open`, {
      page: { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Entity: 'Fernhollow Consolidated' },
    }));
    const q1 = (name: string) => julyPnl.grid.values[julyPnl.grid.rows.members.findIndex((m: any) => m.name === name)][0];
    expect(q1('Gross Sales')).toBeGreaterThan(2_000_000);
    expect(q1('Net Income')).toBeGreaterThan(0);

    const drill = expectOk(await admin.post(`/v1/apps/${appId}/drill`, {
      cube: 'Plan',
      cell: { Scenario: 'Actual', Version: 'Final', Years: 'FY27', Period: 'Jul', Entity: 'Portland Kitchen', Department: 'Production',
              Account: 'Benefits & Payroll Taxes', Product: 'No Product', Channel: 'No Channel' },
    }));
    expect(drill.lines.map((l: any) => l.source['GL Account']).sort()).toEqual(['6010', '6020']);

    // The sample reports save and run; July actuals show up in Q1 (the fiscal year starts in July).
    const reports = expectOk(await admin.get(`/v1/apps/${appId}/reports`)).reports;
    expect(reports.map((r: any) => r.name).sort()).toEqual((model.reports ?? []).map((r) => r.name).sort());
    const pnlReport = expectOk(await admin.post(`/v1/apps/${appId}/reports/P&L by Entity/run`, {}));
    expect(pnlReport.page.Scenario.selected).toBe('Actual');
    expect(pnlReport.rows.dimensions).toEqual(['Entity', 'Account']);
    const consolidatedNi = pnlReport.rows.tuples.findIndex((t: any[]) => t[0].name === 'Fernhollow Consolidated' && t[1].name === 'Net Income');
    expect(pnlReport.values[consolidatedNi][0]).toBeCloseTo(q1('Net Income') / 1000, 0);
    const channel = expectOk(await admin.post(`/v1/apps/${appId}/reports/Revenue by Channel and Product/run`, { page: { Scenario: 'Actual', Version: 'Final' } }));
    expect(channel.columns.dimensions).toEqual(['Years', 'Period']);
  });
});
