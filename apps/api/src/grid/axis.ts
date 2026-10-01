import { z } from 'zod';
import type { Client } from '../db.js';
import { HttpError } from '../errors.js';
import { type CubeInfo, type DimInfo, type MemberRef, resolveMembers } from '../model.js';

/** Up to this many dimensions on one axis (rows or columns). */
export const MAX_AXIS_DIMS = 3;

/** One dimension on an axis: which of its members, as names or functions like Children(Total). */
export const AxisSegment = z.object({
  dimension: z.string().min(1).max(200),
  members: z.array(z.string().min(1).max(400)).min(1).max(1000),
});
export type AxisSegment = z.infer<typeof AxisSegment>;

/**
 * An axis is a list of segments, outermost first (Years then Period: FY26 Jan, FY26 Feb, ...).
 * The original single-dimension shape { dimension, members } is still accepted.
 */
export const Axis = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) ? [v] : v),
  z.array(AxisSegment).min(1).max(MAX_AXIS_DIMS),
);
export type Axis = z.infer<typeof Axis>;

/** What a saved definition may hold: either shape, and no size limits (older saves had none). */
const StoredAxis = z.preprocess(
  (v) => (v && typeof v === 'object' && !Array.isArray(v) ? [v] : v),
  z.array(z.object({ dimension: z.string(), members: z.array(z.string()) })).min(1),
);

/** A saved axis in the list form. Requests are checked against Axis (with limits) instead. */
export function axisOf(value: unknown): AxisSegment[] {
  return StoredAxis.parse(value);
}

export function findDim(cube: CubeInfo, name: string): DimInfo {
  const dim = cube.dims.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (!dim) throw new HttpError(422, `dimension ${name} is not in cube ${cube.name}`);
  return dim;
}

export interface ResolvedAxis {
  dims: DimInfo[];
  /** One member list per dimension, after security filtering. */
  lists: MemberRef[][];
}

export async function resolveAxis(c: Client, cube: CubeInfo, segments: AxisSegment[], keep: (dim: DimInfo, m: MemberRef) => boolean = () => true): Promise<ResolvedAxis> {
  const dims: DimInfo[] = [];
  const lists: MemberRef[][] = [];
  for (const seg of segments) {
    const dim = findDim(cube, seg.dimension);
    if (dims.some((d) => d.dimId === dim.dimId)) throw new HttpError(422, `${dim.name} appears twice on the same axis`);
    dims.push(dim);
    lists.push((await resolveMembers(c, dim, seg.members)).filter((m) => keep(dim, m)));
  }
  return { dims, lists };
}

/** How many combinations an axis makes. */
export function tupleCount(axis: ResolvedAxis): number {
  return axis.lists.reduce((n, l) => n * l.length, 1);
}

/** Every combination, outermost dimension first. Call only after checking tupleCount. */
export function tuples(axis: ResolvedAxis): MemberRef[][] {
  let out: MemberRef[][] = [[]];
  for (const list of axis.lists) {
    const next: MemberRef[][] = [];
    for (const prefix of out) for (const m of list) next.push([...prefix, m]);
    out = next;
  }
  return out;
}

export const tupleKey = (ids: number[]) => ids.join(',');
