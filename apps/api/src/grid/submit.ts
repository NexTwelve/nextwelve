import { z } from 'zod';
import type { Client, SessionContext } from '../db.js';
import { maybeOne } from '../db.js';
import { fromPgError, HttpError } from '../errors.js';
import type { AppContext } from '../model.js';
import type { GridLayout, StoredCell } from './read.js';

const CellValue = z.union([z.number(), z.string(), z.null()]);

export const SubmitBody = z.object({
  grid_session_id: z.uuid(),
  values: z.array(z.array(CellValue)),
  override: z.boolean().default(false),
  comment: z.string().max(2000).optional(),
  client: z.record(z.string(), z.unknown()).optional(),
});
export type SubmitBody = z.infer<typeof SubmitBody>;

export interface SubmitResult {
  txn_id: number | null;
  cell_count: number;
  ignored_readonly: number;
}

export interface Conflict {
  row_index: number;
  column_index: number;
  your_value: number | null;
  current_value: number | null;
}

/** Sheets sends numbers, blanks as '' and occasionally numbers as text. */
function normalize(value: number | string | null | undefined): number | null | 'invalid' {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? round6(value) : 'invalid';
  const text = value.trim().replace(/,/g, '');
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? round6(n) : 'invalid';
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function same(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) < 5e-7;
}

export async function submitGrid(c: Client, app: AppContext, session: SessionContext, body: SubmitBody): Promise<SubmitResult> {
  const gs = await maybeOne<{ metadata_rev: number; layout: GridLayout; cells: StoredCell[] }>(
    c,
    `select metadata_rev, layout, cells from epm.grid_session
      where grid_session_id = $1 and app_id = $2 and user_id = $3 and expires_at > now()
      for update`,
    [body.grid_session_id, app.appId, session.userId],
  );
  if (!gs) throw new HttpError(404, 'grid session not found or expired; refresh the grid');
  if (gs.metadata_rev !== app.metadataRev) {
    throw new HttpError(409, 'dimensions were redeployed since this grid was read; refresh the grid');
  }

  const { layout } = gs;
  if (body.values.length !== layout.rows.length || body.values.some((r) => r.length !== layout.cols.length)) {
    throw new HttpError(422, `values must be ${layout.rows.length} rows by ${layout.cols.length} columns`);
  }

  // Diff against what the server sent; the client never decides what changed.
  let ignored = 0;
  layout.rows.forEach((_, i) => {
    layout.cols.forEach((__, j) => {
      if (layout.writable[i]![j]) return;
      const v = normalize(body.values[i]![j]);
      if (v === 'invalid' || !same(v, layout.values[i]![j] ?? null)) ignored++;
    });
  });

  const changed: { cell: StoredCell; v: number | null }[] = [];
  const invalid: { row_index: number; column_index: number }[] = [];
  for (const cell of gs.cells) {
    const v = normalize(body.values[cell.i]![cell.j]);
    if (v === 'invalid') {
      invalid.push({ row_index: cell.i, column_index: cell.j });
      continue;
    }
    if (!same(v, cell.v)) changed.push({ cell, v });
  }
  if (invalid.length > 0) throw new HttpError(422, 'some writable cells are not numbers', { invalid });
  if (changed.length === 0) return { txn_id: null, cell_count: 0, ignored_readonly: ignored };

  const payload = {
    app_id: app.appId,
    source: 'grid_submit',
    source_ref: body.grid_session_id,
    check_rev: true,
    override: body.override,
    comment: body.comment ?? null,
    client: body.client ?? null,
    cells: changed.map(({ cell, v }) => ({ k: cell.k, v, r: cell.r })),
  };

  let result: { txn_id: number | null; cell_count: number };
  await c.query('savepoint submit');
  try {
    const res = await c.query<{ result: { txn_id: number | null; cell_count: number } }>(
      'select epm.apply_changes($1::jsonb) as result',
      [JSON.stringify(payload)],
    );
    result = res.rows[0]!.result;
  } catch (err) {
    const mapped = fromPgError(err);
    if (mapped?.status === 409 && Array.isArray(mapped.details)) {
      await c.query('rollback to savepoint submit');
      const byKey = new Map(changed.map((x) => [x.cell.k.join(','), x]));
      const conflicts: Conflict[] = [];
      for (const d of mapped.details as { k: number[]; current_value?: number | null }[]) {
        const hit = byKey.get(d.k.join(','));
        if (hit) {
          conflicts.push({
            row_index: hit.cell.i,
            column_index: hit.cell.j,
            your_value: hit.v,
            current_value: d.current_value ?? null,
          });
        }
      }
      throw new HttpError(409, 'some cells were changed by someone else after you refreshed', { conflicts });
    }
    throw mapped ?? err;
  }

  // Bring the stored grid up to date so the planner can keep editing without a refresh.
  const keys = changed.map((x) => x.cell.k);
  const current = await c.query<{ ord: number; value: number | null; rev: number | null }>(
    `select c.ord, f.value, f.rev
       from jsonb_array_elements($2::jsonb) with ordinality c(k, ord)
       left join epm.fact f
         on f.app_id = $1
        and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
             f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
          = ((c.k->>0)::int, (c.k->>1)::int, (c.k->>2)::int, (c.k->>3)::int, (c.k->>4)::int, (c.k->>5)::int,
             (c.k->>6)::int, (c.k->>7)::int, (c.k->>8)::int, (c.k->>9)::int, (c.k->>10)::int, (c.k->>11)::int,
             (c.k->>12)::int, (c.k->>13)::int, (c.k->>14)::int, (c.k->>15)::int)`,
    [app.appId, JSON.stringify(keys)],
  );
  for (const row of current.rows) {
    const x = changed[row.ord - 1]!;
    x.cell.r = row.rev;
    x.cell.v = row.value;
    layout.values[x.cell.i]![x.cell.j] = row.value;
  }
  await c.query('update epm.grid_session set cells = $2, layout = $3 where grid_session_id = $1', [
    body.grid_session_id,
    JSON.stringify(gs.cells),
    layout,
  ]);

  return { txn_id: result.txn_id, cell_count: result.cell_count, ignored_readonly: ignored };
}
