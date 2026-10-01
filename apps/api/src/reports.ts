import { z } from 'zod';
import type { Client, SessionContext } from './db.js';
import { maybeOne } from './db.js';
import { HttpError } from './errors.js';
import { definitionName, resolvePage, Text, validatePlacement } from './forms.js';
import { Axis, axisOf, resolveAxis, tupleCount, tuples } from './grid/axis.js';
import { type AxisView, accessFor, aggregate, axisView, checkAxes, resolvePov } from './grid/read.js';
import { shiftRound } from './files/decimal.js';
import { type XCell, type XSheet, writeCsv } from './files/xlsx.js';
import { type AppContext, type CubeInfo, type DimInfo, type MemberRef, loadCube } from './model.js';

/** Combinations read before suppressing empty rows and columns. */
export const MAX_REPORT_CELLS = 250_000;

/**
 * A saved read-only report: like a form (every dimension of the cube placed once, in the POV, as
 * a page choice, or on rows or columns), with one to three dimensions per axis and display options.
 */
export const ReportDefinition = z.object({
  pov: z.record(z.string(), z.string().min(1).max(400)).default({}),
  page: z.record(z.string(), z.array(z.string().min(1).max(400)).min(1).max(1000)).default({}),
  rows: Axis,
  columns: Axis,
  suppress_missing_rows: z.boolean().default(true),
  suppress_missing_columns: z.boolean().default(false),
  decimals: z.number().int().min(0).max(6).default(0),
  /** Shown in units, thousands or millions. */
  scale: z.union([z.literal(1), z.literal(1000), z.literal(1000000)]).default(1),
  labels: z.enum(['name', 'alias', 'both']).default('name'),
  title: Text(200).optional(),
  instructions: Text(2000).optional(),
});
export type ReportDefinition = z.infer<typeof ReportDefinition>;

export const ReportBody = z.object({
  cube: z.string().min(1),
  folder: Text(200).optional(),
  description: Text(2000).optional(),
  definition: ReportDefinition,
});
export type ReportBody = z.infer<typeof ReportBody>;

export const RunBody = z.object({ page: z.record(z.string(), z.string()).default({}) });

export interface ReportRow {
  report_id: string;
  name: string;
  folder: string | null;
  description: string | null;
  cube: string;
  definition: ReportDefinition;
  version: number;
  updated_at: string;
}

export async function loadReport(c: Client, appId: string, name: string): Promise<ReportRow> {
  const row = await maybeOne<ReportRow>(
    c,
    `select r.report_id, r.name, r.folder, r.description, cu.name as cube, r.definition, r.version, r.updated_at
       from epm.report r join epm.cube cu on cu.cube_id = r.cube_id
      where r.app_id = $1 and lower(r.name) = lower($2)`,
    [appId, name],
  );
  if (!row) throw new HttpError(404, `report ${name} not found`);
  return row;
}

export async function validateReport(c: Client, appId: string, body: ReportBody): Promise<CubeInfo> {
  const cube = await loadCube(c, appId, body.cube);
  await validatePlacement(c, cube, body.definition, 'the report');
  return cube;
}

export async function saveReport(c: Client, s: SessionContext, appId: string, rawName: string, body: ReportBody) {
  const name = await definitionName(c, 'report', appId, rawName);
  const cube = await validateReport(c, appId, body);
  const res = await c.query<{ name: string; version: number }>(
    `insert into epm.report (tenant_id, app_id, cube_id, name, folder, description, definition, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (app_id, lower(name)) do update
        set cube_id = excluded.cube_id, folder = excluded.folder, description = excluded.description,
            definition = excluded.definition, updated_by = excluded.updated_by, updated_at = now()
     returning name, version`,
    [s.tenantId, appId, cube.cubeId, name, body.folder || null, body.description || null, body.definition, s.userId],
  );
  return res.rows[0]!;
}

export interface ReportResult {
  report: { name: string; folder: string | null; description: string | null; title: string; version: number; cube: string };
  page: Record<string, { selected: string; options: string[] }>;
  pov: Record<string, string>;
  rows: AxisView;
  columns: AxisView;
  /** Scaled and rounded as the report shows them; null = no data. */
  values: (number | null)[][];
  display: { decimals: number; scale: number; labels: 'name' | 'alias' | 'both' };
  suppressed: { rows: number; columns: number };
}

const label = (m: { name: string; alias: string | null }, how: 'name' | 'alias' | 'both') =>
  how === 'name' || !m.alias ? m.name : how === 'alias' ? m.alias : `${m.name} - ${m.alias}`;

export async function runReport(c: Client, app: AppContext, session: SessionContext, report: ReportRow, chosen: Record<string, string>): Promise<ReportResult> {
  const def = ReportDefinition.parse(report.definition);
  const cube = await loadCube(c, app.appId, report.cube);
  const access = await accessFor(c, app, session, cube);
  const { page, pov: povNames } = await resolvePage(c, app, session, cube, def, chosen);
  const keep = (dim: DimInfo, m: MemberRef) => access.canRead(dim, m.id);
  const rowAxis = await resolveAxis(c, cube, axisOf(def.rows), keep);
  const colAxis = await resolveAxis(c, cube, axisOf(def.columns), keep);
  checkAxes(rowAxis, colAxis);
  const pov = await resolvePov(c, cube, [...rowAxis.dims, ...colAxis.dims], povNames, access);
  const n = Math.max(tupleCount(rowAxis), 1) * Math.max(tupleCount(colAxis), 1);
  if (n > MAX_REPORT_CELLS) throw new HttpError(422, `the report has ${n} cells before suppression; the limit is ${MAX_REPORT_CELLS}`);
  let rows = tuples(rowAxis);
  let cols = tuples(colAxis);
  const agg = await aggregate(c, app.appId, cube, pov, rowAxis, colAxis, rows, cols);
  let values = agg.texts;

  const before = { rows: rows.length, cols: cols.length };
  if (def.suppress_missing_rows) {
    const keepRow = values.map((r) => r.some((v) => v !== null));
    rows = rows.filter((_, i) => keepRow[i]);
    values = values.filter((_, i) => keepRow[i]);
  }
  if (def.suppress_missing_columns) {
    const keepCol = cols.map((_, j) => values.some((r) => r[j] !== null));
    cols = cols.filter((_, j) => keepCol[j]);
    values = values.map((r) => r.filter((_, j) => keepCol[j]));
  }
  const shift = Math.round(Math.log10(def.scale));
  const shown = values.map((r) => r.map((v) => (v === null ? null : shiftRound(v, shift, def.decimals))));

  return {
    report: {
      name: report.name,
      folder: report.folder,
      description: report.description,
      title: def.title ?? report.name,
      version: report.version,
      cube: cube.name,
    },
    page,
    pov: Object.fromEntries(pov.map((p) => [p.dim.name, label(p.member, def.labels)])),
    rows: axisView(rowAxis, rows),
    columns: axisView(colAxis, cols),
    values: shown,
    display: { decimals: def.decimals, scale: def.scale, labels: def.labels },
    suppressed: { rows: before.rows - rows.length, columns: before.cols - cols.length },
  };
}

const SCALE_NOTE: Record<number, string> = { 1: '', 1000: 'In thousands', 1000000: 'In millions' };

/** True when tuple j starts the same as tuple j-1 through `level` (so an outer label is not repeated). */
function sameOuter(list: { name: string }[][], j: number, level: number): boolean {
  if (j === 0) return false;
  const a = list[j - 1]!;
  const b = list[j]!;
  for (let q = 0; q <= level; q++) if (a[q]!.name !== b[q]!.name) return false;
  return true;
}

/** The report as rows of cells: title, POV, column headers (one row per column dimension), then data. */
export function reportGrid(r: ReportResult): { cells: XCell[][]; headerRows: number; labelCols: number } {
  const how = r.display.labels;
  const nr = r.rows.dimensions.length;
  const nc = r.columns.dimensions.length;
  const out: XCell[][] = [];
  out.push([{ v: r.report.title, bold: true }]);
  const povLine = Object.entries(r.pov).map(([d, m]) => `${d}: ${m}`).join('   ');
  out.push([povLine || null]);
  if (SCALE_NOTE[r.display.scale]) out.push([SCALE_NOTE[r.display.scale]!]);
  out.push([]);
  for (let level = 0; level < nc; level++) {
    // Row dimension names head the label columns on the last header row.
    const line: XCell[] = r.rows.dimensions.map((d) => (level === nc - 1 ? { v: d, bold: true } : null));
    r.columns.tuples.forEach((t, j) => {
      const repeat = level < nc - 1 && sameOuter(r.columns.tuples, j, level);
      line.push(repeat ? null : { v: label(t[level]!, how), bold: true });
    });
    out.push(line);
  }
  const headerRows = out.length;
  r.rows.tuples.forEach((t, i) => {
    const line: XCell[] = t.map((m, q) =>
      q < nr - 1 && sameOuter(r.rows.tuples, i, q) ? null : { v: label(m, how), indent: q === nr - 1 ? m.level : 0, bold: !m.leaf },
    );
    const total = !t.every((m) => m.leaf);
    for (const v of r.values[i]!) line.push(v === null ? null : { v, decimals: r.display.decimals, bold: total });
    out.push(line);
  });
  return { cells: out, headerRows, labelCols: nr };
}

/** Excel's sheet size. */
export const XLSX_MAX_ROWS = 1_048_576;
export const XLSX_MAX_COLUMNS = 16_384;

export function reportSheet(r: ReportResult): XSheet {
  const cols = r.rows.dimensions.length + r.columns.tuples.length;
  const rows = r.rows.tuples.length + r.columns.dimensions.length + 4;
  if (cols > XLSX_MAX_COLUMNS || rows > XLSX_MAX_ROWS) {
    throw new HttpError(422, `the report is ${rows} rows by ${cols} columns, more than an Excel sheet holds; download it as CSV`);
  }
  const g = reportGrid(r);
  const labelWidths = r.rows.dimensions.map((_, q) => {
    let w = 12;
    for (const t of r.rows.tuples) w = Math.max(w, label(t[q]!, r.display.labels).length + (t[q]!.level ?? 0) * 2);
    return w + 2;
  });
  const widths = [...labelWidths, ...r.columns.tuples.map(() => 14)];
  return { name: r.report.name, rows: g.cells, widths: widths.map((w) => Math.min(60, w)), freeze: { rows: g.headerRows, cols: g.labelCols } };
}

export function reportCsv(r: ReportResult): string {
  const g = reportGrid(r);
  return writeCsv(g.cells.map((row) => row.map((c) => (c === null || typeof c !== 'object' ? c : c.v))));
}
