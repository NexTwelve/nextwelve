import { z } from 'zod';
import type { Client } from '../db.js';
import { maybeOne } from '../db.js';
import { HttpError } from '../errors.js';
import { type AppContext, type CubeInfo, type DimInfo, leafIds, loadCube, resolveMembers } from '../model.js';

/**
 * Put a slice back the way it was at an earlier moment, rebuilt from the cell audit:
 * cube x scenario x version, optionally narrowed by members of other dimensions.
 * The moment is a time (`at`) or "just before" a change transaction (`before_txn`).
 * The result lands in place or in another version (created on request), as one audited,
 * undoable 'restore' transaction.
 */
export const PointInTimeBody = z
  .object({
    cube: z.string().min(1),
    scenario: z.string().min(1),
    version: z.string().min(1),
    // Bounded: each expression costs a lookup or two.
    filters: z
      .record(z.string(), z.array(z.string().min(1).max(400)).min(1).max(100))
      .refine((f) => Object.keys(f).length <= 16, { message: 'at most 16 filter dimensions' })
      .default({}),
    at: z.iso.datetime({ offset: true }).optional(),
    before_txn: z.number().int().positive().optional(),
    into_version: z.string().trim().min(1).max(200).optional(),
    create_version: z.boolean().default(false),
    dry_run: z.boolean().default(false),
    comment: z.string().max(500).optional(),
  })
  .refine((b) => (b.at === undefined) !== (b.before_txn === undefined), { message: 'give either at or before_txn' });
export type PointInTimeBody = z.infer<typeof PointInTimeBody>;

interface AsOf {
  chain_seq: number;
  txn_id: number | null;   // the newest change kept (null = before the first change)
  at: string | null;
}

function dimOfType(cube: CubeInfo, type: 'scenario' | 'version'): DimInfo {
  const d = cube.dims.find((x) => x.type === type);
  if (!d) throw new HttpError(422, `cube ${cube.name} has no ${type} dimension`);
  return d;
}

async function leafMember(c: Client, dim: DimInfo, name: string): Promise<{ id: number; name: string }> {
  const found = await resolveMembers(c, dim, [name]);
  if (found.length !== 1) throw new HttpError(422, `${name} must name exactly one ${dim.name} member`);
  const m = found[0]!;
  if (!m.isLeaf) throw new HttpError(422, `${dim.name} ${m.name} is a parent; choose a leaf member`);
  return { id: m.id, name: m.name };
}

/** Change times with microseconds: "at" compares to the microsecond, so callers must see them whole. */
export const TXN_TIME = `to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

async function resolveAsOf(c: Client, appId: string, body: PointInTimeBody): Promise<AsOf> {
  let seq: number;
  if (body.before_txn !== undefined) {
    const t = await maybeOne<{ chain_seq: number }>(c, 'select chain_seq from epm.change_txn where app_id = $1 and txn_id = $2', [
      appId,
      body.before_txn,
    ]);
    if (!t) throw new HttpError(404, `change ${body.before_txn} not found`);
    seq = t.chain_seq - 1;
  } else {
    const t = await maybeOne<{ seq: number }>(
      c,
      'select coalesce(max(chain_seq), 0)::bigint as seq from epm.change_txn where app_id = $1 and created_at <= $2',
      [appId, body.at],
    );
    seq = t!.seq;
  }
  const kept = seq > 0
    ? await maybeOne<{ txn_id: number; at: string }>(
        c,
        `select txn_id, ${TXN_TIME} as at from epm.change_txn where app_id = $1 and chain_seq = $2`,
        [appId, seq],
      )
    : undefined;
  return { chain_seq: seq, txn_id: kept?.txn_id ?? null, at: kept?.at ?? null };
}

/**
 * Find (or, on request, create) the version a restore lands in. A new version is added and deployed
 * on its own (epm.add_version_leaf), so nobody else's pending metadata edits are published with it.
 */
async function targetVersion(c: Client, dim: DimInfo, name: string, create: boolean): Promise<{ id: number; name: string; created: boolean }> {
  const m = await maybeOne<{ member_id: number; name: string; is_leaf: boolean; deployed: boolean }>(
    c,
    `select member_id, name, is_leaf, tree_ordinal is not null as deployed
       from epm.member where dim_id = $1 and lower(name) = lower($2)`,
    [dim.dimId, name],
  );
  if (m) {
    if (!m.deployed || !m.is_leaf) throw new HttpError(422, `${dim.name} ${m.name} must be a deployed leaf member`);
    return { id: m.member_id, name: m.name, created: false };
  }
  if (!create) throw new HttpError(422, `${dim.name} has no member named ${name}; set create_version to add it`);
  const row = await maybeOne<{ id: number }>(c, 'select epm.add_version_leaf($1, $2) as id', [dim.dimId, name]);
  return { id: row!.id, name, created: true };
}

export async function restorePointInTime(c: Client, ctx: AppContext, body: PointInTimeBody) {
  const cube = await loadCube(c, ctx.appId, body.cube);
  const scenarioDim = dimOfType(cube, 'scenario');
  const versionDim = dimOfType(cube, 'version');
  const scenario = await leafMember(c, scenarioDim, body.scenario);
  const version = await leafMember(c, versionDim, body.version);

  const filters: { i: number; ids: number[] }[] = [];
  const filterNames: Record<string, string[]> = {};
  for (const [dimName, exprs] of Object.entries(body.filters)) {
    const dim = cube.dims.find((d) => d.name.toLowerCase() === dimName.toLowerCase());
    if (!dim) throw new HttpError(422, `dimension ${dimName} is not in cube ${cube.name}`);
    if (dim.type === 'scenario' || dim.type === 'version') throw new HttpError(422, `choose the ${dim.name} with ${dim.type}, not as a filter`);
    const ids = new Set<number>();
    for (const m of await resolveMembers(c, dim, [...new Set(exprs)])) for (const id of await leafIds(c, m.id)) ids.add(id);
    filters.push({ i: dim.pos + 1, ids: [...ids] });
    filterNames[dim.name] = exprs;
  }

  const asOf = await resolveAsOf(c, ctx.appId, body);

  // A dry run that would create the target version creates it inside a savepoint and rolls back.
  const into = body.into_version && body.into_version.toLowerCase() !== version.name.toLowerCase() ? body.into_version : undefined;
  const probe = body.dry_run && into !== undefined;
  if (probe) await c.query('savepoint nx_pit_probe');
  try {
    const target = into ? await targetVersion(c, versionDim, into, body.create_version) : { id: version.id, name: version.name, created: false };
    const res = await c.query<{ r: Record<string, unknown> & { skipped_sample: number[][] } }>('select epm.restore_slice($1::jsonb) as r', [
      JSON.stringify({
        app_id: ctx.appId,
        cube_id: cube.cubeId,
        scenario_id: scenario.id,
        version_id: version.id,
        target_version_id: target.id,
        as_of_seq: asOf.chain_seq,
        filters,
        dry_run: body.dry_run,
        comment: body.comment ?? `restore of ${scenario.name} / ${version.name} to ${asOf.at ?? 'the start'}${target.id !== version.id ? ` into ${target.name}` : ''}`,
      }),
    ]);
    const r = res.rows[0]!.r;
    const sample = await describeCoords(c, cube, r.skipped_sample);
    return {
      ...r,
      skipped_sample: sample,
      as_of: asOf,
      cube: cube.name,
      scenario: scenario.name,
      version: version.name,
      filters: filterNames,
      target_version: target.name,
      version_created: target.created && !probe,
    };
  } finally {
    if (probe) await c.query('rollback to savepoint nx_pit_probe');
  }
}

/** Coordinates as dimension -> member name (members deleted since show as #id). */
export async function describeCoords(c: Client, cube: CubeInfo, coords: number[][]): Promise<Record<string, string>[]> {
  if (!coords.length) return [];
  const ids = [...new Set(coords.flat())];
  const res = await c.query<{ member_id: number; name: string }>('select member_id, name from epm.member where member_id = any($1::int[])', [ids]);
  const names = new Map(res.rows.map((r) => [r.member_id, r.name]));
  return coords.map((k) => Object.fromEntries(cube.dims.map((d) => [d.name, names.get(k[d.pos]!) ?? `#${k[d.pos]} (deleted)`])));
}
