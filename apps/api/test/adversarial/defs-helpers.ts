/**
 * Helpers for the definition export/import and history adversarial suites (not a test file itself).
 */
import { strToU8, zipSync } from 'fflate';
import pg from 'pg';
import { readXlsx } from '../../src/files/tables.js';
import { writeCsv, writeXlsx } from '../../src/files/xlsx.js';
import { Api, type Harness, createHarness, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

export type Rows = (string | number | boolean | null)[][];

export const DEF_HEADER = ['Type', 'Name', 'Cube', 'Folder', 'Description', 'Read Only', 'Instructions', 'Title',
  'Suppress Missing Rows', 'Suppress Missing Columns', 'Decimals', 'Scale', 'Labels', 'Action'];
export const LAYOUT_HEADER = ['Type', 'Name', 'Axis', 'Order', 'Dimension', 'Members'];

/** A form definition that places every dimension of the Plan cube. */
export const BASIC_DEF = {
  pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Department: 'Sales', Entity: 'East' },
  page: { Product: ['Widgets', 'Gadgets'] },
  rows: [{ dimension: 'Account', members: ['Revenue', 'COGS'] }],
  columns: [{ dimension: 'Period', members: ['Jan', 'Feb'] }],
};

export interface DefsEnv {
  h: Harness;
  admin: Api;
  tenantId: string;
  appId: string;
  base: string;
}

export async function defsEnv(tenant: string, extraProducts: string[] = []): Promise<DefsEnv> {
  const h = await createHarness();
  const domain = `${tenant.toLowerCase()}.test`;
  const tenantId = await provisionTenant(h.db, tenant, null, `admin@${domain}`);
  const admin = await signIn(h, `admin@${domain}`);
  const appId = await seedPlanApp(admin);
  const base = `/v1/apps/${appId}`;
  if (extraProducts.length) {
    const res = await admin.put(`${base}/dimensions/Product/members`, { members: extraProducts.map((name) => ({ name, parent: 'All Products' })) });
    if (res.status !== 200) throw new Error(`adding products failed: ${JSON.stringify(res.body)}`);
    const dep = await admin.post(`${base}/deploy`);
    if (dep.status !== 200) throw new Error(`deploy failed: ${JSON.stringify(dep.body)}`);
  }
  return { h, admin, tenantId, appId, base };
}

export async function exportDefs(api: Api, base: string, query = '') {
  return api.raw('GET', `${base}/definitions/export${query}`);
}

export function sheets(bytes: Uint8Array): Record<string, Rows> {
  return Object.fromEntries(readXlsx(bytes).map((s) => [s.name, s.rows])) as Record<string, Rows>;
}

export async function importDefs(api: Api, base: string, name: string, data: Uint8Array | string, dryRun = false) {
  const r = await api.raw('POST', `${base}/definitions/import?name=${encodeURIComponent(name)}${dryRun ? '&dry_run=true' : ''}`, data, 'application/octet-stream');
  return { status: r.status, body: r.json };
}

export function workbook(defs: Rows | null, layout: Rows | null): Uint8Array {
  const out = [];
  if (defs) out.push({ name: 'Definitions', rows: defs as never });
  if (layout) out.push({ name: 'Layout', rows: layout as never });
  return writeXlsx(out);
}

export function csvZip(defs: Rows | null, layout: Rows | null): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  if (defs) files['definitions.csv'] = strToU8(writeCsv(defs as never));
  if (layout) files['layout.csv'] = strToU8(writeCsv(layout as never));
  return zipSync(files);
}

/** Layout rows for a definition object (as the export would write them, modulo member quoting). */
export function layoutFor(type: 'Form' | 'Report', name: string, def: { pov?: Record<string, string>; page?: Record<string, string[]>; rows: { dimension: string; members: string[] }[]; columns: { dimension: string; members: string[] }[] }): Rows {
  const out: Rows = [];
  let n = 0;
  for (const [d, m] of Object.entries(def.pov ?? {})) out.push([type, name, 'POV', ++n, d, m.includes(',') ? `"${m}"` : m]);
  n = 0;
  for (const [d, m] of Object.entries(def.page ?? {})) out.push([type, name, 'Page', ++n, d, m.map((x) => (x.includes(',') ? `"${x}"` : x)).join(', ')]);
  def.rows.forEach((s, i) => out.push([type, name, 'Rows', i + 1, s.dimension, s.members.join(', ')]));
  def.columns.forEach((s, i) => out.push([type, name, 'Columns', i + 1, s.dimension, s.members.join(', ')]));
  return out;
}

/** A Definitions row with only Type, Name and Cube filled (other settings blank). */
export function defRow(type: string, name: string, cube: string | null = 'Plan', extra: Record<string, string | number | null> = {}): (string | number | null)[] {
  return DEF_HEADER.map((col) => (col === 'Type' ? type : col === 'Name' ? name : col === 'Cube' ? cube : (extra[col] ?? null)));
}

/** Run SQL as the database superuser with the tenant set, so history triggers (forced RLS) still work. */
export async function asTenant<T = any>(h: Harness, tenantId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const su = new pg.Client({ connectionString: h.db.superUrl });
  await su.connect();
  try {
    await su.query('begin');
    await su.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const res = await su.query(sql, params);
    await su.query('commit');
    return res.rows as T[];
  } finally {
    await su.end();
  }
}

/** How much definition state is stored (superuser view, no RLS). */
export async function stored(h: Harness): Promise<{ forms: number; reports: number; versions: number; imports: number }> {
  const su = new pg.Client({ connectionString: h.db.superUrl });
  await su.connect();
  try {
    const r = await su.query(`select (select count(*) from epm.form)::int as forms, (select count(*) from epm.report)::int as reports,
                                     (select count(*) from epm.artifact_version)::int as versions,
                                     (select count(*) from epm.security_event where event_type = 'definitions_imported')::int as imports`);
    return r.rows[0];
  } finally {
    await su.end();
  }
}

/** A user with a role on an app, signed in. */
export async function userWithRole(env: DefsEnv, email: string, role: string, appId = env.appId): Promise<Api> {
  const u = await env.admin.post('/v1/users', { email });
  if (u.status !== 201 && u.status !== 409) throw new Error(`invite failed: ${JSON.stringify(u.body)}`);
  const r = await env.admin.post(`/v1/apps/${appId}/roles`, { email, role });
  if (r.status !== 200) throw new Error(`role failed: ${JSON.stringify(r.body)}`);
  return signIn(env.h, email);
}
