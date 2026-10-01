/**
 * Loads a sample model (samples/<name>/model.json) through the public API, and generates
 * sample data for the Fernhollow Foods model. Used by scripts/seed-sample.ts and the tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Call = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => Promise<any>;
/** Raw upload to POST /v1/apps/:app/files; resolves to the stored file row. */
export type Upload = (appBase: string, name: string, data: Uint8Array, purpose: 'import' | 'dataset') => Promise<{ file_id: string }>;

export interface SampleModel {
  company: string;
  application: string;
  dimensions: { name: string; type: string; secured?: boolean; members: Record<string, unknown>[] }[];
  cubes: { name: string; dimensions: string[] }[];
  groups: { name: string; grants: { dimension: string; member: string; scope: string; access: string }[] }[];
  plan_windows: Record<string, unknown>[];
  forms: { name: string; folder?: string; description?: string; cube: string; definition: unknown }[];
  reports?: { name: string; folder?: string; description?: string; cube: string; definition: unknown }[];
  datasets: { name: string; file: string; description?: string }[];
  import_formats: { name: string; cube: string; definition: unknown; mappings: unknown[] }[];
  imports: { format: string; file: string; mode: 'merge' | 'replace' | 'accumulate' }[];
}

const here = dirname(fileURLToPath(import.meta.url));
export const SAMPLES_DIR = resolve(here, '..', '..', '..', 'samples');

export function loadSampleModel(name = 'fernhollow'): SampleModel {
  return JSON.parse(readFileSync(join(SAMPLES_DIR, name, 'model.json'), 'utf8')) as SampleModel;
}

/** Create the application, dimensions, members, cubes, groups, grants and plan windows; deploy. */
export async function buildSampleApp(call: Call, model: SampleModel): Promise<string> {
  const app = await call('POST', '/v1/apps', { name: model.application });
  const base = `/v1/apps/${app.app_id}`;
  for (const d of model.dimensions) {
    await call('POST', `${base}/dimensions`, { name: d.name, type: d.type, secured: d.secured ?? false });
    await call('PUT', `${base}/dimensions/${d.name}/members`, { members: d.members });
  }
  for (const cube of model.cubes) await call('POST', `${base}/cubes`, cube);
  await call('POST', `${base}/deploy`);
  for (const g of model.groups) {
    await call('POST', '/v1/groups', { name: g.name });
    await call('PUT', `${base}/grants`, { grants: g.grants.map((x) => ({ principal: { group: g.name }, ...x })) });
  }
  for (const w of model.plan_windows) await call('PUT', `${base}/plan-windows`, w);
  for (const { name, ...form } of model.forms) await call('PUT', `${base}/forms/${name}`, form);
  for (const { name, ...report } of model.reports ?? []) await call('PUT', `${base}/reports/${name}`, report);
  return app.app_id;
}

/**
 * Publish the sample's datasets, import formats and mapping rules, then run its sample imports
 * (for Fernhollow: the July FY27 GL actuals, mapped through the crosswalk workbook).
 */
export async function loadSampleImports(call: Call, upload: Upload, appId: string, model: SampleModel, name = 'fernhollow') {
  const base = `/v1/apps/${appId}`;
  const read = (file: string) => new Uint8Array(readFileSync(join(SAMPLES_DIR, name, file)));
  for (const d of model.datasets) {
    const f = await upload(base, d.file, read(d.file), 'dataset');
    await call('PUT', `${base}/datasets/${d.name}`, { file_id: f.file_id, description: d.description });
  }
  for (const f of model.import_formats) {
    await call('PUT', `${base}/import-formats/${f.name}`, { cube: f.cube, definition: f.definition });
    await call('PUT', `${base}/import-formats/${f.name}/mappings`, { rules: f.mappings });
  }
  const runs = [];
  for (const imp of model.imports) {
    const f = await upload(base, imp.file, read(imp.file), 'import');
    runs.push(await call('POST', `${base}/import-formats/${imp.format}/run`, { file_id: f.file_id, mode: imp.mode }));
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Fernhollow sample data
// ---------------------------------------------------------------------------

/** Small deterministic PRNG so every seed produces the same numbers. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fiscal months Jul..Jun.
const SEASON: Record<string, number[]> = {
  Sauces: [1.1, 1.05, 0.95, 1.0, 1.15, 1.25, 0.85, 0.85, 0.95, 1.0, 1.05, 1.1],
  'Spice Blends': [0.95, 0.95, 1.0, 1.05, 1.3, 1.4, 0.8, 0.8, 0.9, 0.95, 0.95, 0.95],
  'Cold Brew': [1.35, 1.3, 1.05, 0.85, 0.75, 0.7, 0.7, 0.75, 0.9, 1.05, 1.2, 1.4],
};

const PRODUCTS: { name: string; family: keyof typeof SEASON; cases: number; price: number }[] = [
  { name: 'Smoked Chipotle Sauce', family: 'Sauces', cases: 3500, price: 44 },
  { name: 'Garlic Habanero Sauce', family: 'Sauces', cases: 2750, price: 46 },
  { name: 'Tamarind Glaze', family: 'Sauces', cases: 1750, price: 52 },
  { name: 'Coastal Rub', family: 'Spice Blends', cases: 2250, price: 38 },
  { name: "Za'atar Blend", family: 'Spice Blends', cases: 1625, price: 41 },
  { name: 'Smoky Paprika Rub', family: 'Spice Blends', cases: 2000, price: 36 },
  { name: 'Original Concentrate', family: 'Cold Brew', cases: 4000, price: 58 },
  { name: 'Oat Vanilla Concentrate', family: 'Cold Brew', cases: 3000, price: 64 },
];

const ENTITY_SCALE: Record<string, Record<string, number>> = {
  'Portland Kitchen': { Sauces: 1, 'Spice Blends': 1, 'Cold Brew': 1 },
  'Savannah Kitchen': { Sauces: 0.8, 'Spice Blends': 0.7, 'Cold Brew': 0.6 },
  'Vancouver Co-Pack': { Sauces: 0.2, 'Spice Blends': 0.3, 'Cold Brew': 0.9 },
};

const CHANNELS: { name: string; share: number; price: number; trade: number; returns: number; freight: number }[] = [
  { name: 'Regional Grocery', share: 0.28, price: 1, trade: 0.09, returns: 0.012, freight: 0.05 },
  { name: 'National Grocery', share: 0.34, price: 0.97, trade: 0.12, returns: 0.012, freight: 0.045 },
  { name: 'Foodservice', share: 0.18, price: 0.88, trade: 0.04, returns: 0.008, freight: 0.05 },
  { name: 'Online Store', share: 0.14, price: 1.35, trade: 0, returns: 0.025, freight: 0.09 },
  { name: 'Subscription Boxes', share: 0.06, price: 1.25, trade: 0, returns: 0.015, freight: 0.08 },
];

const REVENUE_ROWS = [
  'Cases Sold', 'Average Price per Case', 'Gross Sales', 'Trade Promotions', 'Returns & Allowances',
  'Ingredients', 'Packaging', 'Direct Labor', 'Freight & Warehousing',
];

// Headcount by department and entity, and average annual salary (USD; no FX in the MVP).
const HEADCOUNT: Record<string, Record<string, number>> = {
  'Portland Kitchen': { Production: 22, 'Quality Assurance': 5, 'Supply Chain': 6, Sales: 7, Marketing: 4, 'Customer Care': 4, Finance: 5, 'People & Culture': 2, Technology: 4 },
  'Savannah Kitchen': { Production: 16, 'Quality Assurance': 3, 'Supply Chain': 4, Sales: 3 },
  'Vancouver Co-Pack': { Production: 6, 'Quality Assurance': 1, 'Supply Chain': 2, Sales: 2 },
};
const SALARY: Record<string, number> = {
  Production: 52_000, 'Quality Assurance': 61_000, 'Supply Chain': 68_000, Sales: 82_000, Marketing: 88_000,
  'Customer Care': 50_000, Finance: 95_000, 'People & Culture': 85_000, Technology: 120_000,
};
const FACILITIES: Record<string, number> = { 'Portland Kitchen': 42_000, 'Savannah Kitchen': 30_000, 'Vancouver Co-Pack': 12_000 };
const OPEX_ROWS = [
  'Headcount', 'Salaries & Wages', 'Benefits & Payroll Taxes', 'Marketing Programs', 'Travel & Meals',
  'Software & Subscriptions', 'Facilities & Utilities', 'Professional Fees', 'Interest Expense', 'Other Income',
];

const r2 = (n: number) => Math.round(n * 100) / 100;

export interface SeedStats {
  submits: number;
  cells: number;
}

/**
 * FY26 Actual (Final) and FY27 Budget (Working): revenue and cost of sales by entity, product
 * and channel; operating expenses and headcount by entity and department.
 */
export async function seedFernhollowData(call: Call, appId: string): Promise<SeedStats> {
  const base = `/v1/apps/${appId}`;
  const stats: SeedStats = { submits: 0, cells: 0 };
  const cases: { scenario: string; version: string; years: string; growth: number; noise: number; seed: number }[] = [
    { scenario: 'Actual', version: 'Final', years: 'FY26', growth: 1, noise: 0.06, seed: 26 },
    { scenario: 'Budget', version: 'Working', years: 'FY27', growth: 1.08, noise: 0.015, seed: 27 },
  ];

  async function submit(pov: Record<string, string>, rows: string[], fill: (row: string, m: number) => number | null) {
    const grid = await call('POST', `${base}/grid/read`, {
      cube: 'Plan',
      pov,
      rows: { dimension: 'Account', members: rows },
      columns: { dimension: 'Period', members: ['@leaves(YearTotal)'] },
    });
    let n = 0;
    const values = grid.rows.members.map((row: { name: string }, i: number) =>
      grid.columns.members.map((_: unknown, m: number) => {
        if (!grid.writable[i][m]) return grid.values[i][m];
        const v = fill(row.name, m);
        if (v !== null) n++;
        return v;
      }),
    );
    if (n === 0) return;
    await call('POST', `${base}/grid/submit`, { grid_session_id: grid.grid_session_id, values, comment: 'sample data' });
    stats.submits++;
    stats.cells += n;
  }

  for (const sc of cases) {
    const rand = mulberry32(sc.seed);
    const jitter = () => 1 + (rand() * 2 - 1) * sc.noise;
    const head = { Scenario: sc.scenario, Version: sc.version, Years: sc.years };

    // Revenue and cost of sales.
    for (const [entity, scale] of Object.entries(ENTITY_SCALE)) {
      for (const ch of CHANNELS) {
        for (const p of PRODUCTS) {
          const monthly = SEASON[p.family]!.map((s) => {
            const casesSold = Math.round(p.cases * scale[p.family]! * ch.share * s * sc.growth * jitter());
            const price = r2(p.price * ch.price * (sc.scenario === 'Budget' ? 1.03 : 1));
            const gross = r2(casesSold * price);
            const ingredients = p.family === 'Cold Brew' ? 0.22 : 0.27;
            return {
              'Cases Sold': casesSold,
              'Average Price per Case': price,
              'Gross Sales': gross,
              'Trade Promotions': r2(gross * ch.trade),
              'Returns & Allowances': r2(gross * ch.returns),
              Ingredients: r2(gross * ingredients * jitter()),
              Packaging: r2(gross * 0.09),
              'Direct Labor': r2(gross * 0.075 * jitter()),
              'Freight & Warehousing': r2(gross * ch.freight),
            } as Record<string, number>;
          });
          await submit(
            { ...head, Entity: entity, Department: 'No Department', Product: p.name, Channel: ch.name },
            REVENUE_ROWS,
            (row, m) => monthly[m]![row] || null,
          );
        }
      }
    }

    // Operating expenses and headcount.
    for (const [entity, depts] of Object.entries(HEADCOUNT)) {
      for (const [dept, hc] of Object.entries(depts)) {
        await submit(
          { ...head, Entity: entity, Department: dept, Product: 'No Product', Channel: 'No Channel' },
          OPEX_ROWS,
          (row, m) => {
            const salaries = (hc * SALARY[dept]! * sc.growth) / 12;
            switch (row) {
              case 'Headcount': return hc;
              case 'Salaries & Wages': return r2(salaries * jitter());
              case 'Benefits & Payroll Taxes': return r2(salaries * 0.24);
              case 'Marketing Programs': return dept === 'Marketing' ? r2(30_000 * SEASON.Sauces![m]! * sc.growth * jitter()) : null;
              case 'Travel & Meals': return dept === 'Sales' ? r2(6_000 * hc / 7 * jitter()) : r2(400 * jitter());
              case 'Software & Subscriptions': return dept === 'Technology' ? r2(18_000 * sc.growth) : ['Finance', 'People & Culture'].includes(dept) ? 1_200 : null;
              case 'Facilities & Utilities': return dept === 'Production' ? r2(FACILITIES[entity]! * jitter()) : null;
              case 'Professional Fees': return dept === 'Finance' ? r2(9_000 + (m === 2 ? 25_000 : 0)) : null;
              case 'Interest Expense': return dept === 'Finance' && entity === 'Portland Kitchen' ? 14_000 : null;
              case 'Other Income': return dept === 'Finance' && entity === 'Portland Kitchen' ? r2(1_500 * jitter()) : null;
              default: return null;
            }
          },
        );
      }
    }
  }
  return stats;
}
