import { z } from 'zod';
import type { Client, SessionContext } from '../db.js';
import { HttpError } from '../errors.js';
import {
  COORD_LENGTH,
  type AppContext,
  type CubeInfo,
  type DimInfo,
  type MemberRef,
  loadAccess,
  loadCube,
  resolveMembers,
} from '../model.js';
import { Axis, type ResolvedAxis, resolveAxis, tupleCount, tupleKey, tuples } from './axis.js';

export const MAX_GRID_CELLS = 50_000;

export const GridSpec = z.object({
  cube: z.string().min(1),
  pov: z.record(z.string(), z.string()).default({}),
  rows: Axis,
  columns: Axis,
});
export type GridSpec = z.infer<typeof GridSpec>;

export interface StoredCell {
  i: number;
  j: number;
  k: number[];
  r: number | null;
  v: number | null;
}

export interface GridLayout {
  /** Member ids of each row (one per row dimension); a plain id in grids read before multi-dimension axes. */
  rows: (number | number[])[];
  cols: (number | number[])[];
  values: (number | null)[][];
  writable: boolean[][];
}

export interface AxisView {
  /** The first dimension (the only one on a single-dimension axis). */
  dimension: string;
  dimensions: string[];
  /** One entry per row (or column): its member in each dimension, outermost first. */
  tuples: MemberView[][];
  /** Single-dimension axes only: the members, one per row (or column). */
  members?: MemberView[];
}

export interface GridReadResult {
  /** null for a read-only (phone) session, which cannot submit. */
  grid_session_id: string | null;
  metadata_rev: number;
  cube: string;
  pov: Record<string, string>;
  rows: AxisView;
  columns: AxisView;
  values: (number | null)[][];
  writable: boolean[][];
}

interface PlanWindowRow {
  scenario_id: number;
  version_id: number;
  years_id: number;
  locked: boolean;
  start_ord: number | null;
  end_ord: number | null;
}

export interface MemberView {
  name: string;
  alias: string | null;
  leaf: boolean;
  /** Distance from the dimension root, for indenting row labels. */
  level: number;
}

export function memberView(m: MemberRef): MemberView {
  return { name: m.name, alias: m.alias, leaf: m.isLeaf, level: m.level };
}

export function axisView(axis: ResolvedAxis, list: MemberRef[][]): AxisView {
  const view: AxisView = {
    dimension: axis.dims[0]!.name,
    dimensions: axis.dims.map((d) => d.name),
    tuples: list.map((t) => t.map(memberView)),
  };
  if (axis.dims.length === 1) view.members = list.map((t) => memberView(t[0]!));
  return view;
}

export interface ReadOptions {
  /** Read-only forms: every cell comes back locked and submit has nothing to write. */
  readOnly?: boolean;
}

/** Member-level read and write checks for one user (admins pass everything). */
export interface Access {
  canRead(dim: DimInfo, id: number): boolean;
  canWrite(dim: DimInfo, id: number): boolean;
}

export async function accessFor(c: Client, app: AppContext, session: SessionContext, cube: CubeInfo): Promise<Access> {
  const securedDims = cube.dims.filter((d) => d.secured);
  const access = app.isAdmin ? null : await loadAccess(c, app.appId, session.userId, securedDims.map((d) => d.dimId));
  return {
    canRead: (dim, id) => !access || !dim.secured || access.get(dim.dimId)!.has(id),
    canWrite: (dim, id) => !access || !dim.secured || access.get(dim.dimId)!.get(id) === 'write',
  };
}

export interface PovMember {
  dim: DimInfo;
  member: MemberRef;
}

/** The POV must name exactly the dimensions of the cube that are not on rows or columns. */
export async function resolvePov(c: Client, cube: CubeInfo, used: DimInfo[], given: Record<string, string>, access: Access): Promise<PovMember[]> {
  const usedIds = new Set(used.map((d) => d.dimId));
  const povDims = cube.dims.filter((d) => !usedIds.has(d.dimId));
  const povKeys = new Map(Object.entries(given).map(([k, v]) => [k.toLowerCase(), v]));
  const pov: PovMember[] = [];
  for (const dim of povDims) {
    const expr = povKeys.get(dim.name.toLowerCase());
    if (!expr) throw new HttpError(422, `POV is missing dimension ${dim.name}`);
    povKeys.delete(dim.name.toLowerCase());
    const members = await resolveMembers(c, dim, [expr]);
    if (members.length !== 1) throw new HttpError(422, `POV for ${dim.name} must be a single member`);
    pov.push({ dim, member: members[0]! });
  }
  if (povKeys.size > 0) throw new HttpError(422, `POV names dimensions not in the grid's cube or already on rows/columns: ${[...povKeys.keys()].join(', ')}`);
  for (const p of pov) {
    if (!access.canRead(p.dim, p.member.id)) throw new HttpError(403, `no read access to ${p.dim.name} ${p.member.name}`);
  }
  return pov;
}

/** Rows and columns may not share a dimension. */
export function checkAxes(rows: ResolvedAxis, cols: ResolvedAxis) {
  for (const d of rows.dims) {
    if (cols.dims.some((x) => x.dimId === d.dimId)) throw new HttpError(422, `${d.name} is on both rows and columns`);
  }
}

/**
 * Sum the facts under every row x column combination in one query: the closure is joined once per
 * axis dimension and once per parent POV member, with the product of the path signs.
 */
export async function aggregate(
  c: Client,
  appId: string,
  cube: CubeInfo,
  pov: PovMember[],
  rowAxis: ResolvedAxis,
  colAxis: ResolvedAxis,
  rowList: MemberRef[][],
  colList: MemberRef[][],
): Promise<{ values: (number | null)[][]; revs: (number | null)[][]; texts: (string | null)[][] }> {
  const values: (number | null)[][] = rowList.map(() => colList.map(() => null));
  const revs: (number | null)[][] = rowList.map(() => colList.map(() => null));
  // The exact decimal sums, for display rounding that must not go through binary floating point.
  const texts: (string | null)[][] = rowList.map(() => colList.map(() => null));
  if (rowList.length === 0 || colList.length === 0) return { values, revs, texts };

  const params: unknown[] = [appId, cube.cubeId];
  const joins: string[] = [];
  const filters: string[] = [];
  const signs: string[] = [];
  const groups: string[] = [];
  const addAxis = (axis: ResolvedAxis, prefix: string) => {
    axis.dims.forEach((dim, n) => {
      params.push([...new Set(axis.lists[n]!.map((m) => m.id))]);
      const a = `${prefix}${n}`;
      joins.push(`join epm.member_ancestor ${a} on ${a}.descendant_id = f.${dim.column} and ${a}.ancestor_id = any($${params.length}::int[])`);
      signs.push(`${a}.sign`);
      groups.push(`${a}.ancestor_id`);
    });
  };
  addAxis(rowAxis, 'ar');
  addAxis(colAxis, 'ac');
  pov.forEach((p, n) => {
    params.push(p.member.id);
    if (p.member.isLeaf) {
      filters.push(`f.${p.dim.column} = $${params.length}`);
    } else {
      joins.push(`join epm.member_ancestor ap${n} on ap${n}.descendant_id = f.${p.dim.column} and ap${n}.ancestor_id = $${params.length}`);
      signs.push(`ap${n}.sign`);
    }
  });

  const sql = `
    select array[${groups.join(', ')}] as ids, sum(f.value * ${signs.join(' * ')}) as v,
           sum(f.value * ${signs.join(' * ')})::text as vt, max(f.rev) as rev
      from epm.fact f ${joins.join(' ')}
     where f.app_id = $1 and f.cube_id = $2 ${filters.map((f) => `and ${f}`).join(' ')}
     group by ${groups.join(', ')}`;
  const res = await c.query<{ ids: number[]; v: number; vt: string; rev: number }>(sql, params);
  const nr = rowAxis.dims.length;
  const rowIndex = new Map(rowList.map((t, i) => [tupleKey(t.map((m) => m.id)), i]));
  const colIndex = new Map(colList.map((t, j) => [tupleKey(t.map((m) => m.id)), j]));
  for (const row of res.rows) {
    const i = rowIndex.get(tupleKey(row.ids.slice(0, nr)));
    const j = colIndex.get(tupleKey(row.ids.slice(nr)));
    if (i === undefined || j === undefined) continue;
    values[i]![j] = row.v;
    texts[i]![j] = row.vt;
    revs[i]![j] = row.rev;
  }
  return { values, revs, texts };
}

export async function readGrid(
  c: Client,
  app: AppContext,
  session: SessionContext,
  spec: GridSpec,
  options: ReadOptions = {},
): Promise<GridReadResult> {
  const cube = await loadCube(c, app.appId, spec.cube);
  const access = await accessFor(c, app, session, cube);
  const keep = (dim: DimInfo, m: MemberRef) => access.canRead(dim, m.id);
  const rowAxis = await resolveAxis(c, cube, spec.rows, keep);
  const colAxis = await resolveAxis(c, cube, spec.columns, keep);
  checkAxes(rowAxis, colAxis);
  const pov = await resolvePov(c, cube, [...rowAxis.dims, ...colAxis.dims], spec.pov, access);

  const nRows = tupleCount(rowAxis);
  const nCols = tupleCount(colAxis);
  // An empty axis does not switch the limit off: the other axis alone is still built.
  if (Math.max(nRows, 1) * Math.max(nCols, 1) > MAX_GRID_CELLS) {
    throw new HttpError(422, `grid has ${Math.max(nRows, 1) * Math.max(nCols, 1)} cells; the limit is ${MAX_GRID_CELLS}`);
  }
  const rows = tuples(rowAxis);
  const cols = tuples(colAxis);
  const { values, revs } = await aggregate(c, app.appId, cube, pov, rowAxis, colAxis, rows, cols);

  // Plan windows apply to non-admins.
  const windows = app.isAdmin
    ? []
    : (
        await c.query<PlanWindowRow>(
          `select w.scenario_id, w.version_id, w.years_id, w.locked, ps.leaf_ordinal as start_ord, pe.leaf_ordinal as end_ord
             from epm.plan_window w
             left join epm.member ps on ps.member_id = w.start_period_id
             left join epm.member pe on pe.member_id = w.end_period_id
            where w.app_id = $1`,
          [app.appId],
        )
      ).rows;
  const periodOrd = new Map<number, number | null>();
  if (windows.length > 0) {
    const ids = new Set<number>();
    for (const p of pov) if (p.dim.type === 'period') ids.add(p.member.id);
    rowAxis.dims.forEach((d, n) => { if (d.type === 'period') rowAxis.lists[n]!.forEach((m) => ids.add(m.id)); });
    colAxis.dims.forEach((d, n) => { if (d.type === 'period') colAxis.lists[n]!.forEach((m) => ids.add(m.id)); });
    const res = await c.query<{ member_id: number; leaf_ordinal: number | null }>(
      'select member_id, leaf_ordinal from epm.member where member_id = any($1::int[])',
      [[...ids]],
    );
    for (const r of res.rows) periodOrd.set(r.member_id, r.leaf_ordinal);
  }
  const windowOpen = (k: number[]) => {
    const w = windows.find((x) => x.scenario_id === k[1] && x.version_id === k[2] && x.years_id === k[3]);
    if (!w) return true;
    if (w.locked) return false;
    const ord = periodOrd.get(k[4]!) ?? null;
    if (w.start_ord !== null && (ord === null || ord < w.start_ord)) return false;
    if (w.end_ord !== null && (ord === null || ord > w.end_ord)) return false;
    return true;
  };

  // Writable leaf cells and their coordinates.
  const base = new Array<number>(COORD_LENGTH).fill(0);
  base[0] = cube.cubeId;
  for (const p of pov) base[p.dim.pos] = p.member.id;
  const povLeaf = pov.every((p) => p.member.isLeaf);
  const povWritable = pov.every((p) => access.canWrite(p.dim, p.member.id));
  // A phone (read-only session) never gets writable cells, and keeps no grid on the server.
  const canEnter = app.rank >= 2 && !options.readOnly && !session.readOnly;
  const tupleWritable = (axis: ResolvedAxis, t: MemberRef[]) => t.every((m, n) => m.isLeaf && access.canWrite(axis.dims[n]!, m.id));

  const writable: boolean[][] = rows.map(() => cols.map(() => false));
  const cells: StoredCell[] = [];
  if (canEnter && povLeaf && povWritable) {
    const colOk = cols.map((t) => tupleWritable(colAxis, t));
    rows.forEach((rt, i) => {
      if (!tupleWritable(rowAxis, rt)) return;
      cols.forEach((ct, j) => {
        if (!colOk[j]) return;
        const k = [...base];
        rt.forEach((m, n) => { k[rowAxis.dims[n]!.pos] = m.id; });
        ct.forEach((m, n) => { k[colAxis.dims[n]!.pos] = m.id; });
        if (!windowOpen(k)) return;
        writable[i]![j] = true;
        cells.push({ i, j, k, r: revs[i]![j] ?? null, v: values[i]![j] ?? null });
      });
    });
  }

  const layout: GridLayout = {
    rows: rows.map((t) => t.map((m) => m.id)),
    cols: cols.map((t) => t.map((m) => m.id)),
    values,
    writable,
  };
  const gridSessionId = session.readOnly
    ? null
    : (await c.query<{ grid_session_id: string }>(
        `insert into epm.grid_session (tenant_id, app_id, user_id, cube_id, metadata_rev, spec, layout, cells)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning grid_session_id`,
        [session.tenantId, app.appId, session.userId, cube.cubeId, app.metadataRev, spec, layout, JSON.stringify(cells)],
      )).rows[0]!.grid_session_id;

  return {
    grid_session_id: gridSessionId,
    metadata_rev: app.metadataRev,
    cube: cube.name,
    pov: Object.fromEntries(pov.map((p) => [p.dim.name, p.member.name])),
    rows: axisView(rowAxis, rows),
    columns: axisView(colAxis, cols),
    values,
    writable,
  };
}
