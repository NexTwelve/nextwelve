import { z } from 'zod';
import { datasetLookup, datasetTable, type DatasetRef, loadStoredFile, readStoredFile, resolveDataset } from './datasets.js';
import type { Client, SessionContext } from './db.js';
import { maybeOne } from './db.js';
import { fromPgError, HttpError } from './errors.js';
import type { BlobStore } from './files/blobs.js';
import { cellText, findColumn, parseAmount, readSheets, type Table, toTable } from './files/tables.js';
import { type AppContext, COORD_LENGTH, type CubeInfo, type DimInfo, loadCube } from './model.js';

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------
const DimSource = z.union([
  z.object({ column: z.string().min(1) }).strict(),
  z.object({ value: z.string().min(1) }).strict(),
]);

/**
 * How a file becomes cells. Every cube dimension takes its member from a column (through the
 * mapping rules) or from a fixed value; a run can override fixed values (e.g. the Scenario).
 */
export const ImportFormatDef = z.object({
  sheet: z.string().optional(),
  delimiter: z.string().length(1).optional(),
  header_row: z.number().int().min(0).default(1),
  dimensions: z.record(z.string(), DimSource),
  amount: z.object({
    column: z.string().min(1),
    flip_sign: z.boolean().default(false),
    scale: z.number().default(1),
  }),
  filters: z
    .array(z.object({ column: z.string(), equals: z.string().optional(), not_equals: z.string().optional() }))
    .default([]),
  skip_zero: z.boolean().default(true),
});
export type ImportFormatDef = z.infer<typeof ImportFormatDef>;

export const ImportFormatBody = z.object({ cube: z.string().min(1), definition: ImportFormatDef });

export const MappingInput = z.object({
  dimension: z.string().min(1),
  rule_type: z.enum(['explicit', 'dataset', 'between', 'in', 'like']),
  source: z.string(),
  target: z.string().min(1),
  options: z.object({ sheet: z.string().optional(), key_column: z.string() }).optional(),
  priority: z.number().int().default(0),
  description: z.string().max(500).optional(),
});
export type MappingInput = z.infer<typeof MappingInput>;
export const MappingsBody = z.object({ replace: z.boolean().default(true), rules: z.array(MappingInput).max(50_000) });

export const RunBody = z
  .object({
    file_id: z.uuid().optional(),
    dataset: z.object({ name: z.string(), sheet: z.string().optional(), version: z.number().int().optional() }).optional(),
    mode: z.enum(['merge', 'replace', 'accumulate']).default('merge'),
    dry_run: z.boolean().default(false),
    load_valid_lines: z.boolean().default(false),
    values: z.record(z.string(), z.string()).default({}),
  })
  .refine((b) => Boolean(b.file_id) !== Boolean(b.dataset), { message: 'give either file_id or dataset' });
export type RunBody = z.infer<typeof RunBody>;

const RULE_ORDER = { explicit: 0, dataset: 1, between: 2, in: 3, like: 4 } as const;
export const SKIP = '#skip';

export interface FormatRow {
  format_id: string;
  name: string;
  cube: string;
  definition: ImportFormatDef;
  version: number;
}

export async function loadFormat(c: Client, appId: string, name: string): Promise<FormatRow> {
  const row = await maybeOne<FormatRow>(
    c,
    `select f.format_id, f.name, cu.name as cube, f.definition, f.version
       from epm.import_format f join epm.cube cu on cu.cube_id = f.cube_id
      where f.app_id = $1 and lower(f.name) = lower($2)`,
    [appId, name],
  );
  if (!row) throw new HttpError(404, `import format ${name} not found`);
  return { ...row, definition: ImportFormatDef.parse(row.definition) };
}

function dimFor(cube: CubeInfo, name: string): DimInfo {
  const d = cube.dims.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!d) throw new HttpError(422, `dimension ${name} is not in cube ${cube.name}`);
  return d;
}

/** Every cube dimension must have a source. */
export async function validateFormat(c: Client, appId: string, body: z.infer<typeof ImportFormatBody>): Promise<CubeInfo> {
  const cube = await loadCube(c, appId, body.cube);
  const given = new Set(Object.keys(body.definition.dimensions).map((k) => dimFor(cube, k).dimId));
  const missing = cube.dims.filter((d) => !given.has(d.dimId)).map((d) => d.name);
  if (missing.length) throw new HttpError(422, `the format gives no source for ${missing.join(', ')}`);
  return cube;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------
interface Rule {
  rule_type: keyof typeof RULE_ORDER;
  source: string;
  target: string;
  options: { sheet?: string; key_column: string } | null;
  lookup?: Map<string, string>;
  pattern?: RegExp;
}

function wildcard(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function inRange(raw: string, source: string): boolean {
  const [lo = '', hi = ''] = source.split('..').map((s) => s.trim());
  const n = Number(raw), a = Number(lo), b = Number(hi);
  if (raw !== '' && lo !== '' && hi !== '' && [n, a, b].every(Number.isFinite)) return n >= a && n <= b;
  return raw >= lo && raw <= hi;
}

/** The member name a source value maps to, SKIP, or null when no rule matches. */
export function mapValue(rules: Rule[], raw: string): string | null {
  for (const r of rules) {
    let hit = false;
    let target = r.target;
    switch (r.rule_type) {
      case 'explicit':
        hit = raw.toLowerCase() === r.source.trim().toLowerCase();
        break;
      case 'dataset': {
        const v = r.lookup!.get(raw.toLowerCase());
        if (v !== undefined && v !== '') {
          hit = true;
          target = v;
        }
        break;
      }
      case 'between':
        hit = inRange(raw, r.source);
        break;
      case 'in':
        hit = r.source.split(',').some((s) => s.trim().toLowerCase() === raw.toLowerCase());
        break;
      case 'like':
        hit = r.pattern!.test(raw);
        break;
    }
    if (hit) return target === '*' ? raw : target;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running an import
// ---------------------------------------------------------------------------
export interface RunResult {
  run_id: string;
  status: 'validated' | 'failed' | 'loaded';
  mode: string;
  dry_run: boolean;
  lines_read: number;
  lines_mapped: number;
  lines_skipped: number;
  lines_rejected: number;
  cells: number;
  txn_id: number | null;
  datasets_used: { dataset: string; version: number }[];
  errors: { line: number; error: string; source: Record<string, unknown> }[];
}

interface Line {
  line_no: number;
  source: Record<string, unknown>;
  coords: number[] | null;
  amount: number | null;
  error: string | null;
}

export async function runImport(
  c: Client,
  blobs: BlobStore,
  app: AppContext,
  session: SessionContext,
  format: FormatRow,
  body: RunBody,
): Promise<RunResult> {
  const def = format.definition;
  const cube = await loadCube(c, app.appId, format.cube);

  // 1. The source table: an uploaded file or a dataset sheet.
  let table: Table;
  let fileId: string | null = null;
  let sourceDataset: { dataset: string; version: number; sheet: string } | null = null;
  if (body.file_id) {
    const file = await loadStoredFile(c, app.appId, body.file_id);
    const sheets = readSheets(file.name, await readStoredFile(blobs, file), def.delimiter);
    const sheet = def.sheet ? sheets.find((s) => s.name.toLowerCase() === def.sheet!.toLowerCase()) : sheets[0];
    if (!sheet) throw new HttpError(422, `${file.name} has no sheet ${def.sheet}`);
    table = toTable(sheet, def.header_row);
    fileId = file.file_id;
  } else {
    const ref = await resolveDataset(c, app.appId, body.dataset!.name, body.dataset!.version);
    table = await datasetTable(c, ref, body.dataset!.sheet);
    sourceDataset = { dataset: ref.name, version: ref.version, sheet: body.dataset!.sheet ?? ref.sheets[0]!.name };
  }

  // 2. Where each dimension's member comes from.
  const overrides = new Map(Object.entries(body.values).map(([k, v]) => [k.toLowerCase(), v]));
  const sources = cube.dims.map((dim) => {
    const key = Object.keys(def.dimensions).find((k) => k.toLowerCase() === dim.name.toLowerCase());
    const src = key ? def.dimensions[key]! : undefined;
    const fixed = overrides.get(dim.name.toLowerCase()) ?? (src && 'value' in src ? src.value : undefined);
    if (fixed !== undefined) return { dim, fixed };
    if (src && 'column' in src) return { dim, column: findColumn(table, src.column) };
    throw new HttpError(422, `no source for ${dim.name}`);
  });
  const amountColumn = findColumn(table, def.amount.column);
  const filters = def.filters.map((f) => ({ ...f, column: findColumn(table, f.column) }));

  // 3. Mapping rules per dimension, in evaluation order, with dataset lookups loaded once.
  const ruleRows = await c.query<Rule & { dimension: string }>(
    `select dimension, rule_type, source, target, options from epm.mapping_rule
      where format_id = $1 order by priority, rule_id`,
    [format.format_id],
  );
  const datasets = new Map<string, DatasetRef>();
  const rulesByDim = new Map<string, Rule[]>();
  for (const r of ruleRows.rows) {
    if (r.rule_type === 'like') r.pattern = wildcard(r.source);
    if (r.rule_type === 'dataset') {
      const ref = datasets.get(r.source.toLowerCase()) ?? (await resolveDataset(c, app.appId, r.source));
      datasets.set(r.source.toLowerCase(), ref);
      r.lookup = await datasetLookup(c, ref, r.options?.sheet, r.options?.key_column ?? '', r.target);
    }
    const list = rulesByDim.get(r.dimension.toLowerCase()) ?? [];
    list.push(r);
    rulesByDim.set(r.dimension.toLowerCase(), list);
  }
  for (const list of rulesByDim.values()) list.sort((a, b) => RULE_ORDER[a.rule_type] - RULE_ORDER[b.rule_type]);

  // 4. Deployed members of each dimension, by lower-case name.
  const members = new Map<number, Map<string, { id: number; leaf: boolean }>>();
  for (const { dim } of sources) {
    const res = await c.query<{ name: string; member_id: number; is_leaf: boolean }>(
      `select m.name, m.member_id, m.is_leaf from epm.member m
         join epm.member_ancestor self on self.ancestor_id = m.member_id and self.descendant_id = m.member_id
        where m.dim_id = $1`,
      [dim.dimId],
    );
    members.set(dim.dimId, new Map(res.rows.map((r) => [r.name.toLowerCase(), { id: r.member_id, leaf: r.is_leaf }])));
  }
  const memberId = (dim: DimInfo, name: string): number => {
    const m = members.get(dim.dimId)!.get(name.toLowerCase());
    if (!m) throw new Error(`${dim.name} has no member ${name}`);
    if (!m.leaf) throw new Error(`${dim.name} ${name} is a parent; data loads into leaf members`);
    return m.id;
  };
  // Fixed members are checked once, before reading lines.
  for (const s of sources) if (s.fixed !== undefined) {
    try {
      memberId(s.dim, s.fixed);
    } catch (err) {
      throw new HttpError(422, (err as Error).message);
    }
  }

  // 5. Map every line.
  const lines: Line[] = [];
  let skipped = 0;
  for (const rec of table.records) {
    const line: Line = { line_no: rec.row_no, source: rec.values, coords: null, amount: null, error: null };
    lines.push(line);
    const filteredOut = filters.some((f) => {
      const v = cellText(rec.values[f.column] ?? null);
      return (f.equals !== undefined && v !== f.equals) || (f.not_equals !== undefined && v === f.not_equals);
    });
    if (filteredOut) {
      skipped++;
      continue;
    }
    const raw = parseAmount(rec.values[amountColumn] ?? null);
    if (raw !== null && Number.isNaN(raw)) {
      line.error = `amount "${cellText(rec.values[amountColumn] ?? null)}" is not a number`;
      continue;
    }
    const amount = raw === null ? 0 : Math.round(raw * def.amount.scale * (def.amount.flip_sign ? -1 : 1) * 1e6) / 1e6;
    if (amount === 0 && def.skip_zero) {
      skipped++;
      continue;
    }
    const k = new Array<number>(COORD_LENGTH).fill(0);
    k[0] = cube.cubeId;
    let skip = false;
    try {
      for (const s of sources) {
        let name: string;
        if (s.fixed !== undefined) name = s.fixed;
        else {
          const value = cellText(rec.values[s.column!] ?? null);
          const rules = rulesByDim.get(s.dim.name.toLowerCase());
          const mapped = rules ? mapValue(rules, value) : value;
          if (mapped === null) throw new Error(`${s.dim.name}: no mapping for "${value}"`);
          if (mapped === SKIP) {
            skip = true;
            break;
          }
          name = mapped;
        }
        k[s.dim.pos] = memberId(s.dim, name);
      }
    } catch (err) {
      line.error = (err as Error).message;
      continue;
    }
    if (skip) {
      skipped++;
      continue;
    }
    line.coords = k;
    line.amount = amount;
  }
  const rejected = lines.filter((l) => l.error);
  const mapped = lines.filter((l) => l.coords);

  // 6. Decide what to write.
  const blocked = rejected.length > 0 && !body.load_valid_lines;
  let status: RunResult['status'] = blocked ? 'failed' : body.dry_run ? 'validated' : 'loaded';
  let txnId: number | null = null;
  let cells = 0;

  if (status === 'loaded') {
    const sums = new Map<string, { k: number[]; v: number }>();
    for (const l of mapped) {
      const id = l.coords!.join(',');
      const cur = sums.get(id) ?? { k: l.coords!, v: 0 };
      cur.v = Math.round((cur.v + l.amount!) * 1e6) / 1e6;
      sums.set(id, cur);
    }
    const target = new Map(sums);
    if (body.mode === 'accumulate' && sums.size) {
      const current = await currentValues(c, app.appId, [...sums.values()].map((s) => s.k));
      for (const [id, s] of sums) target.set(id, { k: s.k, v: Math.round(((current.get(id) ?? 0) + s.v) * 1e6) / 1e6 });
    }
    const cellsOut: { k: number[]; v: number | null }[] = [...target.values()].map((s) => ({ k: s.k, v: s.v }));
    if (body.mode === 'replace') {
      // Clear cells already in the cube for the same scenario, version, year, period and entity.
      for (const k of await replaceScope(c, app.appId, cube, [...sums.values()].map((s) => s.k))) {
        if (!target.has(k.join(','))) cellsOut.push({ k, v: null });
      }
    }
    if (cellsOut.length) {
      try {
        const res = await c.query<{ r: { txn_id: number | null; cell_count: number } }>('select epm.apply_changes($1::jsonb) as r', [
          JSON.stringify({
            app_id: app.appId,
            source: 'data_load',
            source_ref: format.name,
            comment: `${format.name}: ${body.mode} from ${sourceDataset ? `dataset ${sourceDataset.dataset}` : 'file'}`,
            client: { surface: 'import' },
            cells: cellsOut,
          }),
        ]);
        txnId = res.rows[0]!.r.txn_id;
        cells = res.rows[0]!.r.cell_count;
      } catch (err) {
        throw fromPgError(err) ?? err;
      }
    }
  }

  // 7. Record the run and every line (drill-back).
  const datasetsUsed = [...datasets.values()].map((d) => ({ dataset: d.name, version: d.version }));
  const errors = rejected.slice(0, 200).map((l) => ({ line: l.line_no, error: l.error!, source: l.source }));
  const run = await maybeOne<{ run_id: string }>(
    c,
    `insert into epm.import_run (tenant_id, app_id, format_id, format_version, file_id, source_dataset, mode, dry_run, status,
                                 lines_read, lines_mapped, lines_skipped, lines_rejected, cells, txn_id, datasets_used, errors, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) returning run_id`,
    [session.tenantId, app.appId, format.format_id, format.version, fileId, sourceDataset ? JSON.stringify(sourceDataset) : null,
     body.mode, body.dry_run, status, lines.length, mapped.length, skipped, rejected.length, cells, txnId,
     JSON.stringify(datasetsUsed), JSON.stringify(errors), session.userId],
  );
  const CHUNK = 2000;
  for (let i = 0; i < lines.length; i += CHUNK) {
    await c.query(
      `insert into epm.import_line (tenant_id, run_id, line_no, source, coords, amount, error)
       select $1, $2, (l->>'line_no')::int, l->'source',
              case when l->'coords' = 'null'::jsonb then null
                   else array(select jsonb_array_elements_text(l->'coords')::int) end,
              (l->>'amount')::numeric, l->>'error'
         from jsonb_array_elements($3::jsonb) l`,
      [session.tenantId, run!.run_id, JSON.stringify(lines.slice(i, i + CHUNK))],
    );
  }

  return {
    run_id: run!.run_id,
    status,
    mode: body.mode,
    dry_run: body.dry_run,
    lines_read: lines.length,
    lines_mapped: mapped.length,
    lines_skipped: skipped,
    lines_rejected: rejected.length,
    cells,
    txn_id: txnId,
    datasets_used: datasetsUsed,
    errors: errors.slice(0, 50),
  };
}

const FACT_KEY = `(f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                   f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)`;
const JSON_KEY = Array.from({ length: COORD_LENGTH }, (_, i) => `(c.k->>${i})::int`).join(', ');

async function currentValues(c: Client, appId: string, keys: number[][]): Promise<Map<string, number>> {
  const res = await c.query<{ k: number[]; value: number }>(
    `select c.k_arr as k, f.value
       from (select k, array(select jsonb_array_elements_text(k)::int) as k_arr from jsonb_array_elements($2::jsonb) k) c
       join epm.fact f on f.app_id = $1 and ${FACT_KEY} = (${JSON_KEY})`,
    [appId, JSON.stringify(keys)],
  );
  return new Map(res.rows.map((r) => [r.k.join(','), r.value]));
}

/** Existing cells sharing scenario, version, year, period and entity with the loaded cells. */
async function replaceScope(c: Client, appId: string, cube: CubeInfo, keys: number[][]): Promise<number[][]> {
  const scope = [...new Map(keys.map((k) => [`${k[1]},${k[2]},${k[3]},${k[4]},${k[5]}`, [k[1], k[2], k[3], k[4], k[5]]])).values()];
  if (scope.length === 0) return [];
  const res = await c.query<{ k: number[] }>(
    `select array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                  f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8] as k
       from epm.fact f
       join jsonb_array_elements($3::jsonb) s
         on (f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id)
          = ((s->>0)::int, (s->>1)::int, (s->>2)::int, (s->>3)::int, (s->>4)::int)
      where f.app_id = $1 and f.cube_id = $2`,
    [appId, cube.cubeId, JSON.stringify(scope)],
  );
  return res.rows.map((r) => r.k);
}
