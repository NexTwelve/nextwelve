import { strToU8, zipSync } from 'fflate';

/**
 * A small .xlsx writer: inline strings, numbers, bold headers, number formats, column widths and
 * frozen panes. Enough for report output and definition workbooks; no formulas are ever written,
 * so text that looks like a formula stays text.
 */
export type XCell =
  | string
  | number
  | null
  | { v: string | number | null; bold?: boolean; decimals?: number; indent?: number };

export interface XSheet {
  name: string;
  rows: XCell[][];
  /** Column widths in characters, by column index. */
  widths?: number[];
  /** Keep this many rows and columns in view when scrolling. */
  freeze?: { rows: number; cols: number };
}

const MAX_DECIMALS = 6;
// Styles: 0 plain, 1 bold, 2..8 numbers with 0..6 decimals, 9..15 bold numbers, 16.. indented text.
const NUM = (d: number) => 2 + d;
const BOLD_NUM = (d: number) => 2 + MAX_DECIMALS + 1 + d;
const MAX_INDENT = 15;
const INDENT = (n: number) => 2 + 2 * (MAX_DECIMALS + 1) + n - 1;

// XML 1.0 forbids most control characters even when escaped.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function xmlEscape(s: string): string {
  return s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function columnLetters(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Cut to at most n UTF-16 units (Excel counts those) without splitting a surrogate pair. */
function cutUtf16(text: string, n: number): string {
  if (text.length <= n) return text;
  let cut = text.slice(0, n);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut;
}

/** Excel sheet names: 1 to 31 UTF-16 units, none of []:*?/\, no apostrophe at either end, unique. */
export function sheetName(wanted: string, taken: Set<string>): string {
  const tidy = (x: string) => x.replace(/^['\s]+|['\s]+$/g, '');
  const base = tidy(cutUtf16(tidy(wanted.replace(/[[\]:*?/\\]/g, ' ').replace(INVALID_XML, '')), 31)) || 'Sheet';
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` ${n}`;
    name = `${tidy(cutUtf16(base, 31 - suffix.length)) || 'Sheet'}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

function cellXml(ref: string, cell: XCell): string {
  if (cell === null || cell === undefined) return '';
  const c = typeof cell === 'object' ? cell : { v: cell };
  if (c.v === null || c.v === undefined || c.v === '') {
    return c.bold ? `<c r="${ref}" s="1"/>` : '';
  }
  if (typeof c.v === 'number') {
    if (!Number.isFinite(c.v)) return '';
    const d = Math.max(0, Math.min(MAX_DECIMALS, c.decimals ?? 0));
    const style = c.decimals === undefined && !c.bold ? 0 : c.bold ? BOLD_NUM(d) : NUM(d);
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${c.v}</v></c>`;
  }
  const indent = Math.max(0, Math.min(MAX_INDENT, Math.floor(c.indent ?? 0)));
  const style = c.bold ? 1 : indent > 0 ? INDENT(indent) : 0;
  const text = xmlEscape(c.v);
  const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t${space}>${text}</t></is></c>`;
}

function sheetXml(sheet: XSheet): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  if (sheet.freeze && (sheet.freeze.rows > 0 || sheet.freeze.cols > 0)) {
    const { rows, cols } = sheet.freeze;
    const topLeft = `${columnLetters(cols)}${rows + 1}`;
    const pane = rows > 0 && cols > 0 ? 'bottomRight' : rows > 0 ? 'bottomLeft' : 'topRight';
    out.push(
      `<sheetViews><sheetView workbookViewId="0"><pane${cols ? ` xSplit="${cols}"` : ''}${rows ? ` ySplit="${rows}"` : ''} topLeftCell="${topLeft}" activePane="${pane}" state="frozen"/></sheetView></sheetViews>`,
    );
  }
  if (sheet.widths?.length) {
    out.push('<cols>');
    sheet.widths.forEach((w, i) => {
      if (w > 0) out.push(`<col min="${i + 1}" max="${i + 1}" width="${Math.min(120, Math.max(4, w))}" customWidth="1"/>`);
    });
    out.push('</cols>');
  }
  out.push('<sheetData>');
  sheet.rows.forEach((row, r) => {
    const cells = row.map((cell, c) => cellXml(`${columnLetters(c)}${r + 1}`, cell)).join('');
    out.push(`<row r="${r + 1}">${cells}</row>`);
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

function stylesXml(): string {
  const fmts = Array.from({ length: MAX_DECIMALS + 1 }, (_, d) => `<numFmt numFmtId="${164 + d}" formatCode="${d ? `#,##0.${'0'.repeat(d)}` : '#,##0'}"/>`);
  const xfs: string[] = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>',
  ];
  for (let d = 0; d <= MAX_DECIMALS; d++) xfs.push(`<xf numFmtId="${164 + d}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`);
  for (let d = 0; d <= MAX_DECIMALS; d++) xfs.push(`<xf numFmtId="${164 + d}" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>`);
  for (let n = 1; n <= MAX_INDENT; n++) xfs.push(`<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment indent="${n}"/></xf>`);
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    `<numFmts count="${fmts.length}">${fmts.join('')}</numFmts>`,
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>',
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
    `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`,
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '</styleSheet>',
  ].join('');
}

export function writeXlsx(sheets: XSheet[]): Uint8Array {
  const taken = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, taken) }));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
        '</Types>',
    ),
    '_rels/.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>',
    ),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
        named.map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        '</Relationships>',
    ),
    'xl/styles.xml': strToU8(stylesXml()),
  };
  named.forEach((s, i) => (files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s))));
  return zipSync(files, { level: 6 });
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Text Excel would run as a formula when the CSV is opened (=, +, -, @, tab, CR) gets a leading
 * apostrophe. Text that already starts with apostrophes before such a character gets one more, so
 * reading our own CSV back (csvUnguard: one apostrophe off) always returns the original text.
 */
const FORMULA_START = /^'*[=+\-@\t\r]/;

export function csvGuard(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** Undo csvGuard. Only for text read from a CSV file. */
export function csvUnguard(text: string): string {
  return text.length > 1 && text[0] === "'" && FORMULA_START.test(text.slice(1)) ? text.slice(1) : text;
}

export function writeCsv(rows: (string | number | null)[][]): string {
  const field = (v: string | number | null) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    const s = csvGuard(v.replace(INVALID_XML, ''));
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // A byte-order mark so Excel reads UTF-8 names correctly.
  return `﻿${rows.map((r) => r.map(field).join(',')).join('\r\n')}\r\n`;
}
