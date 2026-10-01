import type { Client } from './db.js';
import { maybeOne, ROLE_RANK } from './db.js';
import { HttpError } from './errors.js';

/** Every cube needs these six. */
export const FIXED_DIMS = ['scenario', 'version', 'years', 'period', 'entity', 'account'] as const;
/** First-class but optional per cube. */
export const OPTIONAL_DIMS = ['department'] as const;
export type DimType = (typeof FIXED_DIMS)[number] | (typeof OPTIONAL_DIMS)[number] | 'custom';

/** Coordinates are int[16]: [cube, scenario, version, years, period, entity, account, department, c1..c8]. */
export const COORD_LENGTH = 16;

/** 0-based position in the coordinate array (the SQL helper epm.coord_index is 1-based). */
export function coordPos(type: DimType, slot: number | null): number {
  switch (type) {
    case 'scenario': return 1;
    case 'version': return 2;
    case 'years': return 3;
    case 'period': return 4;
    case 'entity': return 5;
    case 'account': return 6;
    case 'department': return 7;
    case 'custom': return 7 + (slot ?? 0);
  }
}

export function factColumn(type: DimType, slot: number | null): string {
  return type === 'custom' ? `c${slot}` : `${type}_id`;
}

export interface AppContext {
  appId: string;
  name: string;
  metadataRev: number;
  role: string | null;
  rank: number;
  isAdmin: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Load an application visible to this tenant (RLS) and check the caller's role.
 * Every app-scoped route starts here, so another tenant's app id is simply "not found".
 */
export async function requireApp(c: Client, appId: string, minRole: keyof typeof ROLE_RANK): Promise<AppContext> {
  if (!UUID.test(appId)) throw new HttpError(404, 'application not found');
  const app = await maybeOne<{ app_id: string; name: string; metadata_rev: number; state: string; role: string | null }>(
    c,
    'select a.app_id, a.name, a.metadata_rev, a.state, epm.user_app_role(a.app_id) as role from epm.application a where a.app_id = $1',
    [appId],
  );
  if (!app) throw new HttpError(404, 'application not found');
  const rank = ROLE_RANK[app.role ?? ''] ?? 0;
  if (rank < ROLE_RANK[minRole]!) throw new HttpError(403, `requires role ${minRole} or higher`);
  // A copy being restored is closed to everyone until its loader opens it (or discards it).
  if (app.state === 'restoring') throw new HttpError(423, 'the application is being restored');
  return { appId: app.app_id, name: app.name, metadataRev: app.metadata_rev, role: app.role, rank, isAdmin: rank >= 4 };
}

/**
 * Metadata and definition edits hold a share lock on the application row, so a metadata restore
 * (which locks it exclusively) never interleaves with them.
 */
export async function lockForEdit(c: Client, appId: string): Promise<void> {
  await c.query('select 1 from epm.application where app_id = $1 for share', [appId]);
}

export interface DimInfo {
  dimId: number;
  name: string;
  type: DimType;
  slot: number | null;
  secured: boolean;
  pos: number;
  column: string;
}

export interface CubeInfo {
  cubeId: number;
  name: string;
  dims: DimInfo[];
}

export async function loadDimensions(c: Client, appId: string): Promise<DimInfo[]> {
  const res = await c.query<{ dim_id: number; name: string; dim_type: DimType; slot: number | null; secured: boolean }>(
    'select dim_id, name, dim_type, slot, secured from epm.dimension where app_id = $1 order by dim_id',
    [appId],
  );
  return res.rows.map((d) => ({
    dimId: d.dim_id,
    name: d.name,
    type: d.dim_type,
    slot: d.slot,
    secured: d.secured,
    pos: coordPos(d.dim_type, d.slot),
    column: factColumn(d.dim_type, d.slot),
  }));
}

export async function loadDimension(c: Client, appId: string, name: string): Promise<DimInfo> {
  const dim = (await loadDimensions(c, appId)).find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!dim) throw new HttpError(404, `dimension ${name} not found`);
  return dim;
}

export async function loadCube(c: Client, appId: string, cubeName: string): Promise<CubeInfo> {
  const cube = await maybeOne<{ cube_id: number; name: string }>(
    c,
    'select cube_id, name from epm.cube where app_id = $1 and lower(name) = lower($2)',
    [appId, cubeName],
  );
  if (!cube) throw new HttpError(404, `cube ${cubeName} not found`);
  const ids = new Set(
    (await c.query<{ dim_id: number }>('select dim_id from epm.cube_dimension where cube_id = $1', [cube.cube_id])).rows.map(
      (r) => r.dim_id,
    ),
  );
  const dims = (await loadDimensions(c, appId)).filter((d) => ids.has(d.dimId));
  return { cubeId: cube.cube_id, name: cube.name, dims };
}

export async function loadCubeById(c: Client, appId: string, cubeId: number): Promise<CubeInfo | null> {
  const cube = await maybeOne<{ name: string }>(c, 'select name from epm.cube where app_id = $1 and cube_id = $2', [appId, cubeId]);
  return cube ? loadCube(c, appId, cube.name) : null;
}

export interface MemberRef {
  id: number;
  name: string;
  alias: string | null;
  isLeaf: boolean;
  treeOrdinal: number;
  level: number;
}

const FUNCTION_EXPR = /^@(children|ichildren|descendants|idescendants|leaves)\((.+)\)$/i;

/**
 * Resolve member expressions for one dimension, in hierarchy order, de-duplicated.
 * Supported: Name, @children(Name), @ichildren(Name), @descendants(Name), @idescendants(Name), @leaves(Name).
 * Only deployed members (present in the closure) resolve.
 */
export async function resolveMembers(c: Client, dim: DimInfo, exprs: string[]): Promise<MemberRef[]> {
  const out: MemberRef[] = [];
  const seen = new Set<number>();
  for (const raw of exprs) {
    const expr = raw.trim();
    const m = FUNCTION_EXPR.exec(expr);
    const fn = m ? m[1]!.toLowerCase() : 'member';
    const name = (m ? m[2]! : expr).trim();
    const base = await maybeOne<{ member_id: number }>(
      c,
      `select m.member_id from epm.member m
         join epm.member_ancestor self on self.ancestor_id = m.member_id and self.descendant_id = m.member_id
        where m.dim_id = $1 and lower(m.name) = lower($2)`,
      [dim.dimId, name],
    );
    if (!base) throw new HttpError(422, `${dim.name} has no deployed member named ${name}`);
    const depthFilter = {
      member: 'ma.depth = 0',
      children: 'ma.depth = 1',
      ichildren: 'ma.depth <= 1',
      descendants: 'ma.depth >= 1',
      idescendants: 'true',
      leaves: 'ma.descendant_is_leaf',
    }[fn];
    const rows = await c.query<{ member_id: number; name: string; alias: string | null; is_leaf: boolean; tree_ordinal: number; level: number }>(
      `select m.member_id, m.name, m.alias, m.is_leaf, m.tree_ordinal,
              (select max(r.depth) from epm.member_ancestor r where r.descendant_id = m.member_id)::int as level
         from epm.member_ancestor ma join epm.member m on m.member_id = ma.descendant_id
        where ma.ancestor_id = $1 and ${depthFilter}
        order by m.tree_ordinal`,
      [base.member_id],
    );
    for (const r of rows.rows) {
      if (seen.has(r.member_id)) continue;
      seen.add(r.member_id);
      out.push({ id: r.member_id, name: r.name, alias: r.alias, isLeaf: r.is_leaf, treeOrdinal: r.tree_ordinal, level: r.level });
    }
  }
  return out;
}

export type AccessLevel = 'read' | 'write';

/** Effective access per secured dimension for a user: dimId -> memberId -> level. */
export async function loadAccess(c: Client, appId: string, userId: string, dimIds: number[]): Promise<Map<number, Map<number, AccessLevel>>> {
  const map = new Map<number, Map<number, AccessLevel>>();
  for (const id of dimIds) map.set(id, new Map());
  if (dimIds.length === 0) return map;
  const res = await c.query<{ dim_id: number; member_id: number; access: AccessLevel }>(
    'select dim_id, member_id, access from epm.effective_access where app_id = $1 and user_id = $2 and dim_id = any($3::int[])',
    [appId, userId, dimIds],
  );
  for (const r of res.rows) map.get(r.dim_id)!.set(r.member_id, r.access);
  return map;
}

/** Leaf descendants of a member (itself when it is a leaf). */
export async function leafIds(c: Client, memberId: number): Promise<number[]> {
  const res = await c.query<{ id: number }>(
    'select descendant_id as id from epm.member_ancestor where ancestor_id = $1 and descendant_is_leaf',
    [memberId],
  );
  return res.rows.map((r) => r.id);
}
