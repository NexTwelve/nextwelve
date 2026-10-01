import { z } from 'zod';
import type { Client, SessionContext } from './db.js';
import { maybeOne } from './db.js';
import { HttpError } from './errors.js';
import { Axis, axisOf, findDim } from './grid/axis.js';
import { type GridReadResult, type GridSpec, readGrid } from './grid/read.js';
import { type AppContext, type CubeInfo, loadAccess, loadCube, resolveMembers } from './model.js';

/**
 * A saved form. Every dimension of its cube appears exactly once:
 *   pov      fixed members
 *   page     dimensions the user picks from a list (first readable entry is the default)
 *   rows / columns   one to three dimensions each, with member selections, as in an ad hoc grid
 */
// Control characters (other than tab and line breaks) cannot be stored: spreadsheets drop them.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
export const Text = (max: number) => z.string().max(max).refine((t) => !CONTROL.test(t), { message: 'control characters are not allowed' });

export const FormDefinition = z.object({
  pov: z.record(z.string(), z.string().min(1).max(400)).default({}),
  page: z.record(z.string(), z.array(z.string().min(1).max(400)).min(1).max(1000)).default({}),
  rows: Axis,
  columns: Axis,
  read_only: z.boolean().default(false),
  instructions: Text(2000).optional(),
});
export type FormDefinition = z.infer<typeof FormDefinition>;

export const FormBody = z.object({
  cube: z.string().min(1),
  folder: Text(200).optional(),
  description: Text(2000).optional(),
  definition: FormDefinition,
});

/**
 * A form or report name from the URL: trimmed, no control characters, at most 200 characters
 * (a longer one saved before this rule can still be updated).
 */
export async function definitionName(c: Client, table: 'form' | 'report', appId: string, raw: string): Promise<string> {
  const name = raw.trim();
  if (!name) throw new HttpError(422, 'a name is required');
  if (CONTROL.test(name)) throw new HttpError(422, 'names cannot contain control characters');
  if (name.length > 200) {
    const old = await maybeOne(c, `select 1 from epm.${table} where app_id = $1 and lower(name) = lower($2)`, [appId, name]);
    if (!old) throw new HttpError(422, 'names are at most 200 characters');
  }
  return name;
}
export type FormBody = z.infer<typeof FormBody>;

export const OpenBody = z.object({ page: z.record(z.string(), z.string()).default({}) });

/** The parts of a form or report definition that place dimensions. */
export interface Placement {
  pov: Record<string, string>;
  page: Record<string, string[]>;
  rows: unknown;
  columns: unknown;
}

/**
 * Check that a definition places every dimension of the cube exactly once (POV, page, rows or
 * columns) and that every member expression resolves. `what` names the definition in messages.
 */
export async function validatePlacement(c: Client, cube: CubeInfo, def: Placement, what = 'the form'): Promise<void> {
  const placed = new Map<number, string>();
  const place = (name: string, where: string) => {
    const d = findDim(cube, name);
    if (placed.has(d.dimId)) throw new HttpError(422, `${d.name} is placed twice (${placed.get(d.dimId)} and ${where})`);
    placed.set(d.dimId, where);
    return d;
  };
  for (const [name, expr] of Object.entries(def.pov)) {
    const members = await resolveMembers(c, place(name, 'pov'), [expr]);
    if (members.length !== 1) throw new HttpError(422, `POV for ${name} must be a single member`);
  }
  for (const [name, exprs] of Object.entries(def.page)) await resolveMembers(c, place(name, 'page'), exprs);
  for (const seg of axisOf(def.rows)) await resolveMembers(c, place(seg.dimension, 'rows'), seg.members);
  for (const seg of axisOf(def.columns)) await resolveMembers(c, place(seg.dimension, 'columns'), seg.members);
  const missing = cube.dims.filter((d) => !placed.has(d.dimId)).map((d) => d.name);
  if (missing.length) throw new HttpError(422, `${what} does not place ${missing.join(', ')}`);
}

/** Check that a definition covers the cube exactly and that every member expression resolves. */
export async function validateForm(c: Client, appId: string, body: FormBody): Promise<CubeInfo> {
  const cube = await loadCube(c, appId, body.cube);
  await validatePlacement(c, cube, body.definition);
  return cube;
}

/** Create or replace a form by name. The version goes up only when something changed (a trigger). */
export async function saveForm(c: Client, s: SessionContext, appId: string, rawName: string, body: FormBody): Promise<{ name: string; version: number }> {
  const name = await definitionName(c, 'form', appId, rawName);
  const cube = await validateForm(c, appId, body);
  const res = await c.query<{ name: string; version: number }>(
    `insert into epm.form (tenant_id, app_id, cube_id, name, folder, description, definition, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (app_id, lower(name)) do update
        set cube_id = excluded.cube_id, folder = excluded.folder, description = excluded.description,
            definition = excluded.definition, updated_by = excluded.updated_by, updated_at = now()
     returning name, version`,
    [s.tenantId, appId, cube.cubeId, name, body.folder || null, body.description || null, body.definition, s.userId],
  );
  return res.rows[0]!;
}

export interface FormRow {
  form_id: string;
  name: string;
  folder: string | null;
  description: string | null;
  cube: string;
  definition: FormDefinition;
  version: number;
}

export async function loadForm(c: Client, appId: string, name: string): Promise<FormRow> {
  const row = await maybeOne<FormRow>(
    c,
    `select f.form_id, f.name, f.folder, f.description, cu.name as cube, f.definition, f.version
       from epm.form f join epm.cube cu on cu.cube_id = f.cube_id
      where f.app_id = $1 and lower(f.name) = lower($2)`,
    [appId, name],
  );
  if (!row) throw new HttpError(404, `form ${name} not found`);
  return row;
}

export interface OpenedForm {
  form: { name: string; folder: string | null; description: string | null; instructions: string | null; read_only: boolean; version: number };
  page: Record<string, { selected: string; options: string[] }>;
  grid: GridReadResult;
}

/**
 * Page dimensions: the members on offer (only those the user can read) and the one chosen
 * (the first on offer by default). Returns the choices and the POV with the chosen members added.
 */
export async function resolvePage(
  c: Client,
  app: AppContext,
  session: SessionContext,
  cube: CubeInfo,
  def: { pov: Record<string, string>; page: Record<string, string[]> },
  chosen: Record<string, string>,
): Promise<{ page: Record<string, { selected: string; options: string[] }>; pov: Record<string, string> }> {
  const access = app.isAdmin
    ? null
    : await loadAccess(c, app.appId, session.userId, cube.dims.filter((d) => d.secured).map((d) => d.dimId));
  const picks = new Map(Object.entries(chosen).map(([k, v]) => [k.toLowerCase(), v]));
  const page: Record<string, { selected: string; options: string[] }> = {};
  const pov: Record<string, string> = { ...def.pov };
  // jsonb does not keep key order, so present page dimensions in the cube's dimension order.
  const pageDefs = new Map(Object.entries(def.page).map(([k, v]) => [k.toLowerCase(), v]));
  for (const dim of cube.dims.filter((d) => pageDefs.has(d.name.toLowerCase()))) {
    const exprs = pageDefs.get(dim.name.toLowerCase())!;
    const options = (await resolveMembers(c, dim, exprs)).filter(
      (m) => !access || !dim.secured || access.get(dim.dimId)!.has(m.id),
    );
    if (options.length === 0) throw new HttpError(403, `you have no access to any ${dim.name} on this definition`);
    const want = picks.get(dim.name.toLowerCase());
    const selected = want ? options.find((m) => m.name.toLowerCase() === want.toLowerCase()) : options[0];
    if (!selected) throw new HttpError(422, `${want} is not one of the ${dim.name} choices`);
    page[dim.name] = { selected: selected.name, options: options.map((m) => m.name) };
    pov[dim.name] = selected.name;
  }
  return { page, pov };
}

/** Resolve page choices (only members the user can read are offered), then read the grid. */
export async function openForm(
  c: Client,
  app: AppContext,
  session: SessionContext,
  form: FormRow,
  chosen: Record<string, string>,
): Promise<OpenedForm> {
  const cube = await loadCube(c, app.appId, form.cube);
  const def = form.definition;
  const { page, pov } = await resolvePage(c, app, session, cube, def, chosen);
  // Saved axes are read as saved (older forms may exceed today's request limits).
  const spec: GridSpec = { cube: form.cube, pov, rows: axisOf(def.rows), columns: axisOf(def.columns) };
  const grid = await readGrid(c, app, session, spec, { readOnly: def.read_only });
  return {
    form: {
      name: form.name,
      folder: form.folder,
      description: form.description,
      instructions: def.instructions ?? null,
      read_only: def.read_only,
      version: form.version,
    },
    page,
    grid,
  };
}
