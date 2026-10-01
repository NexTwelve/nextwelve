import { strToU8, zipSync } from 'fflate';
import type { ZodError } from 'zod';
import type { Client, SessionContext } from './db.js';
import { HttpError } from './errors.js';
import { type Cell, parseCsv, readXlsx, type Sheet, unzipLimited } from './files/tables.js';
import { csvUnguard, writeCsv, writeXlsx, type XCell, type XSheet } from './files/xlsx.js';
import { FormDefinition, saveForm } from './forms.js';
import { type AxisSegment, axisOf, MAX_AXIS_DIMS } from './grid/axis.js';
import { type AppContext, type CubeInfo, loadCube, lockForEdit, resolveMembers } from './model.js';
import { ReportDefinition, saveReport } from './reports.js';

/**
 * Form and report definitions as two flat tables people can edit in Excel or as CSV:
 *   Definitions  one row per form or report: its cube, folder and display options
 *   Layout       one row per dimension placement: POV, Page, Rows or Columns, with member selections
 */
export type Kind = 'form' | 'report';
export const KINDS: Kind[] = ['form', 'report'];

export const DEF_COLUMNS = [
  'Type', 'Name', 'Cube', 'Folder', 'Description', 'Read Only', 'Instructions', 'Title',
  'Suppress Missing Rows', 'Suppress Missing Columns', 'Decimals', 'Scale', 'Labels', 'Action',
] as const;
export const LAYOUT_COLUMNS = ['Type', 'Name', 'Axis', 'Order', 'Dimension', 'Members'] as const;

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_DEFINITIONS = 5000;
const MAX_LAYOUT_ROWS = 100_000;
/** Selections per dimension placement (and per Layout cell). */
const MAX_SELECTIONS = 1000;
/** Excel holds at most 32,767 characters in a cell: longer selection lists continue on the next row. */
const MAX_CELL_TEXT = 8000;
const MAX_ERRORS = 200;

export interface StoredDefinition {
  id: string;
  kind: Kind;
  name: string;
  /** The name as the database folds case. */
  lname: string;
  cube: string;
  folder: string | null;
  description: string | null;
  definition: Record<string, unknown>;
  version: number;
}

export async function loadDefinitions(c: Client, appId: string, kinds: Kind[] = KINDS, names?: string[]): Promise<StoredDefinition[]> {
  const res = await c.query<StoredDefinition>(
    `select * from (
       select f.form_id as id, 'form' as kind, f.name, lower(f.name) as lname, cu.name as cube, f.folder, f.description, f.definition, f.version
         from epm.form f join epm.cube cu on cu.cube_id = f.cube_id where f.app_id = $1
       union all
       select r.report_id, 'report', r.name, lower(r.name), cu.name, r.folder, r.description, r.definition, r.version
         from epm.report r join epm.cube cu on cu.cube_id = r.cube_id where r.app_id = $1
     ) d
     where d.kind = any($2::text[]) and ($3::text[] is null or d.lname in (select lower(x) from unnest($3::text[]) x))
     order by d.kind, d.folder nulls first, d.lname`,
    [appId, kinds, names ?? null],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// Member selections in one cell: comma-separated, names with commas in "double quotes"
// ---------------------------------------------------------------------------

/** Split at commas outside parentheses and double quotes; unquote "quoted" entries. */
export function splitMembers(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cur += '""'; i++; continue; }
      if (ch === '"') quoted = false;
      cur += ch;
      continue;
    }
    if (ch === '"') { quoted = true; cur += ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')' && depth > 0) depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(unquote).filter((x) => x !== '');
}

function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/""/g, '"');
  // @Children("A, B") -> @Children(A, B)
  const fn = /^(@\w+)\(\s*"(.*)"\s*\)$/.exec(t);
  if (fn) return `${fn[1]}(${fn[2]!.replace(/""/g, '"')})`;
  return t;
}

/** Whether an entry must be written in quotes to come back from splitMembers unchanged. */
function needsQuotes(m: string): boolean {
  const back = splitMembers(m);
  if (back.length !== 1 || back[0] !== m) return true;
  if (m.includes('"')) return true;
  let depth = 0;
  for (const ch of m) {
    if (ch === '(') depth++;
    if (ch === ')') { if (depth === 0) return true; depth--; }
  }
  return depth !== 0;
}

/** The inverse of splitMembers: quote any entry that would not come back unchanged. */
export function joinMembers(list: string[]): string {
  return list.map((m) => (needsQuotes(m) ? `"${m.replace(/"/g, '""')}"` : m)).join(', ');
}

/** A selection list in pieces short enough for one spreadsheet cell each. */
function memberCells(list: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const m of list) {
    const piece = joinMembers([m]);
    if (cur.length && len + piece.length + 2 > MAX_CELL_TEXT) { out.push(joinMembers(cur)); cur = []; len = 0; }
    cur.push(m);
    len += piece.length + 2;
  }
  if (cur.length) out.push(joinMembers(cur));
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

const yesNo = (b: unknown) => (b ? 'Yes' : 'No');
const SCALE_NAMES: Record<number, string> = { 1: 'Units', 1000: 'Thousands', 1000000: 'Millions' };
const LABEL_NAMES: Record<string, string> = { name: 'Name', alias: 'Alias', both: 'Both' };
const TYPE_NAMES: Record<Kind, string> = { form: 'Form', report: 'Report' };

export interface DefinitionTables {
  definitions: (string | number | null)[][];
  layout: (string | number | null)[][];
}

/** POV and page keys in the cube's dimension order (jsonb does not keep key order). */
function inCubeOrder(cube: CubeInfo | undefined, rec: Record<string, unknown> | undefined): [string, unknown][] {
  const entries = Object.entries(rec ?? {});
  if (!cube) return entries;
  const pos = new Map(cube.dims.map((d, i) => [d.name.toLowerCase(), i]));
  return entries.sort((a, b) => (pos.get(a[0].toLowerCase()) ?? 99) - (pos.get(b[0].toLowerCase()) ?? 99));
}

export async function definitionTables(c: Client, appId: string, defs: StoredDefinition[]): Promise<DefinitionTables> {
  if (defs.length > MAX_DEFINITIONS) {
    throw new HttpError(422, `there are ${defs.length} definitions; export at most ${MAX_DEFINITIONS} at a time, by type (?type=form or report) or by name`);
  }
  const cubes = new Map<string, CubeInfo>();
  for (const name of new Set(defs.map((d) => d.cube))) cubes.set(name, await loadCube(c, appId, name));
  const definitions: DefinitionTables['definitions'] = [[...DEF_COLUMNS]];
  const layout: DefinitionTables['layout'] = [[...LAYOUT_COLUMNS]];
  for (const d of defs) {
    const def = d.definition as Record<string, unknown>;
    const isReport = d.kind === 'report';
    definitions.push([
      TYPE_NAMES[d.kind], d.name, d.cube, d.folder, d.description,
      isReport ? null : yesNo(def.read_only),
      (def.instructions as string | undefined) ?? null,
      isReport ? ((def.title as string | undefined) ?? null) : null,
      isReport ? yesNo(def.suppress_missing_rows ?? true) : null,
      isReport ? yesNo(def.suppress_missing_columns ?? false) : null,
      isReport ? Number(def.decimals ?? 0) : null,
      isReport ? SCALE_NAMES[Number(def.scale ?? 1)] ?? 'Units' : null,
      isReport ? LABEL_NAMES[String(def.labels ?? 'name')] ?? 'Name' : null,
      null,
    ]);
    const cube = cubes.get(d.cube);
    const type = TYPE_NAMES[d.kind];
    let n = 0;
    for (const [dim, m] of inCubeOrder(cube, def.pov as Record<string, unknown>)) layout.push([type, d.name, 'POV', ++n, dim, joinMembers([String(m)])]);
    n = 0;
    for (const [dim, m] of inCubeOrder(cube, def.page as Record<string, unknown>)) {
      n++;
      for (const cell of memberCells(m as string[])) layout.push([type, d.name, 'Page', n, dim, cell]);
    }
    axisOf(def.rows).forEach((seg, i) => { for (const cell of memberCells(seg.members)) layout.push([type, d.name, 'Rows', i + 1, seg.dimension, cell]); });
    axisOf(def.columns).forEach((seg, i) => { for (const cell of memberCells(seg.members)) layout.push([type, d.name, 'Columns', i + 1, seg.dimension, cell]); });
  }
  return { definitions, layout };
}

const README: string[][] = [
  ['NexTwelve form and report definitions'],
  [''],
  ['Edit the Definitions and Layout sheets, then import the workbook (or either sheet saved as CSV).'],
  ['Rows are matched to existing forms and reports by Type and Name. Nothing is deleted unless its Action is Delete.'],
  [''],
  ['Definitions sheet: one row per form or report'],
  ['Type', 'Form or Report'],
  ['Name', 'Unique within its type'],
  ['Cube', 'The cube it reads (required for a new definition)'],
  ['Folder, Description', 'Optional'],
  ['Read Only', 'Forms: Yes or No'],
  ['Instructions', 'Optional text shown above the grid'],
  ['Title', 'Reports: the heading (defaults to the name)'],
  ['Suppress Missing Rows / Columns', 'Reports: Yes or No (rows default Yes, columns No)'],
  ['Decimals', 'Reports: 0 to 6'],
  ['Scale', 'Reports: Units, Thousands or Millions'],
  ['Labels', 'Reports: Name, Alias or Both'],
  ['Action', 'Blank to create or update; Delete to remove the definition'],
  ['A row here replaces that definition\'s settings: a blank cell means no value (or the default); a column left out of the sheet keeps what is saved.'],
  [''],
  ['Layout sheet: one row per dimension placement'],
  ['Type, Name', 'Which definition the row belongs to'],
  ['Axis', 'POV (one fixed member), Page (choices the user picks from), Rows or Columns'],
  ['Order', 'Position on Rows or Columns, outermost first (up to 3 dimensions per axis)'],
  ['Dimension', 'Dimension name'],
  ['Members', 'Comma-separated: member names or @Children(X), @IChildren(X), @Descendants(X), @IDescendants(X), @Leaves(X)'],
  ['', 'Put a name that contains a comma, a double quote or an unmatched parenthesis in "double quotes" (a quote inside doubled: "12"" Pipe").'],
  ['', 'A long list may continue on the next row: same Type, Name, Axis, Order and Dimension.'],
  ['If a definition has any Layout rows, they replace its whole layout; every dimension of its cube must be placed exactly once.'],
  ['A definition with no Layout rows in the file keeps the layout it has.'],
];

export function definitionsXlsx(t: DefinitionTables): Uint8Array {
  const bold = (rows: (string | number | null)[][]): XCell[][] => rows.map((r, i) => (i === 0 ? r.map((v) => ({ v, bold: true })) : r));
  const sheets: XSheet[] = [
    { name: 'Definitions', rows: bold(t.definitions), widths: [8, 28, 12, 16, 32, 10, 32, 24, 12, 12, 9, 11, 8, 8], freeze: { rows: 1, cols: 0 } },
    { name: 'Layout', rows: bold(t.layout), widths: [8, 28, 9, 7, 16, 60], freeze: { rows: 1, cols: 0 } },
    { name: 'Read Me', rows: README.map((r, i) => (i === 0 ? [{ v: r[0]!, bold: true }] : r)), widths: [34, 100] },
  ];
  return writeXlsx(sheets);
}

export function definitionsZip(t: DefinitionTables): Uint8Array {
  return zipSync(
    {
      'definitions.csv': strToU8(writeCsv(t.definitions)),
      'layout.csv': strToU8(writeCsv(t.layout)),
      'README.txt': strToU8(README.map((r) => r.filter(Boolean).join(': ')).join('\r\n')),
    },
    { level: 6 },
  );
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportError {
  sheet: string;
  row: number | null;
  column?: string;
  definition?: string;
  message: string;
}

export interface ImportFile {
  name: string;
  data: Uint8Array;
}

interface ParsedTable {
  sheet: string;
  kind: 'definitions' | 'layout';
  /** Read from a CSV file (so formula guards are taken off again). */
  csv: boolean;
  /** Lower-cased header -> column index. */
  cols: Map<string, number>;
  rows: { row: number; cells: Cell[] }[];
}

const headerKey = (c: Cell) => csvUnguard(String(c ?? '').replace(/^﻿/, '')).trim().toLowerCase();

/** The header is the first row (of the first 20) that names the columns of either table. */
function classify(sheet: Sheet, csv: boolean): ParsedTable | null {
  for (let i = 0; i < Math.min(sheet.rows.length, 20); i++) {
    const cols = new Map<string, number>();
    (sheet.rows[i] ?? []).forEach((c, j) => {
      const key = headerKey(c);
      if (key && !cols.has(key)) cols.set(key, j);
    });
    let kind: ParsedTable['kind'] | null = null;
    if (cols.has('axis') && cols.has('dimension')) kind = 'layout';
    else if (cols.has('type') && cols.has('name')) kind = 'definitions';
    if (!kind) continue;
    const rows: ParsedTable['rows'] = [];
    sheet.rows.forEach((cells, n) => {
      if (n <= i) return;
      if (!cells.some((c) => c !== null && String(c).trim() !== '')) return;
      rows.push({ row: n + 1, cells });
    });
    return { sheet: sheet.name, kind, csv, cols, rows };
  }
  return null;
}

/** CSV bytes as text: UTF-8 only (a file in another encoding would silently change names). */
function csvText(name: string, data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new HttpError(422, `${name} is not UTF-8 text; in Excel, save it as "CSV UTF-8"`);
  }
}

/** Comma, semicolon (Excel in many European locales) or tab, whichever the first line uses most. */
function csvDelimiter(text: string): string {
  const first = text.replace(/^﻿/, '').split(/\r\n|\r|\n/).find((l) => l.trim() !== '') ?? '';
  const outside = first.replace(/"[^"]*"/g, '');
  const counts = [',', ';', '\t'].map((d) => [d, outside.split(d).length - 1] as const);
  return counts.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

function csvSheet(name: string, data: Uint8Array): Sheet {
  const text = csvText(name, data);
  return { ...parseCsv(text, csvDelimiter(text)), name };
}

/** Workbook, zip of CSVs, or single CSVs -> the Definitions and Layout tables found. */
export function readImportFiles(files: ImportFile[]): ParsedTable[] {
  if (files.length === 0) throw new HttpError(422, 'upload a .xlsx workbook, a .zip of CSV files, or the CSV files');
  if (files.length > 4) throw new HttpError(422, 'upload at most four files');
  const total = files.reduce((n, f) => n + f.data.byteLength, 0);
  if (total > MAX_IMPORT_BYTES) throw new HttpError(413, 'definition files are limited to 5 MB');
  const sheets: { sheet: Sheet; csv: boolean; from: string }[] = [];
  for (const f of files) {
    if (/\.xlsx$/i.test(f.name)) {
      for (const sheet of readXlsx(f.data)) sheets.push({ sheet, csv: false, from: `${f.name}, sheet ${sheet.name}` });
    } else if (/\.zip$/i.test(f.name)) {
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipLimited(f.data, (n) => /\.csv$/i.test(n) && !n.startsWith('__MACOSX/'), MAX_IMPORT_BYTES * 4, 'the zip is too large once uncompressed', 413);
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(422, `${f.name} is not a valid zip file`);
      }
      for (const [path, data] of Object.entries(entries)) {
        const name = path.split('/').pop()!.replace(/\.csv$/i, '');
        sheets.push({ sheet: csvSheet(name, data), csv: true, from: `${path} in ${f.name}` });
      }
    } else if (/\.(csv|txt)$/i.test(f.name)) {
      sheets.push({ sheet: csvSheet(f.name.replace(/\.[^.]+$/, ''), f.data), csv: true, from: f.name });
    } else {
      throw new HttpError(422, `${f.name}: upload a .xlsx workbook, a .zip of CSV files, or .csv files`);
    }
  }
  const tables: ParsedTable[] = [];
  for (const { sheet, csv, from } of sheets) {
    const t = classify(sheet, csv);
    if (t) { tables.push(t); continue; }
    // Anything else that holds data is an error rather than silently left out (except a read-me).
    const hasData = sheet.rows.some((r) => r.some((c) => c !== null && String(c).trim() !== ''));
    if (hasData && !/^read ?me$/i.test(sheet.name.trim())) {
      throw new HttpError(422, `${from}: no Definitions or Layout header in its first 20 rows; keep the header row from an export`);
    }
  }
  if (!tables.length) throw new HttpError(422, 'no Definitions or Layout sheet found; keep the header row from an export');
  if (tables.filter((t) => t.kind === 'definitions').length > 1 || tables.filter((t) => t.kind === 'layout').length > 1) {
    throw new HttpError(422, 'upload one Definitions sheet and one Layout sheet at most');
  }
  return tables;
}

/** A cell as text; formula guards come off for CSV. `trim` is off for free text (descriptions, instructions). */
function cellText(v: Cell | undefined, csv: boolean, trim = true): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  const t = csv ? csvUnguard(v) : v;
  return trim ? t.trim() : t;
}

function parseBool(text: string): boolean | undefined | 'bad' {
  const t = text.toLowerCase();
  if (t === '') return undefined;
  if (['yes', 'y', 'true', '1'].includes(t)) return true;
  if (['no', 'n', 'false', '0'].includes(t)) return false;
  return 'bad';
}

type Where = { sheet: string; row: number };
type Axis4 = 'pov' | 'page' | 'rows' | 'columns';

interface LayoutRow extends Where { axis: Axis4; order: number; seq: number; dimension: string; members: string[] }

interface Draft {
  kind: Kind;
  name: string;
  key: string;
  props?: Where & {
    cube: string | undefined;
    folder: string | null | undefined;
    description: string | null | undefined;
    /** Settings in the row: a value, null (blank: back to the default), or absent (column missing: kept). */
    settings: Record<string, unknown>;
  };
  action: 'upsert' | 'delete';
  layout: LayoutRow[];
  firstRow: Where;
}

export interface ImportResult {
  dry_run: boolean;
  created: { type: Kind; name: string }[];
  updated: { type: Kind; name: string; version: number }[];
  unchanged: { type: Kind; name: string }[];
  deleted: { type: Kind; name: string }[];
  errors: ImportError[];
}

function zodMessages(err: ZodError): string {
  return err.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'definition'}: ${i.message}`).join('; ');
}

/** A saved definition as the import would write it (defaults filled, axes as lists), for comparing. */
function normalized(kind: Kind, def: unknown): unknown {
  const parsed = (kind === 'form' ? FormDefinition : ReportDefinition).safeParse(def);
  return parsed.success ? parsed.data : def;
}

function sameJson(a: unknown, b: unknown): boolean {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v;
  return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const PLACEMENT_KEYS = ['pov', 'page', 'rows', 'columns'];
/** Definitions-sheet columns that hold settings, and the setting each one sets. */
const SETTING_COLUMNS: Record<string, string> = {
  'read only': 'read_only', instructions: 'instructions', title: 'title', 'suppress missing rows': 'suppress_missing_rows',
  'suppress missing columns': 'suppress_missing_columns', decimals: 'decimals', scale: 'scale', labels: 'labels',
};
const AXIS_NAMES: Record<string, Axis4> = { pov: 'pov', page: 'page', row: 'rows', rows: 'rows', column: 'columns', columns: 'columns', col: 'columns', cols: 'columns' };
const AXIS_LABEL: Record<Axis4, string> = { pov: 'POV', page: 'Page', rows: 'Rows', columns: 'Columns' };

/**
 * Check every row, then (unless dry_run, and only with no errors) apply everything in the caller's
 * transaction. Names match as the database matches them (Postgres lower()).
 */
export async function importDefinitions(c: Client, s: SessionContext, app: AppContext, tables: ParsedTable[], dryRun: boolean): Promise<ImportResult> {
  const errors: ImportError[] = [];
  const err = (e: ImportError) => { if (errors.length < MAX_ERRORS) errors.push(e); };
  const kindOf = (text: string): Kind | null => (/^forms?$/i.test(text) ? 'form' : /^reports?$/i.test(text) ? 'report' : null);

  const defTable = tables.find((t) => t.kind === 'definitions');
  const layoutTable = tables.find((t) => t.kind === 'layout');
  if ((defTable?.rows.length ?? 0) > MAX_DEFINITIONS) throw new HttpError(422, `at most ${MAX_DEFINITIONS} definitions per import`);
  if ((layoutTable?.rows.length ?? 0) > MAX_LAYOUT_ROWS) throw new HttpError(422, `at most ${MAX_LAYOUT_ROWS} layout rows per import`);
  if (layoutTable) {
    for (const name of ['type', 'name', 'axis', 'dimension', 'members']) {
      if (!layoutTable.cols.has(name)) throw new HttpError(422, `the Layout sheet has no ${name[0]!.toUpperCase()}${name.slice(1)} column`);
    }
  }

  // Name keys the way the database folds case.
  const names = new Set<string>();
  for (const t of tables) {
    const at = t.cols.get('name');
    if (at === undefined) continue;
    for (const r of t.rows) { const n = cellText(r.cells[at], t.csv); if (n) names.add(n); }
  }
  const lower = new Map((await c.query<{ n: string; l: string }>('select n, lower(n) as l from unnest($1::text[]) n', [[...names]])).rows.map((r) => [r.n, r.l]));
  const keyOf = (kind: Kind, name: string) => `${kind}\u0000${lower.get(name) ?? name.toLowerCase()}`;
  const drafts = new Map<string, Draft>();
  const draft = (kind: Kind, name: string, at: Where) => {
    const key = keyOf(kind, name);
    let d = drafts.get(key);
    if (!d) { d = { kind, name, key, action: 'upsert', layout: [], firstRow: at }; drafts.set(key, d); }
    return d;
  };

  if (defTable) {
    const has = (name: string) => defTable.cols.has(name);
    const col = (r: Cell[], name: string, trim = true) => cellText(has(name) ? r[defTable.cols.get(name)!] : undefined, defTable.csv, trim);
    for (const { row, cells } of defTable.rows) {
      const at = { sheet: defTable.sheet, row };
      const kind = kindOf(col(cells, 'type'));
      const name = col(cells, 'name');
      if (!kind) { err({ ...at, column: 'Type', message: 'Type must be Form or Report' }); continue; }
      if (!name) { err({ ...at, column: 'Name', message: 'Name is required' }); continue; }
      if (CONTROL.test(name)) { err({ ...at, column: 'Name', message: 'names cannot contain control characters' }); continue; }
      const d = draft(kind, name, at);
      if (d.props || d.action === 'delete') { err({ ...at, column: 'Name', message: `${TYPE_NAMES[kind]} ${name} appears more than once` }); continue; }
      const action = col(cells, 'action').toLowerCase();
      if (action && action !== 'delete') { err({ ...at, column: 'Action', message: 'Action must be blank or Delete' }); continue; }
      if (action === 'delete') { d.action = 'delete'; d.firstRow = at; continue; }
      const settings: Record<string, unknown> = {};
      const present = (column: string) => has(column.toLowerCase());
      const bool = (column: string) => {
        if (!present(column)) return;
        const v = parseBool(col(cells, column.toLowerCase()));
        if (v === 'bad') err({ ...at, column, message: `${column} must be Yes or No` });
        else settings[SETTING_COLUMNS[column.toLowerCase()]!] = v ?? null;
      };
      const text = (column: string, max: number) => {
        if (!present(column)) return;
        const v = col(cells, column.toLowerCase(), false);
        if (v.length > max) err({ ...at, column, message: `${column} is longer than ${max} characters` });
        else if (CONTROL.test(v)) err({ ...at, column, message: `${column} cannot contain control characters` });
        else settings[SETTING_COLUMNS[column.toLowerCase()]!] = v === '' ? null : v;
      };
      text('Instructions', 2000);
      if (kind === 'form') {
        bool('Read Only');
        for (const c2 of ['Title', 'Suppress Missing Rows', 'Suppress Missing Columns', 'Decimals', 'Scale', 'Labels']) {
          if (col(cells, c2.toLowerCase())) err({ ...at, column: c2, message: `${c2} applies to reports only` });
        }
      } else {
        if (col(cells, 'read only') && parseBool(col(cells, 'read only')) !== true) err({ ...at, column: 'Read Only', message: 'reports are always read-only' });
        text('Title', 200);
        bool('Suppress Missing Rows');
        bool('Suppress Missing Columns');
        if (present('Decimals')) {
          const dec = col(cells, 'decimals');
          const n = Number(dec);
          if (dec && (!Number.isInteger(n) || n < 0 || n > 6)) err({ ...at, column: 'Decimals', message: 'Decimals must be a whole number from 0 to 6' });
          else settings.decimals = dec ? n : null;
        }
        if (present('Scale')) {
          const scale = col(cells, 'scale').toLowerCase();
          const v = ({ units: 1, '1': 1, thousands: 1000, '1000': 1000, millions: 1000000, '1000000': 1000000 } as Record<string, number>)[scale];
          if (scale && !v) err({ ...at, column: 'Scale', message: 'Scale must be Units, Thousands or Millions' });
          else settings.scale = scale ? v : null;
        }
        if (present('Labels')) {
          const labels = col(cells, 'labels').toLowerCase();
          if (labels && !['name', 'alias', 'both'].includes(labels)) err({ ...at, column: 'Labels', message: 'Labels must be Name, Alias or Both' });
          else settings.labels = labels || null;
        }
      }
      const free = (column: string, max: number): string | null | undefined => {
        if (!present(column)) return undefined;
        const v = col(cells, column.toLowerCase(), false);
        if (v.length > max) { err({ ...at, column, message: `${column} is longer than ${max} characters` }); return undefined; }
        if (CONTROL.test(v)) { err({ ...at, column, message: `${column} cannot contain control characters` }); return undefined; }
        return v === '' ? null : v;
      };
      d.props = {
        ...at,
        cube: present('Cube') ? col(cells, 'cube') || undefined : undefined,
        folder: free('Folder', 200),
        description: free('Description', 2000),
        settings,
      };
    }
  }

  if (layoutTable) {
    const col = (r: Cell[], name: string) => cellText(layoutTable.cols.has(name) ? r[layoutTable.cols.get(name)!] : undefined, layoutTable.csv);
    let seq = 0;
    for (const { row, cells } of layoutTable.rows) {
      const at = { sheet: layoutTable.sheet, row };
      const kind = kindOf(col(cells, 'type'));
      const name = col(cells, 'name');
      if (!kind) { err({ ...at, column: 'Type', message: 'Type must be Form or Report' }); continue; }
      if (!name) { err({ ...at, column: 'Name', message: 'Name is required' }); continue; }
      const axis = AXIS_NAMES[col(cells, 'axis').toLowerCase()];
      if (!axis) { err({ ...at, column: 'Axis', message: 'Axis must be POV, Page, Rows or Columns' }); continue; }
      const dimension = col(cells, 'dimension');
      if (!dimension) { err({ ...at, column: 'Dimension', message: 'Dimension is required' }); continue; }
      const members = splitMembers(col(cells, 'members'));
      if (members.length === 0) { err({ ...at, column: 'Members', message: 'Members is required' }); continue; }
      if (members.length > MAX_SELECTIONS || members.some((m) => m.length > 400)) {
        err({ ...at, column: 'Members', message: `at most ${MAX_SELECTIONS} selections of 400 characters each` });
        continue;
      }
      const orderText = col(cells, 'order');
      const order = orderText === '' ? Number.MAX_SAFE_INTEGER : Number(orderText);
      if (!Number.isFinite(order)) { err({ ...at, column: 'Order', message: 'Order must be a number' }); continue; }
      draft(kind, name, at).layout.push({ axis, order, seq: seq++, dimension, members, ...at });
    }
  }

  // Member selections resolve once per dimension and expression, however often they appear.
  const resolved = new Map<string, { n: number } | { error: string }>();
  const resolveOne = async (dim: { dimId: number }, expr: string) => {
    const k = `${dim.dimId}\u0000${expr}`;
    let r = resolved.get(k);
    if (!r) {
      try {
        r = { n: (await resolveMembers(c, dim as never, [expr])).length };
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        r = { error: e.message };
      }
      resolved.set(k, r);
    }
    return r;
  };
  const cubes = new Map<string, CubeInfo | string>();
  const cubeNamed = async (name: string): Promise<CubeInfo | string> => {
    const k = name.toLowerCase();
    if (!cubes.has(k)) {
      try {
        cubes.set(k, await loadCube(c, app.appId, name));
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        cubes.set(k, e.message);
      }
    }
    return cubes.get(k)!;
  };

  // Assemble each definition against what exists today.
  const existing = new Map((await loadDefinitions(c, app.appId)).map((d) => [`${d.kind}\u0000${d.lname}`, d]));
  type Ready = { d: Draft; cube: CubeInfo; body: { cube: string; folder?: string; description?: string; definition: Record<string, unknown> }; old?: StoredDefinition };
  const ready: Ready[] = [];
  const deletes: StoredDefinition[] = [];
  for (const d of drafts.values()) {
    const old = existing.get(d.key);
    const label = `${TYPE_NAMES[d.kind]} ${d.name}`;
    const where = { sheet: d.firstRow.sheet, row: d.firstRow.row, definition: label };
    if (d.action === 'delete') {
      if (d.layout.length) err({ ...where, message: `${label} is marked Delete but has Layout rows` });
      else if (!old) err({ ...where, message: `${label} does not exist, so it cannot be deleted` });
      else deletes.push(old);
      continue;
    }
    if (!old && !d.props) { err({ ...where, message: `${label} does not exist; add it to the Definitions sheet` }); continue; }
    if (!old && !d.layout.length) { err({ ...where, message: `${label} is new, so it needs Layout rows` }); continue; }
    if (!old && d.name.length > 200) { err({ ...where, column: 'Name', message: 'names are at most 200 characters' }); continue; }
    const cubeName = d.props?.cube || old?.cube || '';
    if (!cubeName) { err({ ...where, column: 'Cube', message: 'Cube is required for a new definition' }); continue; }
    const cube = await cubeNamed(cubeName);
    if (typeof cube === 'string') { err({ ...where, column: 'Cube', message: cube }); continue; }
    const oldDef = (old ? normalized(d.kind, old.definition) : {}) as Record<string, unknown>;

    // Placements: from the Layout rows when there are any (they replace the whole layout), else the saved ones.
    type Placed = { axis: Axis4; order: number; seq: number; dimension: string; members: string[]; rows: Where[] };
    const placed = new Map<string, Placed>();
    let bad = false;
    if (d.layout.length) {
      for (const l of d.layout) {
        const k = l.dimension.toLowerCase();
        const p = placed.get(k);
        if (!p) { placed.set(k, { axis: l.axis, order: l.order, seq: l.seq, dimension: l.dimension, members: [...l.members], rows: [l] }); continue; }
        // A dimension continued on the next row (same axis, same order) adds to its selections.
        if (p.axis === l.axis && (l.axis === 'page' || (l.axis !== 'pov' && p.order === l.order))) {
          p.members.push(...l.members);
          p.rows.push(l);
          continue;
        }
        err({ sheet: l.sheet, row: l.row, column: 'Dimension', definition: label, message: `${l.dimension} is placed twice (${AXIS_LABEL[p.axis]} and ${AXIS_LABEL[l.axis]})` });
        bad = true;
      }
    } else {
      const add = (axis: Axis4, dimension: string, members: string[], order: number) =>
        placed.set(dimension.toLowerCase(), { axis, order, seq: order, dimension, members, rows: [] });
      for (const [dim, m] of Object.entries((oldDef.pov ?? {}) as Record<string, string>)) add('pov', dim, [m], 0);
      for (const [dim, m] of Object.entries((oldDef.page ?? {}) as Record<string, string[]>)) add('page', dim, m, 0);
      axisOf(oldDef.rows).forEach((seg, i) => add('rows', seg.dimension, seg.members, i));
      axisOf(oldDef.columns).forEach((seg, i) => add('columns', seg.dimension, seg.members, i));
    }
    if (bad) continue;
    // Every placement against the cube, each problem on the row that has it.
    const notInCube: string[] = [];
    for (const p of placed.values()) {
      const at = p.rows[0] ? { sheet: p.rows[0].sheet, row: p.rows[0].row } : { sheet: where.sheet, row: where.row };
      const dim = cube.dims.find((x) => x.name.toLowerCase() === p.dimension.toLowerCase());
      if (!dim && !p.rows.length) { notInCube.push(p.dimension); bad = true; continue; }
      if (!dim) { err({ ...at, column: 'Dimension', definition: label, message: `cube ${cube.name} has no dimension ${p.dimension}` }); bad = true; continue; }
      p.dimension = dim.name;
      if (p.members.length > MAX_SELECTIONS) { err({ ...at, column: 'Members', definition: label, message: `${dim.name} has more than ${MAX_SELECTIONS} selections` }); bad = true; continue; }
      for (const expr of p.members) {
        const r = await resolveOne(dim, expr);
        const rowOf = p.rows.length > 1 ? (p.rows.find((x) => (x as LayoutRow).members.includes(expr)) ?? p.rows[0]!) : (p.rows[0] ?? at);
        if ('error' in r) { err({ sheet: rowOf.sheet, row: rowOf.row, column: 'Members', definition: label, message: r.error }); bad = true; }
        else if (p.axis === 'pov' && (r.n !== 1 || p.members.length !== 1)) {
          err({ sheet: rowOf.sheet, row: rowOf.row, column: 'Members', definition: label, message: `a POV dimension takes exactly one member; ${expr} gives ${r.n}` });
          bad = true;
        }
      }
    }
    if (notInCube.length) err({ ...where, column: 'Cube', message: `${label} places ${notInCube.join(', ')}, which cube ${cube.name} does not have` });
    const missing = cube.dims.filter((x) => !placed.has(x.name.toLowerCase())).map((x) => x.name);
    if (missing.length) { err({ ...where, message: `${label} does not place ${missing.join(', ')}` }); bad = true; }
    const axes: Record<'rows' | 'columns', Placed[]> = { rows: [], columns: [] };
    for (const p of placed.values()) if (p.axis === 'rows' || p.axis === 'columns') axes[p.axis].push(p);
    for (const a of ['rows', 'columns'] as const) {
      if (axes[a].length === 0) { err({ ...where, message: `${label} has nothing on ${AXIS_LABEL[a]}` }); bad = true; }
      if (axes[a].length > MAX_AXIS_DIMS) { err({ ...where, message: `${label} has more than ${MAX_AXIS_DIMS} dimensions on ${AXIS_LABEL[a]}` }); bad = true; }
    }
    if (bad) continue;
    const pov: Record<string, string> = {};
    const page: Record<string, string[]> = {};
    for (const p of placed.values()) {
      if (p.axis === 'pov') pov[p.dimension] = p.members[0]!;
      if (p.axis === 'page') page[p.dimension] = p.members;
    }
    const seg = (list: Placed[]): AxisSegment[] => [...list].sort((x, y) => x.order - y.order || x.seq - y.seq).map((p) => ({ dimension: p.dimension, members: p.members }));
    const placement = { pov, page, rows: seg(axes.rows), columns: seg(axes.columns) };

    // Settings: columns in the Definitions row replace the saved ones (blank = the default); columns
    // the sheet does not have keep what is saved.
    const settings: Record<string, unknown> = Object.fromEntries(Object.entries(oldDef).filter(([k]) => !PLACEMENT_KEYS.includes(k)));
    for (const [k, v] of Object.entries(d.props?.settings ?? {})) {
      if (v === null) delete settings[k];
      else settings[k] = v;
    }
    const parsed = (d.kind === 'form' ? FormDefinition : ReportDefinition).safeParse({ ...settings, ...placement });
    if (!parsed.success) { err({ ...where, message: zodMessages(parsed.error) }); continue; }
    const folder = d.props?.folder !== undefined ? d.props.folder : (old?.folder ?? null);
    const description = d.props?.description !== undefined ? d.props.description : (old?.description ?? null);
    ready.push({
      d,
      cube,
      old,
      body: { cube: cube.name, folder: folder ?? undefined, description: description ?? undefined, definition: parsed.data as Record<string, unknown> },
    });
  }

  const result: ImportResult = { dry_run: dryRun, created: [], updated: [], unchanged: [], deleted: [], errors };
  const sameText = (a: string | null | undefined, b: string | null | undefined) => (a || null) === (b || null);
  const unchanged = new Set<Ready>();
  for (const r of ready) {
    const same = r.old && r.old.cube === r.cube.name && sameText(r.old.folder, r.body.folder) && sameText(r.old.description, r.body.description)
      && sameJson(normalized(r.d.kind, r.old.definition), r.body.definition);
    if (!r.old) result.created.push({ type: r.d.kind, name: r.d.name });
    else if (same) { result.unchanged.push({ type: r.d.kind, name: r.old.name }); unchanged.add(r); }
    else result.updated.push({ type: r.d.kind, name: r.old.name, version: r.old.version + 1 });
  }
  result.deleted = deletes.map((d) => ({ type: d.kind, name: d.name }));
  if (errors.length || dryRun) return result;

  await lockForEdit(c, app.appId);
  for (const r of ready) {
    if (unchanged.has(r)) continue;
    const name = r.old?.name ?? r.d.name;
    const saved = r.d.kind === 'form'
      ? await saveForm(c, s, app.appId, name, r.body as never)
      : await saveReport(c, s, app.appId, name, r.body as never);
    const u = result.updated.find((x) => x.type === r.d.kind && x.name === name);
    if (u) u.version = saved.version;
  }
  for (const d of deletes) await c.query(`delete from epm.${d.kind} where ${d.kind}_id = $1`, [d.id]);
  await c.query(
    `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'definitions_imported', $4)`,
    [s.tenantId, app.appId, s.userId, {
      created: result.created.length, updated: result.updated.length, deleted: result.deleted.length,
      names: [...result.created, ...result.updated, ...result.deleted].slice(0, 100),
    }],
  );
  return result;
}
