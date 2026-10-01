import { Unzip, UnzipInflate } from 'fflate';
import { HttpError } from '../errors.js';

/** One cell from a CSV or XLSX file. */
export type Cell = string | number | boolean | null;

export interface Sheet {
  name: string;
  rows: Cell[][];
}

export interface Table {
  columns: string[];
  /** One record per data row, keyed by column name; row_no is the 1-based row in the file. */
  records: { row_no: number; values: Record<string, Cell> }[];
}

/** Uncompressed XLSX parts we are willing to inflate (Workers have 128 MB per isolate). */
const MAX_XLSX_BYTES = 60 * 1024 * 1024;
export const MAX_ROWS = 250_000;

// ---------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, doubled quotes, CR/LF line ends, optional BOM)
// ---------------------------------------------------------------------------
export function parseCsv(text: string, delimiter = ','): Sheet {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows: Cell[][] = [];
  let row: Cell[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const push = () => {
    row.push(field);
    field = '';
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) push();
    else if (ch === '\n' || ch === '\r') {
      push();
      // Blank lines are kept (as empty rows) so row numbers match the file.
      rows.push(row.some((c) => c !== '') ? row : []);
      row = [];
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else field += ch;
    i++;
    if (rows.length > MAX_ROWS) throw new HttpError(422, `file has more than ${MAX_ROWS} rows`);
  }
  if (quoted) throw new HttpError(422, 'CSV has an unterminated quoted field');
  if (field !== '' || row.length) {
    push();
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return { name: 'Sheet1', rows };
}

// ---------------------------------------------------------------------------
// XLSX: a zip of XML parts. Reads cached cell values (formulas are not evaluated);
// dates come through as Excel serial numbers.
// ---------------------------------------------------------------------------
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlText(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? _;
  });
}
function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? xmlText(m[1]!) : undefined;
}
function allText(fragment: string): string {
  let out = '';
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += xmlText(m[1]!);
  return out;
}
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Inflate the wanted entries of a zip, counting the bytes actually produced (not the sizes the
 * zip claims), and stop as soon as they pass maxBytes.
 */
export function unzipLimited(data: Uint8Array, wanted: (name: string) => boolean, maxBytes: number, tooLarge: string, status = 422): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  let total = 0;
  let declared = 0;
  const uz = new Unzip();
  uz.register(UnzipInflate);
  uz.onfile = (file) => {
    if (!wanted(file.name)) return;
    // What the zip claims counts too (a quick refusal), but only the bytes produced are trusted.
    declared += file.originalSize ?? 0;
    if (declared > maxBytes) throw new HttpError(status, tooLarge);
    const parts: Uint8Array[] = [];
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      total += chunk.length;
      if (total > maxBytes) throw new HttpError(status, tooLarge);
      parts.push(chunk);
      if (final) {
        const whole = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
        let at = 0;
        for (const x of parts) { whole.set(x, at); at += x.length; }
        out[file.name] = whole;
      }
    };
    file.start();
  };
  // Small pieces, so no single step inflates more than a few megabytes past the limit.
  const STEP = 4096;
  if (data.length === 0) uz.push(data, true);
  for (let i = 0; i < data.length; i += STEP) uz.push(data.subarray(i, i + STEP), i + STEP >= data.length);
  return out;
}

/** At most this many sheets are read from one workbook. */
const MAX_SHEETS = 64;

export function readXlsx(data: Uint8Array): Sheet[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipLimited(
      data,
      (name) => /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name),
      MAX_XLSX_BYTES,
      'workbook is too large once uncompressed',
    );
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(422, 'file is not a valid .xlsx workbook');
  }
  const dec = new TextDecoder();
  const part = (name: string) => (files[name] ? dec.decode(files[name]) : undefined);
  const workbook = part('xl/workbook.xml');
  if (!workbook) throw new HttpError(422, 'file is not a valid .xlsx workbook');

  const rels = new Map<string, string>();
  for (const m of (part('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }
  const shared: string[] = [];
  for (const m of (part('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(allText(m[1]!));

  const sheets: Sheet[] = [];
  // Each worksheet part is parsed once, however many sheets point at it.
  const parsed = new Map<string, Cell[][]>();
  for (const m of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    if (sheets.length >= MAX_SHEETS) throw new HttpError(422, `workbook has more than ${MAX_SHEETS} sheets`);
    const name = attr(m[0], 'name') ?? `Sheet${sheets.length + 1}`;
    const rid = attr(m[0], 'r:id');
    const path = rid ? rels.get(rid) : undefined;
    if (path && parsed.has(path)) { sheets.push({ name, rows: parsed.get(path)! }); continue; }
    const xml = path ? part(path) : undefined;
    if (!xml) continue;
    const rows: Cell[][] = [];
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rowNo = Number(attr(r[1]!, 'r') ?? rows.length + 1);
      if (!Number.isFinite(rowNo) || rowNo > MAX_ROWS + 1) throw new HttpError(422, `sheet ${name} has more than ${MAX_ROWS} rows`);
      const cells: Cell[] = [];
      for (const c of (r[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[1]!, 'r');
        const col = ref ? columnIndex(ref.replace(/\d+$/, '')) : cells.length;
        const type = attr(c[1]!, 't');
        const body = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: Cell = null;
        if (type === 's') value = v !== undefined ? (shared[Number(v)] ?? null) : null;
        else if (type === 'inlineStr') value = allText(body);
        else if (type === 'str' || type === 'e') value = v !== undefined ? xmlText(v) : null;
        else if (type === 'b') value = v === '1';
        else if (v !== undefined) value = Number(v);
        while (cells.length < col) cells.push(null);
        cells[col] = value;
      }
      while (rows.length < rowNo - 1) rows.push([]);
      rows.push(cells);
      if (rows.length > MAX_ROWS) throw new HttpError(422, `sheet ${name} has more than ${MAX_ROWS} rows`);
    }
    if (path) parsed.set(path, rows);
    sheets.push({ name, rows });
  }
  if (sheets.length === 0) throw new HttpError(422, 'workbook has no readable sheets');
  return sheets;
}

/** Read any supported upload into sheets. */
export function readSheets(fileName: string, data: Uint8Array, delimiter?: string): Sheet[] {
  if (/\.xlsx$/i.test(fileName)) return readXlsx(data);
  if (/\.(csv|txt|tsv)$/i.test(fileName)) {
    const text = new TextDecoder().decode(data);
    const sheet = parseCsv(text, delimiter ?? (/\.tsv$/i.test(fileName) ? '\t' : ','));
    return [{ ...sheet, name: fileName.replace(/\.[^.]+$/, '') }];
  }
  if (/\.xls$/i.test(fileName)) throw new HttpError(422, 'old .xls workbooks are not supported; save as .xlsx');
  throw new HttpError(422, 'upload a .csv, .tsv, .txt or .xlsx file');
}

/** Turn a sheet into named records. headerRow is 1-based; 0 means no header (columns A, B, C...). */
export function toTable(sheet: Sheet, headerRow = 1): Table {
  const width = Math.max(0, ...sheet.rows.map((r) => r.length));
  const letters = (n: number) => {
    let s = '';
    for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const header = headerRow > 0 ? (sheet.rows[headerRow - 1] ?? []) : [];
  const columns: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < width; i++) {
    let name = String(header[i] ?? '').trim() || letters(i);
    const n = seen.get(name.toLowerCase()) ?? 0;
    seen.set(name.toLowerCase(), n + 1);
    if (n > 0) name = `${name} (${n + 1})`;
    columns.push(name);
  }
  const records: Table['records'] = [];
  sheet.rows.forEach((row, idx) => {
    if (idx < headerRow) return;
    if (!row.some((c) => c !== null && c !== '')) return;
    const values: Record<string, Cell> = {};
    columns.forEach((col, i) => (values[col] = row[i] ?? null));
    records.push({ row_no: idx + 1, values });
  });
  return { columns, records };
}

/** Find a column by header name (case-insensitive) or by letter (A, B, ... AA). */
export function findColumn(table: Table, ref: string): string {
  const byName = table.columns.find((c) => c.toLowerCase() === ref.trim().toLowerCase());
  if (byName) return byName;
  if (/^[A-Z]{1,3}$/i.test(ref.trim())) {
    const col = table.columns[columnIndex(ref.trim())];
    if (col) return col;
  }
  throw new HttpError(422, `no column ${ref}; columns are ${table.columns.join(', ')}`);
}

/** Text form of a cell for mapping: numbers without trailing .0, trimmed strings. */
export function cellText(v: Cell): string {
  if (v === null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return String(v).trim();
}

/** Parse an amount: 1,234.50  (1,234.50)  1234.50-  $1,234  -12 */
export function parseAmount(v: Cell): number | null {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return null;
  let s = v.trim().replace(/[$€£,\s]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  }
  if (s === '' || !/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return NaN;
  const n = Number(s);
  return negative ? -n : n;
}
