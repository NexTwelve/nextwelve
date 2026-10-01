import type { Client, SessionContext } from './db.js';
import { HttpError } from './errors.js';
import type { Kind } from './definitions.js';
import { lockForEdit } from './model.js';
import { FormDefinition, validatePlacement } from './forms.js';
import { ReportDefinition } from './reports.js';
import { loadCubeById } from './model.js';

/** Saved states of a form or report, newest first, kept by the database for every change. */
export interface HistoryEntry {
  artifact_id: string;
  version: number;
  name: string;
  cube: string | null;
  folder: string | null;
  description: string | null;
  definition: unknown;
  deleted: boolean;
  changed_by: string | null;
  changed_at: string;
  current: boolean;
}

const TIME = `to_char(v.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function definitionHistory(c: Client, appId: string, kind: Kind, name: string, limit = 200): Promise<HistoryEntry[]> {
  const res = await c.query<HistoryEntry>(
    `select v.artifact_id, v.version, v.name, cu.name as cube, v.folder, v.description, v.definition, v.deleted,
            u.email as changed_by, ${TIME} as changed_at,
            exists (select 1 from epm.${kind} x where x.${kind}_id = v.artifact_id and x.version = v.version) as current
       from epm.artifact_version v
       left join epm.cube cu on cu.cube_id = v.cube_id
       left join epm.app_user u on u.user_id = v.changed_by
      where v.app_id = $1 and v.kind = $2 and lower(v.name) = lower($3)
      order by v.changed_at desc, v.version desc
      limit $4`,
    [appId, kind, name, limit],
  );
  if (res.rows.length === 0) throw new HttpError(404, `no history for ${kind} ${name}`);
  return res.rows;
}

/**
 * Make an earlier saved state current again (as a new version). A deleted definition comes back
 * under its original id, so its history continues; the definition must still fit today's metadata.
 */
export async function restoreDefinitionVersion(c: Client, s: SessionContext, appId: string, kind: Kind, name: string, artifactId: string, version: number) {
  await lockForEdit(c, appId);
  const res = await c.query<{ artifact_id: string; name: string; cube_id: number | null; folder: string | null; description: string | null; definition: unknown; deleted: boolean }>(
    `select artifact_id, name, cube_id, folder, description, definition, deleted from epm.artifact_version
      where app_id = $1 and kind = $2 and lower(name) = lower($3) and artifact_id = $4 and version = $5`,
    [appId, kind, name, artifactId, version],
  );
  const v = res.rows[0];
  if (!v) throw new HttpError(404, `${kind} ${name} has no version ${version}`);
  if (v.deleted || v.cube_id === null) throw new HttpError(422, 'that entry records a deletion; choose a saved version');
  const cube = await loadCubeById(c, appId, v.cube_id);
  if (!cube) throw new HttpError(422, 'the cube of that version no longer exists');
  const def = (kind === 'form' ? FormDefinition : ReportDefinition).parse(v.definition);
  await validatePlacement(c, cube, def as never, `${kind === 'form' ? 'the form' : 'the report'} as of version ${version}`);
  return writeDefinition(c, s, appId, kind, { id: v.artifact_id, name: v.name, cubeId: cube.cubeId, folder: v.folder, description: v.description, definition: def });
}

/**
 * Write a definition by name; when none has that name, insert it under the given id (so a
 * definition that comes back keeps its history), numbered after its last history entry.
 */
export async function writeDefinition(
  c: Client,
  s: SessionContext,
  appId: string,
  kind: Kind,
  d: { id: string | null; name: string; cubeId: number; folder: string | null; description: string | null; definition: unknown },
): Promise<{ name: string; version: number; created: boolean }> {
  const table = `epm.${kind}`;
  const idCol = `${kind}_id`;
  const upd = await c.query<{ name: string; version: number }>(
    `update ${table} set cube_id = $3, folder = $4, description = $5, definition = $6, updated_by = $7, updated_at = now()
      where app_id = $1 and lower(name) = lower($2) returning name, version`,
    [appId, d.name, d.cubeId, d.folder, d.description, JSON.stringify(d.definition), s.userId],
  );
  if (upd.rows[0]) return { ...upd.rows[0], created: false };
  const idFree = d.id ? !(await c.query(`select 1 from ${table} where ${idCol} = $1`, [d.id])).rowCount : false;
  const ins = await c.query<{ name: string; version: number }>(
    `insert into ${table} (${idCol}, tenant_id, app_id, cube_id, name, folder, description, definition, updated_by, version)
     values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9,
             coalesce((select max(version) + 1 from epm.artifact_version where artifact_id = $1::uuid), 1))
     returning name, version`,
    [idFree ? d.id : null, s.tenantId, appId, d.cubeId, d.name, d.folder, d.description, JSON.stringify(d.definition), s.userId],
  );
  return { ...ins.rows[0]!, created: true };
}
