import { z } from 'zod';
import type { Client, SessionContext } from './db.js';
import { maybeOne } from './db.js';
import { HttpError } from './errors.js';
import type { BlobStore } from './files/blobs.js';
import { type Cell, cellText, readSheets, type Table, toTable } from './files/tables.js';

/**
 * Datasets keep a spreadsheet as reference data: each upload of a workbook (or CSV) is a new
 * version, and every sheet becomes a table of rows keyed by column name. Mapping rules read them
 * today; rules, forms and validations can read them later through the same lookups.
 */
export const DatasetBody = z.object({
  file_id: z.uuid(),
  description: z.string().max(2000).optional(),
  header_row: z.number().int().min(0).default(1),
});

export interface SheetSummary {
  name: string;
  columns: string[];
  rows: number;
}

export interface StoredFile {
  file_id: string;
  name: string;
  storage_key: string;
}

export async function loadStoredFile(c: Client, appId: string, fileId: string): Promise<StoredFile> {
  const f = await maybeOne<StoredFile>(
    c,
    'select file_id, name, storage_key from epm.stored_file where app_id = $1 and file_id = $2',
    [appId, fileId],
  );
  if (!f) throw new HttpError(404, 'file not found');
  return f;
}

export async function readStoredFile(blobs: BlobStore, file: StoredFile): Promise<Uint8Array> {
  const bytes = await blobs.get(file.storage_key);
  if (!bytes) throw new HttpError(410, `the bytes of ${file.name} are no longer in storage; upload it again`);
  return bytes;
}

async function insertRows(c: Client, tenantId: string, datasetId: string, version: number, sheet: string, table: Table) {
  const CHUNK = 2000;
  for (let i = 0; i < table.records.length; i += CHUNK) {
    const chunk = table.records.slice(i, i + CHUNK).map((r) => ({ row_no: r.row_no, data: r.values }));
    await c.query(
      `insert into epm.dataset_row (tenant_id, dataset_id, version, sheet, row_no, data)
       select $1, $2, $3, $4, (r->>'row_no')::int, r->'data' from jsonb_array_elements($5::jsonb) r`,
      [tenantId, datasetId, version, sheet, JSON.stringify(chunk)],
    );
  }
}

/** Parse an uploaded file and store it as the next version of a dataset (created on first use). */
export async function publishDatasetVersion(
  c: Client,
  blobs: BlobStore,
  appId: string,
  session: SessionContext,
  name: string,
  body: z.infer<typeof DatasetBody>,
): Promise<{ name: string; version: number; sheets: SheetSummary[] }> {
  const file = await loadStoredFile(c, appId, body.file_id);
  const sheets = readSheets(file.name, await readStoredFile(blobs, file));
  const tables = sheets.map((s) => ({ name: s.name, table: toTable(s, body.header_row) }));

  await c.query(
    `insert into epm.dataset (tenant_id, app_id, name, description) values ($1, $2, $3, $4)
     on conflict (app_id, lower(name)) do update set description = coalesce(excluded.description, epm.dataset.description)`,
    [session.tenantId, appId, name, body.description ?? null],
  );
  const ds = await maybeOne<{ dataset_id: string; name: string; version: number }>(
    c,
    `update epm.dataset set current_version = current_version + 1
      where app_id = $1 and lower(name) = lower($2)
      returning dataset_id, name, current_version as version`,
    [appId, name],
  );
  const summary: SheetSummary[] = tables.map((t) => ({ name: t.name, columns: t.table.columns, rows: t.table.records.length }));
  await c.query(
    `insert into epm.dataset_version (tenant_id, dataset_id, version, file_id, sheets, uploaded_by)
     values ($1, $2, $3, $4, $5, $6)`,
    [session.tenantId, ds!.dataset_id, ds!.version, file.file_id, JSON.stringify(summary), session.userId],
  );
  for (const t of tables) await insertRows(c, session.tenantId, ds!.dataset_id, ds!.version, t.name, t.table);
  return { name: ds!.name, version: ds!.version, sheets: summary };
}

export interface DatasetRef {
  dataset_id: string;
  name: string;
  version: number;
  sheets: SheetSummary[];
}

/** A dataset at a version (default: current). */
export async function resolveDataset(c: Client, appId: string, name: string, version?: number): Promise<DatasetRef> {
  const ref = await maybeOne<DatasetRef>(
    c,
    `select d.dataset_id, d.name, v.version, v.sheets
       from epm.dataset d join epm.dataset_version v on v.dataset_id = d.dataset_id
      where d.app_id = $1 and lower(d.name) = lower($2) and v.version = coalesce($3, d.current_version)`,
    [appId, name, version ?? null],
  );
  if (!ref) throw new HttpError(404, `dataset ${name}${version ? ` version ${version}` : ''} not found`);
  return ref;
}

export function pickSheet(ref: DatasetRef, sheet?: string): SheetSummary {
  const s = sheet ? ref.sheets.find((x) => x.name.toLowerCase() === sheet.toLowerCase()) : ref.sheets[0];
  if (!s) throw new HttpError(422, `dataset ${ref.name} has no sheet ${sheet}; sheets are ${ref.sheets.map((x) => x.name).join(', ')}`);
  return s;
}

function columnOf(sheet: SheetSummary, ref: string): string {
  const col = sheet.columns.find((c) => c.toLowerCase() === ref.toLowerCase());
  if (!col) throw new HttpError(422, `sheet ${sheet.name} has no column ${ref}; columns are ${sheet.columns.join(', ')}`);
  return col;
}

/** All rows of one sheet as a table (used when an import reads a dataset instead of a file). */
export async function datasetTable(c: Client, ref: DatasetRef, sheetName?: string): Promise<Table> {
  const sheet = pickSheet(ref, sheetName);
  const res = await c.query<{ row_no: number; data: Record<string, Cell> }>(
    'select row_no, data from epm.dataset_row where dataset_id = $1 and version = $2 and sheet = $3 order by row_no',
    [ref.dataset_id, ref.version, sheet.name],
  );
  return { columns: sheet.columns, records: res.rows.map((r) => ({ row_no: r.row_no, values: r.data })) };
}

/** key column -> value column, for mapping rules and (later) rule lookups. Keys match case-insensitively. */
export async function datasetLookup(
  c: Client,
  ref: DatasetRef,
  sheetName: string | undefined,
  keyColumn: string,
  valueColumn: string,
): Promise<Map<string, string>> {
  const sheet = pickSheet(ref, sheetName);
  const key = columnOf(sheet, keyColumn);
  const value = columnOf(sheet, valueColumn);
  const res = await c.query<{ k: Cell; v: Cell }>(
    `select data->$4 as k, data->$5 as v from epm.dataset_row where dataset_id = $1 and version = $2 and sheet = $3`,
    [ref.dataset_id, ref.version, sheet.name, key, value],
  );
  const map = new Map<string, string>();
  for (const r of res.rows) {
    const k = cellText(r.k);
    if (k !== '' && !map.has(k.toLowerCase())) map.set(k.toLowerCase(), cellText(r.v));
  }
  return map;
}
