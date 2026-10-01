import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';
import {
  type Actor,
  type Client,
  type Database,
  maybeOne,
  one,
  requireRole,
  retrying,
  type SessionContext,
  systemActor,
  withActor,
  withSession,
} from '../db.js';
import { HttpError } from '../errors.js';
import type { BlobStore } from '../files/blobs.js';
import { canonicalDecimal } from '../files/decimal.js';
import { sha256Hex } from '../files/hash.js';
import { COORD_LENGTH, coordPos, type DimType, requireApp } from '../model.js';

/**
 * Application snapshots: a consistent copy of one application written to object storage.
 *
 *   <tenant>/<app>/snapshots/<snapshot_id>/manifest.json        what is in it, with SHA-256 per file
 *                                         /metadata.json.gz     dimensions, members, cubes, security, forms, imports
 *                                         /datasets.json.gz     current version of every dataset
 *                                         /facts-0001.ndjson.gz one cell per line: [cube, scenario, ..., c8, "value"]
 *
 * Everything is read inside one REPEATABLE READ transaction, so all files show the same moment.
 * Member ids are kept as they were; a restore maps them by dimension and member name.
 *
 * Format 2 (this server) keeps cell values as exact decimal text and records, for every member,
 * the hierarchy as deployed as well as any edits saved but not yet deployed. Format 1 snapshots
 * (values as JSON numbers, no deployed hierarchy) are still read.
 */
export const SCHEMA_VER = 3;
export const FORMAT = 'nextwelve-snapshot';
const FACT_CHUNK = 50_000;
const LOAD_BATCH = 20_000;
/** Data restored over a live application goes in one transaction; past this, narrow the scope. */
export const MAX_IN_PLACE_CELLS = 100_000;
const PRE_RESTORE_DAYS = 90;
const STALE_RUNNING_HOURS = 6;
const MAX_APP_NAME = 200;
/** Snapshots a demo copy may hold (demo sessions only), not counting the ones restores take. */
export const DEMO_MAX_SNAPSHOTS = 20;
/** Pre-restore snapshots a demo copy keeps; a restore past this drops the oldest of them. */
export const DEMO_MAX_PRE_RESTORE = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SnapshotDeps {
  db: Database;
  blobs: BlobStore;
}

const Name = z.string().min(1).max(200);

export const SnapshotScope = z.object({
  scenarios: z.array(Name).min(1).max(200).optional(),
  versions: z.array(Name).min(1).max(200).optional(),
});
export type SnapshotScope = z.infer<typeof SnapshotScope>;

export const CreateSnapshotBody = z.object({
  scope: SnapshotScope.default({}),
  comment: z.string().max(500).optional(),
});

export const RestoreBody = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('new_app'),
    name: z.string().trim().min(1).max(MAX_APP_NAME).optional(),
    /**
     * none (default): the copy starts with no application roles or member grants; service admins
     * see it and grant access. copy: the snapshot's roles and grants are re-created and listed in
     * the response and the security log (access removed since the snapshot comes back).
     */
    access: z.enum(['none', 'copy']).default('none'),
  }),
  z.object({
    target: z.literal('in_place'),
    scenarios: z.array(Name).min(1).max(200).optional(),
    versions: z.array(Name).min(1).max(200).optional(),
    into_version: z.string().trim().min(1).max(200).optional(),
    dry_run: z.boolean().default(false),
    comment: z.string().max(500).optional(),
  }),
]);
export type RestoreBody = z.infer<typeof RestoreBody>;

export interface ManifestFile {
  name: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface Manifest {
  format: string;
  schema_ver: number;
  snapshot_id: string;
  tenant_id: string;
  app_id: string;
  app_name: string;
  kind: string;
  scope: SnapshotScope;
  taken_at: string;
  metadata_rev: number;
  high_chain_seq: number;
  fact_count: number;
  files: ManifestFile[];
}

export interface DimRow { dim_id: number; name: string; type: DimType; slot: number | null; secured: boolean }
export interface MemberRow {
  member_id: number; dim_id: number; name: string; parent_id: number | null; alias: string | null; sort_order: number;
  agg_op: string; account_type: string | null; time_balance: string | null; formula: string | null; deployed: boolean;
  /** Format 2: the hierarchy as deployed (what rollups and security use). */
  tree_ordinal?: number | null; deployed_parent_id?: number | null; deployed_agg_op?: string | null;
  /** Format 3: the sort order as deployed (from the member's history), when there is one. */
  deployed_sort_order?: number | null;
}
/** A form or report in a snapshot; id (format 3) lets an in-place restore keep its history. */
export interface SnapDefinition { id?: string; name: string; cube_id: number; folder: string | null; description: string | null; definition: unknown }
export interface Metadata {
  application: { name: string; metadata_rev: number };
  dimensions: DimRow[];
  members: MemberRow[];
  cubes: { cube_id: number; name: string; dim_ids: number[] }[];
  plan_windows: { scenario_id: number; version_id: number; years_id: number; start_period_id: number | null; end_period_id: number | null; locked: boolean }[];
  grants: { principal_type: 'user' | 'group'; principal: string; member_id: number; scope: string; access: string }[];
  roles: { email: string; role: string }[];
  forms: SnapDefinition[];
  /** Format 3 and later. */
  reports?: SnapDefinition[];
  import_formats: {
    name: string; cube_id: number; definition: unknown;
    mappings: { dimension: string; rule_type: string; source: string; target: string; options: unknown; priority: number; description: string | null }[];
  }[];
}
interface DatasetDump {
  name: string; description: string | null; version: number; sheets: unknown;
  rows: { sheet: string; row_no: number; data: unknown }[];
}
/** One fact line: 16 coordinates, then the value (decimal text in format 2, a number in format 1). */
export type FactLine = (number | string)[];

export interface SnapshotRow {
  snapshot_id: string;
  app_id: string;
  app_name: string;
  kind: string;
  scope: SnapshotScope;
  status: string;
  storage_prefix: string;
  metadata_rev: number | null;
  high_chain_seq: number | null;
  fact_count: number | null;
  byte_size: number | null;
  manifest: Manifest | null;
  error: string | null;
  comment: string | null;
  created_by: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string | null;
}

const SNAPSHOT_COLUMNS = `s.snapshot_id, s.app_id, s.app_name, s.kind, s.scope, s.status, s.storage_prefix, s.metadata_rev,
  s.high_chain_seq, s.fact_count, s.byte_size, s.manifest, s.error, s.comment, u.email as created_by, s.created_at,
  s.completed_at, s.expires_at`;

export async function listSnapshots(c: Client, appId: string, limit = 100): Promise<Omit<SnapshotRow, 'manifest'>[]> {
  const res = await c.query<SnapshotRow>(
    `select ${SNAPSHOT_COLUMNS} from epm.snapshot s left join epm.app_user u on u.user_id = s.created_by
      where s.app_id = $1 order by s.created_at desc limit $2`,
    [appId, limit],
  );
  return res.rows.map(({ manifest: _m, ...rest }) => rest);
}

export async function loadSnapshot(c: Client, appId: string, snapshotId: string): Promise<SnapshotRow> {
  if (!UUID.test(snapshotId) || !UUID.test(appId)) throw new HttpError(404, 'snapshot not found');
  return one<SnapshotRow>(
    c,
    `select ${SNAPSHOT_COLUMNS} from epm.snapshot s left join epm.app_user u on u.user_id = s.created_by
      where s.app_id = $1 and s.snapshot_id = $2`,
    [appId, snapshotId],
    'snapshot not found',
  );
}

// ---------------------------------------------------------------------------
// Taking a snapshot
// ---------------------------------------------------------------------------

/** Scenario and version names -> member ids in this application (unknown names are an error). */
async function scopeIds(c: Client, appId: string, scope: SnapshotScope): Promise<{ scenarios: number[] | null; versions: number[] | null; canonical: SnapshotScope }> {
  const canonical: SnapshotScope = {};
  const ids = async (type: 'scenario' | 'version', names?: string[]) => {
    if (!names) return null;
    const res = await c.query<{ member_id: number; name: string }>(
      `select m.member_id, m.name from epm.member m join epm.dimension d on d.dim_id = m.dim_id
        where d.app_id = $1 and d.dim_type = $2 and lower(m.name) = any($3::text[])`,
      [appId, type, names.map((n) => n.toLowerCase())],
    );
    const found = new Set(res.rows.map((r) => r.name.toLowerCase()));
    const missing = names.filter((n) => !found.has(n.toLowerCase()));
    if (missing.length) throw new HttpError(422, `no ${type} named ${missing.join(', ')}`);
    canonical[type === 'scenario' ? 'scenarios' : 'versions'] = res.rows.map((r) => r.name);
    return res.rows.map((r) => r.member_id);
  };
  return { scenarios: await ids('scenario', scope.scenarios), versions: await ids('version', scope.versions), canonical };
}

/** Writes snapshot files and remembers every key it tried, so a failure can remove them all. */
class FileWriter {
  readonly files: ManifestFile[] = [];
  readonly attempted: string[] = [];
  constructor(private readonly blobs: BlobStore, readonly prefix: string) {}

  async json(name: string, value: unknown, rows: number) {
    await this.write(name, gzipSync(strToU8(JSON.stringify(value)), { level: 6 }), rows, 'application/gzip');
  }

  async write(name: string, bytes: Uint8Array, rows: number, contentType: string) {
    await this.put(name, bytes, contentType);
    this.files.push({ name, rows, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) });
  }

  async put(name: string, bytes: Uint8Array, contentType: string) {
    this.attempted.push(`${this.prefix}/${name}`);
    await this.blobs.put(`${this.prefix}/${name}`, bytes, contentType);
  }
}

async function exportApplication(
  c: Client,
  w: FileWriter,
  appId: string,
  ids: { scenarios: number[] | null; versions: number[] | null },
): Promise<{ appName: string; metadataRev: number; highSeq: number; facts: number; contentHash: string }> {
  // (Tests hook this exact statement to act right after the export's view of the data is fixed.)
  const app = await one<{ name: string; metadata_rev: number }>(c, 'select name, metadata_rev from epm.application where app_id = $1', [appId]);
  const head = await one<{ seq: number; hash: string }>(
    c,
    'select coalesce(max(chain_seq), 0)::bigint as seq, epm.app_fingerprint($1) as hash from epm.change_txn where app_id = $1',
    [appId],
  );

  const rows = async <T>(sql: string): Promise<T[]> => (await c.query(sql, [appId])).rows as T[];
  const meta: Metadata = {
    application: { name: app.name, metadata_rev: app.metadata_rev },
    dimensions: await rows<DimRow>('select dim_id, name, dim_type as type, slot, secured from epm.dimension where app_id = $1 order by dim_id'),
    members: await rows<MemberRow>(
      `select m.member_id, m.dim_id, m.name, m.parent_id, m.alias, m.sort_order, m.agg_op, m.account_type, m.time_balance,
              m.formula, m.tree_ordinal is not null as deployed, m.tree_ordinal,
              dp.ancestor_id as deployed_parent_id,
              case dp.sign when 1 then '+' when -1 then '-' when 0 then '~' end as deployed_agg_op,
              (select v.sort_order from epm.member_version v where v.member_id = m.member_id and v.to_rev is null) as deployed_sort_order
         from epm.member m join epm.dimension d on d.dim_id = m.dim_id
         -- The nearest deployed ancestor that still exists (a deleted parent keeps its closure rows
         -- until the next deploy), with the sign of the whole path, so rollups come back the same.
         left join lateral (
           select ma.ancestor_id, ma.sign from epm.member_ancestor ma join epm.member p on p.member_id = ma.ancestor_id
            where ma.descendant_id = m.member_id and ma.depth >= 1 order by ma.depth limit 1) dp on true
        where d.app_id = $1 order by m.dim_id, m.tree_ordinal nulls last, m.member_id`,
    ),
    cubes: await rows(
      `select cu.cube_id, cu.name, array_agg(cd.dim_id order by cd.dim_id) as dim_ids
         from epm.cube cu join epm.cube_dimension cd on cd.cube_id = cu.cube_id
        where cu.app_id = $1 group by cu.cube_id, cu.name order by cu.cube_id`,
    ),
    plan_windows: await rows(
      'select scenario_id, version_id, years_id, start_period_id, end_period_id, locked from epm.plan_window where app_id = $1',
    ),
    grants: await rows(
      `select g.principal_type, coalesce(u.email, pg.name) as principal, g.member_id, g.scope, g.access
         from epm.access_grant g
         left join epm.app_user u on g.principal_type = 'user' and u.user_id = g.principal
         left join epm.principal_group pg on g.principal_type = 'group' and pg.group_id = g.principal
        where g.app_id = $1 order by g.grant_id`,
    ),
    roles: await rows(
      `select u.email, r.role from epm.user_role r join epm.app_user u on u.user_id = r.user_id
        where r.app_id = $1 order by u.email`,
    ),
    forms: await rows('select form_id as id, name, cube_id, folder, description, definition from epm.form where app_id = $1 order by name'),
    reports: await rows('select report_id as id, name, cube_id, folder, description, definition from epm.report where app_id = $1 order by name'),
    import_formats: await rows(
      `select f.name, f.cube_id, f.definition,
              coalesce((select jsonb_agg(jsonb_build_object('dimension', r.dimension, 'rule_type', r.rule_type, 'source', r.source,
                                         'target', r.target, 'options', r.options, 'priority', r.priority, 'description', r.description)
                                       order by r.rule_id)
                          from epm.mapping_rule r where r.format_id = f.format_id), '[]'::jsonb) as mappings
         from epm.import_format f where f.app_id = $1 order by f.name`,
    ),
  };
  await w.json('metadata.json.gz', meta, meta.members.length);

  const datasets = await rows<DatasetDump & { dataset_id: string }>(
    `select d.dataset_id, d.name, d.description, v.version, v.sheets
       from epm.dataset d join epm.dataset_version v on v.dataset_id = d.dataset_id and v.version = d.current_version
      where d.app_id = $1 order by d.name`,
  );
  let datasetRows = 0;
  for (const d of datasets) {
    d.rows = (
      await c.query('select sheet, row_no, data from epm.dataset_row where dataset_id = $1 and version = $2 order by sheet, row_no', [
        d.dataset_id,
        d.version,
      ])
    ).rows;
    datasetRows += d.rows.length;
  }
  await w.json('datasets.json.gz', datasets.map(({ dataset_id: _id, ...d }) => d), datasetRows);

  // Facts through a cursor, one file per chunk. Values as exact decimal text. The ids are integers from the database.
  const where = [
    `app_id = ${c.escapeLiteral(appId)}`,
    ids.scenarios ? `scenario_id = any('{${ids.scenarios.join(',')}}'::int[])` : null,
    ids.versions ? `version_id = any('{${ids.versions.join(',')}}'::int[])` : null,
  ].filter(Boolean);
  await c.query(
    `declare nx_snapshot_facts no scroll cursor for
       select array[cube_id, scenario_id, version_id, years_id, period_id, entity_id, account_id, department_id,
                    c1, c2, c3, c4, c5, c6, c7, c8] as k, value::text as v
         from epm.fact where ${where.join(' and ')}
        order by cube_id, scenario_id, version_id, entity_id, account_id, department_id, years_id, period_id,
                 c1, c2, c3, c4, c5, c6, c7, c8`,
  );
  let facts = 0;
  for (let part = 1; ; part++) {
    const batch = await c.query<{ k: number[]; v: string }>(`fetch ${FACT_CHUNK} from nx_snapshot_facts`);
    if (batch.rows.length === 0) break;
    const text = batch.rows.map((r) => JSON.stringify([...r.k, r.v])).join('\n');
    await w.write(`facts-${String(part).padStart(4, '0')}.ndjson.gz`, gzipSync(strToU8(text), { level: 6 }), batch.rows.length, 'application/gzip');
    facts += batch.rows.length;
    if (batch.rows.length < FACT_CHUNK) break;
  }
  await c.query('close nx_snapshot_facts');
  return { appName: app.name, metadataRev: app.metadata_rev, highSeq: head.seq, facts, contentHash: head.hash };
}

/**
 * Take a snapshot. A signed-in actor needs app_admin; the nightly job acts for the tenant with
 * no user. Writes the row as 'running', exports, then marks it 'complete' — or 'failed', with
 * every file it tried to write removed, even when the requester's own session has stopped working.
 */
export async function createSnapshot(
  deps: SnapshotDeps,
  actor: Actor,
  appId: string,
  opts: { kind: 'manual' | 'nightly' | 'pre_restore' | 'pre_deploy'; scope?: SnapshotScope; comment?: string },
): Promise<SnapshotRow> {
  let scope: SnapshotScope = opts.scope ?? {};
  const started = await withActor(deps.db, actor, async (c) => {
    if (actor.userId !== null) await requireApp(c, appId, 'app_admin');
    const app = await maybeOne<{ name: string; state: string }>(c, 'select name, state from epm.application where app_id = $1', [appId]);
    if (!app) throw new HttpError(404, 'application not found');
    if (app.state === 'restoring') throw new HttpError(423, 'the application is being restored');
    let dropped: { storage_prefix: string; manifest: Manifest | null }[] = [];
    if (actor.userId !== null && (actor as SessionContext).demo) {
      // One snapshot decision at a time per copy, so the caps hold under concurrent requests.
      await c.query("select pg_advisory_xact_lock(hashtextextended('nextwelve.demo-snapshots:' || $1, 0))", [actor.tenantId]);
      if (opts.kind === 'pre_restore') {
        // A restore must never be refused for want of room: the oldest pre-restore snapshots make way.
        const old = await c.query<{ snapshot_id: string; storage_prefix: string; manifest: Manifest | null }>(
          `select snapshot_id, storage_prefix, manifest from epm.snapshot
            where kind = 'pre_restore' and status = 'complete' order by created_at desc offset $1`,
          [DEMO_MAX_PRE_RESTORE - 1],
        );
        if (old.rows.length) {
          await c.query(`update epm.snapshot set status = 'expired' where snapshot_id = any($1::uuid[])`, [old.rows.map((r) => r.snapshot_id)]);
          dropped = old.rows;
        }
      } else {
        const n = await one<{ n: number }>(c, `select count(*)::int as n from epm.snapshot where kind <> 'pre_restore' and status in ('running', 'complete')`);
        if (n.n >= DEMO_MAX_SNAPSHOTS) throw new HttpError(429, `a demo copy keeps at most ${DEMO_MAX_SNAPSHOTS} snapshots; start over for a fresh copy`);
      }
    }
    const ids = await scopeIds(c, appId, scope);
    scope = ids.canonical;
    const snapshotId = crypto.randomUUID();
    const prefix = `${actor.tenantId}/${appId}/snapshots/${snapshotId}`;
    await c.query(
      `insert into epm.snapshot (snapshot_id, tenant_id, app_id, app_name, kind, scope, schema_ver, storage_prefix, status,
                                 comment, created_by, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10,
               case when $5 = 'pre_restore' then now() + make_interval(days => $11) end)`,
      [snapshotId, actor.tenantId, appId, app.name, opts.kind, JSON.stringify(scope), SCHEMA_VER, prefix, opts.comment ?? null,
       actor.userId, PRE_RESTORE_DAYS],
    );
    return { snapshotId, prefix, ids, dropped };
  });
  for (const d of started.dropped) {
    const keys = [...(d.manifest?.files ?? []).map((f) => `${d.storage_prefix}/${f.name}`), `${d.storage_prefix}/manifest.json`];
    await deps.blobs.delete(keys).catch(() => undefined);   // the copy's files all go when it ends anyway
  }

  const writer = new FileWriter(deps.blobs, started.prefix);
  try {
    const takenAt = new Date().toISOString();
    const out = await withActor(deps.db, actor, (c) => exportApplication(c, writer, appId, started.ids), { snapshot: true });
    const manifest: Manifest = {
      format: FORMAT,
      schema_ver: SCHEMA_VER,
      snapshot_id: started.snapshotId,
      tenant_id: actor.tenantId,
      app_id: appId,
      app_name: out.appName,
      kind: opts.kind,
      scope,
      taken_at: takenAt,
      metadata_rev: out.metadataRev,
      high_chain_seq: out.highSeq,
      fact_count: out.facts,
      files: writer.files,
    };
    await writer.put('manifest.json', strToU8(JSON.stringify(manifest, null, 2)), 'application/json');
    return await withActor(deps.db, actor, async (c) => {
      await c.query(
        `update epm.snapshot set status = 'complete', metadata_rev = $2, high_chain_seq = $3, fact_count = $4, byte_size = $5,
                manifest = $6, content_hash = $7, completed_at = now()
          where snapshot_id = $1`,
        [started.snapshotId, out.metadataRev, out.highSeq, out.facts, writer.files.reduce((n, f) => n + f.bytes, 0),
         JSON.stringify(manifest), out.contentHash],
      );
      await c.query(
        `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'snapshot_created', $4)`,
        [actor.tenantId, appId, actor.userId, { snapshot_id: started.snapshotId, kind: opts.kind, facts: out.facts, scope }],
      );
      return loadSnapshot(c, appId, started.snapshotId);
    });
  } catch (err) {
    // Recorded as the tenant, not the requester: their session may be what failed.
    await withActor(deps.db, systemActor(actor.tenantId), (c) =>
      c.query(`update epm.snapshot set status = 'failed', error = $2, completed_at = now() where snapshot_id = $1`, [
        started.snapshotId,
        String((err as Error).message ?? err).slice(0, 1000),
      ]),
    ).catch(() => undefined);
    await deps.blobs.delete(writer.attempted).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reading a snapshot back
// ---------------------------------------------------------------------------

/**
 * A file's bytes, checked against the manifest kept in the database. manifest.json itself is
 * served from the database copy, so an altered copy in storage is never handed out.
 */
export async function readSnapshotFile(blobs: BlobStore, snap: SnapshotRow, name: string): Promise<Uint8Array> {
  if (name === 'manifest.json') {
    if (!snap.manifest) throw new HttpError(422, `snapshot is ${snap.status}, not complete`);
    return strToU8(JSON.stringify(snap.manifest, null, 2));
  }
  const entry = snap.manifest?.files.find((f) => f.name === name);
  if (!entry) throw new HttpError(404, 'snapshot has no such file');
  const bytes = await blobs.get(`${snap.storage_prefix}/${name}`);
  if (!bytes) throw new HttpError(410, `${name} of this snapshot is no longer in storage`);
  if (bytes.byteLength !== entry.bytes || (await sha256Hex(bytes)) !== entry.sha256) {
    throw new HttpError(422, `${name} does not match its checksum; the snapshot cannot be trusted`);
  }
  return bytes;
}

async function readJsonFile<T>(blobs: BlobStore, snap: SnapshotRow, name: string): Promise<T> {
  return JSON.parse(strFromU8(gunzipSync(await readSnapshotFile(blobs, snap, name)))) as T;
}

const malformed = (what: string) => new HttpError(422, `the snapshot's ${what} is malformed`);

/** Verify every file before anything is written, then hand back fact chunks one at a time. */
export async function openSnapshot(blobs: BlobStore, snap: SnapshotRow) {
  if (snap.status !== 'complete' || !snap.manifest) throw new HttpError(422, `snapshot is ${snap.status}, not complete`);
  if (snap.manifest.schema_ver > SCHEMA_VER) throw new HttpError(422, `snapshot format ${snap.manifest.schema_ver} is newer than this server`);
  const meta = await readJsonFile<Metadata>(blobs, snap, 'metadata.json.gz');
  const lists: (keyof Metadata)[] = ['dimensions', 'members', 'cubes', 'plan_windows', 'grants', 'roles', 'forms', 'import_formats'];
  if (!meta || typeof meta !== 'object' || lists.some((k) => !Array.isArray(meta[k]))) throw malformed('metadata');
  if (meta.reports !== undefined && !Array.isArray(meta.reports)) throw malformed('metadata');
  const datasets = await readJsonFile<DatasetDump[]>(blobs, snap, 'datasets.json.gz');
  if (!Array.isArray(datasets)) throw malformed('dataset file');
  const compressed: Uint8Array[] = [];
  for (const f of snap.manifest.files.filter((x) => x.name.startsWith('facts-'))) compressed.push(await readSnapshotFile(blobs, snap, f.name));
  function* facts(): Generator<FactLine> {
    for (const bytes of compressed) {
      const text = strFromU8(gunzipSync(bytes));
      if (!text) continue;
      for (const line of text.split('\n')) {
        const f = JSON.parse(line) as FactLine;
        if (!Array.isArray(f) || f.length !== COORD_LENGTH + 1) throw malformed('fact file');
        // Values become the exact text Postgres keeps for numeric(24,6); anything else is refused.
        const raw = f[COORD_LENGTH];
        const v = typeof raw === 'string' || typeof raw === 'number' ? canonicalDecimal(raw) : null;
        if (v === null) throw malformed('fact file');
        f[COORD_LENGTH] = v;
        yield f;
      }
    }
  }
  return { meta, datasets, facts };
}

/** Both sides are canonical numeric(24,6) text (canonicalDecimal, value::text). */
const sameValue = (a: number | string, b: string) => a === b;

// ---------------------------------------------------------------------------
// Restore into a new application
// ---------------------------------------------------------------------------

const stamp = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** Candidate names: the wanted name, then "name 2", "name 3", ..., each cut to the length limit. */
function candidateName(wanted: string, n: number): string {
  const suffix = n === 1 ? '' : ` ${n}`;
  return `${[...wanted].slice(0, MAX_APP_NAME - suffix.length).join('').trimEnd()}${suffix}`;
}

/** Insert the application under the first free candidate name (safe against concurrent restores). */
async function insertApplication(c: Client, tenantId: string, wanted: string): Promise<{ app_id: string; name: string }> {
  for (let n = 1; n < 100; n++) {
    const name = candidateName(wanted, n);
    await c.query('savepoint nx_app_name');
    try {
      const row = await one<{ app_id: string; name: string }>(
        c,
        `insert into epm.application (tenant_id, name, state) values ($1, $2, 'restoring') returning app_id, name`,
        [tenantId, name],
      );
      await c.query('release savepoint nx_app_name');
      return row;
    } catch (err) {
      if ((err as { code?: string }).code !== '23505') throw err;
      await c.query('rollback to savepoint nx_app_name');
    }
  }
  throw new HttpError(409, `choose another name than ${wanted}`);
}

export async function restoreToNewApp(
  deps: SnapshotDeps,
  s: SessionContext,
  appId: string,
  snapshotId: string,
  opts: { name?: string; access: 'none' | 'copy' },
) {
  // Creating an application is a tenant-level act. The source application need not exist any more.
  const snap = await withSession(deps.db, s, async (c) => {
    await requireRole(c, null, 'service_admin');
    return loadSnapshot(c, appId, snapshotId);
  });
  return loadAsNewApp(deps, s, snap, opts, appId);
}

/**
 * Build a new application from a snapshot's files (checked against its manifest): the snapshot of
 * an application of this tenant, or the demo template. The session must be a service admin.
 */
export async function loadAsNewApp(
  deps: SnapshotDeps,
  s: SessionContext,
  snap: SnapshotRow,
  opts: { name?: string; access: 'none' | 'copy' },
  sourceAppId: string | null,
) {
  const { meta, datasets, facts } = await openSnapshot(deps.blobs, snap);
  const v2 = (snap.manifest?.schema_ver ?? 1) >= 2;

  // Which members exist as deployed in the source, and how the deployed tree looked. Format 1 kept
  // each member's deployed flag but not its deployed parent: there the saved parent stands in.
  const deployed = meta.members.filter((m) => m.deployed !== false);
  const deployedIds = new Set(deployed.map((m) => m.member_id));
  const cubeIds = new Set(meta.cubes.map((cu) => cu.cube_id));

  const hierarchyWarnings: string[] = [];

  // Check every fact before anything is created: cells whose members are not in the snapshot's
  // deployed metadata (left behind by an old bug or a manual edit) are skipped and reported.
  let skipped = 0;
  for (const line of facts()) {
    if (!cubeIds.has(line[0] as number) || line.slice(1, COORD_LENGTH).some((id) => id !== 0 && !deployedIds.has(id as number))) skipped++;
  }

  // 1. The deployed application, in one transaction. It stays 'restoring' (read-only to everyone
  //    but this loader) until its data is in.
  const built = await withSession(deps.db, s, async (c) => {
    const app = await insertApplication(c, s.tenantId, opts.name ?? `${snap.app_name} (restored ${stamp(snap.manifest!.taken_at)})`);
    const dimMap = new Map<number, number>();
    for (const d of meta.dimensions) {
      const row = await one<{ dim_id: number }>(
        c,
        `insert into epm.dimension (tenant_id, app_id, name, dim_type, slot, secured) values ($1, $2, $3, $4, $5, $6) returning dim_id`,
        [s.tenantId, app.app_id, d.name, d.type, d.slot, d.secured],
      );
      dimMap.set(d.dim_id, row.dim_id);
    }
    const memberMap = new Map<number, number>();
    const insertMembers = async (list: MemberRow[], asDeployed: boolean) => {
      if (!list.length) return;
      const ins = await c.query<{ member_id: number }>(
        `insert into epm.member (tenant_id, dim_id, name, alias, agg_op, sort_order, account_type, time_balance, formula)
         select $1, (r->>'dim_id')::int, r->>'name', r->>'alias', r->>'agg_op', (r->>'sort_order')::int, r->>'account_type',
                r->>'time_balance', r->>'formula'
           from jsonb_array_elements($2::jsonb) with ordinality e(r, ord)
          order by e.ord
         returning member_id`,
        [s.tenantId, JSON.stringify(list.map((m) => ({
          ...m,
          dim_id: dimMap.get(m.dim_id),
          // Deployed order and aggregation, so the deploy below rebuilds the tree the source had deployed.
          agg_op: asDeployed && v2 ? m.deployed_agg_op ?? m.agg_op : m.agg_op,
          // The deployed sort order when the snapshot has it, so the copy's deployed state matches the
          // source's and only real undeployed edits show as pending; else the deployed position.
          sort_order: asDeployed && v2 ? m.deployed_sort_order ?? m.tree_ordinal ?? m.sort_order : m.sort_order,
        })))],
      );
      const created = await c.query<{ member_id: number; dim_id: number; name: string }>(
        'select member_id, dim_id, name from epm.member where member_id = any($1::int[])',
        [ins.rows.map((r) => r.member_id)],
      );
      const byName = new Map(created.rows.map((r) => [`${r.dim_id}\u0000${r.name}`, r.member_id]));
      for (const m of list) memberMap.set(m.member_id, byName.get(`${dimMap.get(m.dim_id)}\u0000${m.name}`)!);
    };
    await insertMembers(deployed, true);
    const deployedParent = (m: MemberRow) => (v2 ? m.deployed_parent_id ?? null : m.parent_id);
    const links: [number, number][] = [];
    for (const m of deployed) {
      const parent = deployedParent(m);
      if (parent === null) continue;
      const to = memberMap.get(parent);
      // A parent missing from the snapshot (a format 1 member moved under an undeployed one):
      // the member goes to the top of its dimension, and the response says so.
      if (to === undefined) { hierarchyWarnings.push(`${m.name}: its deployed parent is not in the snapshot`); continue; }
      links.push([memberMap.get(m.member_id)!, to]);
    }
    await c.query(
      `update epm.member m set parent_id = x.parent
         from (select (e->>0)::int as id, (e->>1)::int as parent from jsonb_array_elements($1::jsonb) e) x
        where m.member_id = x.id`,
      [JSON.stringify(links)],
    );
    const cubeMap = new Map<number, number>();
    for (const cu of meta.cubes) {
      const row = await one<{ cube_id: number }>(c, 'insert into epm.cube (tenant_id, app_id, name) values ($1, $2, $3) returning cube_id', [
        s.tenantId,
        app.app_id,
        cu.name,
      ]);
      cubeMap.set(cu.cube_id, row.cube_id);
      for (const d of cu.dim_ids) {
        await c.query('insert into epm.cube_dimension (tenant_id, cube_id, dim_id) values ($1, $2, $3)', [s.tenantId, row.cube_id, dimMap.get(d)]);
      }
    }
    await c.query('select epm.deploy_metadata($1)', [app.app_id]);

    for (const f of meta.forms) {
      await c.query(
        `insert into epm.form (tenant_id, app_id, cube_id, name, folder, description, definition, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.tenantId, app.app_id, cubeMap.get(f.cube_id), f.name, f.folder, f.description, JSON.stringify(f.definition), s.userId],
      );
    }
    for (const r of meta.reports ?? []) {
      await c.query(
        `insert into epm.report (tenant_id, app_id, cube_id, name, folder, description, definition, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [s.tenantId, app.app_id, cubeMap.get(r.cube_id), r.name, r.folder, r.description, JSON.stringify(r.definition), s.userId],
      );
    }
    for (const f of meta.import_formats) {
      const fmt = await one<{ format_id: string }>(
        c,
        `insert into epm.import_format (tenant_id, app_id, cube_id, name, definition, updated_by)
         values ($1, $2, $3, $4, $5, $6) returning format_id`,
        [s.tenantId, app.app_id, cubeMap.get(f.cube_id), f.name, JSON.stringify(f.definition), s.userId],
      );
      for (const r of f.mappings) {
        await c.query(
          `insert into epm.mapping_rule (tenant_id, app_id, format_id, dimension, rule_type, source, target, options, priority, description)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [s.tenantId, app.app_id, fmt.format_id, r.dimension, r.rule_type, r.source, r.target,
           r.options === null ? null : JSON.stringify(r.options), r.priority, r.description],
        );
      }
    }
    for (const d of datasets) {
      const ds = await one<{ dataset_id: string }>(
        c,
        `insert into epm.dataset (tenant_id, app_id, name, description, current_version) values ($1, $2, $3, $4, $5) returning dataset_id`,
        [s.tenantId, app.app_id, d.name, d.description, d.version],
      );
      await c.query(
        `insert into epm.dataset_version (tenant_id, dataset_id, version, file_id, sheets, uploaded_by) values ($1, $2, $3, null, $4, $5)`,
        [s.tenantId, ds.dataset_id, d.version, JSON.stringify(d.sheets), s.userId],
      );
      for (let i = 0; i < d.rows.length; i += 2000) {
        await c.query(
          `insert into epm.dataset_row (tenant_id, dataset_id, version, sheet, row_no, data)
           select $1, $2, $3, r->>'sheet', (r->>'row_no')::int, r->'data' from jsonb_array_elements($4::jsonb) r`,
          [s.tenantId, ds.dataset_id, d.version, JSON.stringify(d.rows.slice(i, i + 2000))],
        );
      }
    }
    return { appId: app.app_id, appName: app.name, memberMap, cubeMap };
  });

  // Cleaning up acts as the loader (marked by app.restoring_app), not as the requester, whose
  // session may be what failed (a user disabled mid-restore).
  const discard = async () => {
    await withActor(deps.db, systemActor(s.tenantId), async (c) => {
      await c.query("select set_config('app.restoring_app', $1, true) as discarding", [built.appId]);
      await c.query('select epm.discard_restoring_app($1)', [built.appId]);
    }).catch((err) => console.error('could not discard a failed restore', built.appId, err));
  };

  let cells = 0;
  const report = { roles_granted: [] as { email: string; role: string }[], grants_copied: 0, missing_users: [] as string[], missing_groups: [] as string[] };
  try {
    // 2. Data, in batches of restore transactions marked as this loader's.
    let batch: { k: number[]; v: number | string }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const payload = JSON.stringify({
        app_id: built.appId, source: 'restore', source_ref: `snapshot:${snap.snapshot_id}`,
        comment: `restored from the snapshot of ${stamp(snap.manifest!.taken_at)}`, cells: batch,
      });
      const r = await withSession(deps.db, s, async (c) => {
        await c.query("select set_config('app.restoring_app', $1, true)", [built.appId]);
        return one<{ r: { cell_count: number } }>(c, 'select epm.apply_changes($1::jsonb) as r', [payload]);
      });
      cells += r.r.cell_count;
      batch = [];
    };
    for (const line of facts()) {
      if (!cubeIds.has(line[0] as number) || line.slice(1, COORD_LENGTH).some((id) => id !== 0 && !deployedIds.has(id as number))) continue;
      const k = new Array<number>(COORD_LENGTH).fill(0);
      k[0] = built.cubeMap.get(line[0] as number)!;
      for (let i = 1; i < COORD_LENGTH; i++) k[i] = line[i] === 0 ? 0 : built.memberMap.get(line[i] as number)!;
      batch.push({ k, v: line[COORD_LENGTH]! });
      if (batch.length >= LOAD_BATCH) await flush();
    }
    await flush();

    // 3. Pending (saved, not deployed) metadata as the source had it, plan windows, access if asked,
    //    then open the application.
    await withSession(deps.db, s, async (c) => {
      const pending = meta.members.filter((m) => !deployedIds.has(m.member_id));
      const restoreApp = built;
      if (pending.length) {
        const dims = await c.query<{ dim_id: number; name: string }>('select dim_id, name from epm.dimension where app_id = $1', [restoreApp.appId]);
        const dimByName = new Map(dims.rows.map((d) => [d.name, d.dim_id]));
        const snapDimName = new Map(meta.dimensions.map((d) => [d.dim_id, d.name]));
        for (const m of pending) {
          const row = await one<{ member_id: number }>(
            c,
            `insert into epm.member (tenant_id, dim_id, name, alias, agg_op, sort_order, account_type, time_balance, formula)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning member_id`,
            [s.tenantId, dimByName.get(snapDimName.get(m.dim_id)!), m.name, m.alias, m.agg_op, m.sort_order, m.account_type, m.time_balance, m.formula],
          );
          restoreApp.memberMap.set(m.member_id, row.member_id);
        }
      }
      {
        // Every member's saved values (parent, aggregation, order) as they were, deployed or not.
        await c.query(
          `update epm.member m set parent_id = x.parent, agg_op = x.agg_op, sort_order = x.sort_order
             from (select (e->>'id')::int as id, (e->>'parent')::int as parent, e->>'agg_op' as agg_op, (e->>'sort_order')::int as sort_order
                     from jsonb_array_elements($1::jsonb) e) x
            where m.member_id = x.id`,
          [JSON.stringify(meta.members.map((m) => ({
            id: restoreApp.memberMap.get(m.member_id),
            parent: m.parent_id === null ? null : restoreApp.memberMap.get(m.parent_id) ?? null,
            agg_op: m.agg_op,
            sort_order: m.sort_order,
          })))],
        );
      }
      const mm = (id: number | null) => (id === null ? null : restoreApp.memberMap.get(id) ?? null);
      for (const w of meta.plan_windows) {
        if ([w.scenario_id, w.version_id, w.years_id].some((id) => mm(id) === null)) continue;
        await c.query(
          `insert into epm.plan_window (tenant_id, app_id, scenario_id, version_id, years_id, start_period_id, end_period_id, locked)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [s.tenantId, restoreApp.appId, mm(w.scenario_id), mm(w.version_id), mm(w.years_id), mm(w.start_period_id), mm(w.end_period_id), w.locked],
        );
      }
      if (opts.access === 'copy') {
        const users = new Map(
          (await c.query<{ user_id: string; email: string }>('select user_id, lower(email) as email from epm.app_user')).rows.map((r) => [r.email, r.user_id]),
        );
        const groups = new Map(
          (await c.query<{ group_id: string; name: string }>('select group_id, lower(name) as name from epm.principal_group')).rows.map((r) => [r.name, r.group_id]),
        );
        for (const r of meta.roles) {
          const userId = users.get(r.email.toLowerCase());
          if (!userId) { report.missing_users.push(r.email); continue; }
          const ins = await c.query(
            `insert into epm.user_role (tenant_id, user_id, app_id, role) values ($1, $2, $3, $4) on conflict do nothing`,
            [s.tenantId, userId, restoreApp.appId, r.role],
          );
          if (ins.rowCount) {
            report.roles_granted.push({ email: r.email, role: r.role });
            await c.query(
              `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'role_granted', $4)`,
              [s.tenantId, restoreApp.appId, s.userId, { email: r.email, role: r.role, from_snapshot: snap.snapshot_id }],
            );
          }
        }
        const copied: string[] = [];
        for (const g of meta.grants) {
          const principal = g.principal_type === 'user' ? users.get(g.principal.toLowerCase()) : groups.get(g.principal.toLowerCase());
          if (!principal) {
            (g.principal_type === 'user' ? report.missing_users : report.missing_groups).push(g.principal);
            continue;
          }
          if (mm(g.member_id) === null) continue;
          const ins = await c.query(
            `insert into epm.access_grant (tenant_id, app_id, principal_type, principal, member_id, scope, access)
             values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
            [s.tenantId, restoreApp.appId, g.principal_type, principal, mm(g.member_id), g.scope, g.access],
          );
          if (ins.rowCount) { report.grants_copied++; copied.push(g.principal); }
        }
        if (report.grants_copied) {
          await c.query(
            `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'grants_changed', $4)`,
            [s.tenantId, restoreApp.appId, s.userId, { count: report.grants_copied, principals: [...new Set(copied)], from_snapshot: snap.snapshot_id }],
          );
        }
        await c.query('select epm.rebuild_effective_access($1)', [restoreApp.appId]);
      }
      await c.query(`update epm.application set state = 'online' where app_id = $1`, [restoreApp.appId]);
      await c.query(
        `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'snapshot_restored', $4)`,
        [s.tenantId, sourceAppId ?? restoreApp.appId, s.userId, { snapshot_id: snap.snapshot_id, target: 'new_app', new_app_id: restoreApp.appId, cells, skipped,
          access: opts.access, roles_granted: report.roles_granted }],
      );
    });
  } catch (err) {
    // Nothing half-built stays behind: remove the new application, then report what went wrong.
    await discard();
    throw err;
  }
  return {
    target: 'new_app',
    snapshot_id: snap.snapshot_id,
    app_id: built.appId,
    name: built.appName,
    cells,
    skipped,
    access: opts.access,
    roles_granted: report.roles_granted,
    grants_copied: report.grants_copied,
    access_in_snapshot: { roles: meta.roles.length, grants: meta.grants.length },
    hierarchy_warnings: hierarchyWarnings,
    missing_users: [...new Set(report.missing_users)],
    missing_groups: [...new Set(report.missing_groups)],
  };
}

// ---------------------------------------------------------------------------
// Restore data over the existing application (optionally into another version)
// ---------------------------------------------------------------------------

type InPlace = Extract<RestoreBody, { target: 'in_place' }>;

/**
 * The scenarios or versions a restore covers: those asked for, which must be in the snapshot;
 * by default every one the snapshot has (never ones created after it).
 */
function pick(requested: string[] | undefined, inSnapshot: string[], what: string): string[] {
  const have = new Map(inSnapshot.map((n) => [n.toLowerCase(), n]));
  if (!requested) return inSnapshot;
  const outside = requested.filter((n) => !have.has(n.toLowerCase()));
  if (outside.length) throw new HttpError(422, `the snapshot has no ${what} ${outside.join(', ')}`);
  return [...new Set(requested.map((n) => have.get(n.toLowerCase())!))];
}

/** Scenarios and versions a restore covers (by default every one the snapshot has). */
export function snapshotScope(meta: Metadata, snap: SnapshotRow, scen?: string[], vers?: string[]) {
  const namesOf = (type: string) => {
    const dim = meta.dimensions.find((d) => d.type === type);
    return meta.members.filter((m) => m.dim_id === dim?.dim_id).map((m) => m.name);
  };
  return {
    scenarios: pick(scen, snap.scope.scenarios ?? namesOf('scenario'), 'scenario'),
    versions: pick(vers, snap.scope.versions ?? namesOf('version'), 'version'),
  };
}

export async function restoreInPlace(deps: SnapshotDeps, s: SessionContext, appId: string, snapshotId: string, body: InPlace) {
  const snap = await withSession(deps.db, s, async (c) => {
    await requireApp(c, appId, 'app_admin');
    return loadSnapshot(c, appId, snapshotId);
  });
  const { meta, facts } = await openSnapshot(deps.blobs, snap);

  const { scenarios, versions } = snapshotScope(meta, snap, body.scenarios, body.versions);
  if (body.into_version && versions.length !== 1) throw new HttpError(422, 'restoring into another version needs exactly one version');

  const plan = (c: Client) => planSnapshotData(c, appId, { meta, facts }, { scenarios, versions, intoVersion: body.into_version });

  const base = { target: 'in_place' as const, snapshot_id: snap.snapshot_id, scenarios, versions, into_version: body.into_version ?? null };
  const preview = await withSession(deps.db, s, plan);
  if (body.dry_run) return { ...base, dry_run: true, ...preview.summary, txn_id: null, cell_count: 0, max_cells: MAX_IN_PLACE_CELLS };
  if (preview.changes.length > MAX_IN_PLACE_CELLS) {
    throw new HttpError(422, `this restore would change ${preview.changes.length} cells; restore at most ${MAX_IN_PLACE_CELLS} at a time by choosing scenarios or versions, or restore into a new application`);
  }
  if (preview.changes.length === 0) return { ...base, dry_run: false, ...preview.summary, txn_id: null, cell_count: 0, pre_restore_snapshot_id: null };

  // Keep what is there now, then write the snapshot's values as one undoable transaction.
  const pre = await createSnapshot(deps, s, appId, {
    kind: 'pre_restore',
    scope: await existingScope(deps.db, s, appId, scenarios, preview.versionNames),
    comment: `before restoring the snapshot of ${stamp(snap.manifest!.taken_at)}`,
  });
  return retrying(() => withSession(deps.db, s, async (c) => {
    const p = await plan(c);
    if (p.changes.length > MAX_IN_PLACE_CELLS) throw new HttpError(422, `this restore would change ${p.changes.length} cells; narrow the scope`);
    const r = p.changes.length
      ? (await one<{ r: { txn_id: number | null; cell_count: number } }>(c, 'select epm.apply_changes($1::jsonb) as r', [
          JSON.stringify({
            app_id: appId, source: 'restore', source_ref: `snapshot:${snap.snapshot_id}`,
            comment: body.comment ?? `restored from the snapshot of ${stamp(snap.manifest!.taken_at)}${body.into_version ? ` into ${body.into_version}` : ''}`,
            cells: p.changes,
          }),
        ])).r
      : { txn_id: null, cell_count: 0 };
    // apply_changes ended holding the application's chain lock, so no later writer can commit
    // before us. Anything still different now was committed by someone else after our plan:
    // roll back and plan again.
    if ((await plan(c)).changes.length) {
      throw new HttpError(409, 'the data changed while it was being restored; run the restore again', undefined, 'NXRTY');
    }
    await c.query(
      `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'snapshot_restored', $4)`,
      [s.tenantId, appId, s.userId, { snapshot_id: snap.snapshot_id, target: 'in_place', txn_id: r.txn_id, cells: r.cell_count,
        scenarios, versions, into_version: body.into_version ?? null, pre_restore_snapshot_id: pre.snapshot_id }],
    );
    return { ...base, dry_run: false, ...p.summary, ...r, pre_restore_snapshot_id: pre.snapshot_id };
  }));
}

/**
 * What an in-place restore of a snapshot's data would change: the snapshot's cells for the chosen
 * scenarios and versions, matched to today's members by name, against today's cells in the same
 * scope. Cells on members in opts.keep are left as they are.
 */
export async function planSnapshotData(
  c: Client,
  appId: string,
  src: { meta: Metadata; facts: () => Generator<FactLine> },
  opts: { scenarios: string[]; versions: string[]; intoVersion?: string; keep?: Set<number> },
) {
  const { meta, facts } = src;
  const snapDims = new Map(meta.dimensions.map((d) => [d.dim_id, d]));
  const snapMembers = new Map(meta.members.map((m) => [m.member_id, m]));
  const wantScen = new Set(opts.scenarios.map((x) => x.toLowerCase()));
  const wantVer = new Set(opts.versions.map((x) => x.toLowerCase()));
  const keep = opts.keep ?? new Set<number>();
  const kept = (k: number[]) => keep.size > 0 && k.some((id, i) => i > 0 && keep.has(id));
  let keptCells = 0;
  const dims = (await c.query<DimRow>('select dim_id, name, dim_type as type, slot, secured from epm.dimension where app_id = $1', [appId])).rows;
  const dimByName = new Map(dims.map((d) => [d.name.toLowerCase(), d]));
  const leaves = await c.query<{ member_id: number; dim_id: number; name: string }>(
    `select m.member_id, m.dim_id, m.name from epm.member m join epm.dimension d on d.dim_id = m.dim_id
      where d.app_id = $1 and m.is_leaf and m.tree_ordinal is not null`,
    [appId],
  );
  const leafByName = new Map(leaves.rows.map((r) => [`${r.dim_id}\u0000${r.name.toLowerCase()}`, r.member_id]));
  const cubes = (await c.query<{ cube_id: number; name: string; dim_ids: number[] }>(
    `select cu.cube_id, cu.name, array_agg(cd.dim_id) as dim_ids from epm.cube cu join epm.cube_dimension cd on cd.cube_id = cu.cube_id
      where cu.app_id = $1 group by cu.cube_id, cu.name`,
    [appId],
  )).rows;
  const cubeByName = new Map(cubes.map((cu) => [cu.name.toLowerCase(), cu]));

  let target: number | null = null;
  const verDim = dims.find((d) => d.type === 'version');
  if (opts.intoVersion) {
    target = leafByName.get(`${verDim?.dim_id}\u0000${opts.intoVersion.toLowerCase()}`) ?? null;
    if (!target) throw new HttpError(422, `Version ${opts.intoVersion} must exist as a deployed leaf member`);
  }

  type CubePlan = { cubeId: number; moves: { from: number; to: number; dimId: number }[] } | { skip: string };
  const cubePlans = new Map<number, CubePlan>();
  for (const sc of meta.cubes) {
    const cur = cubeByName.get(sc.name.toLowerCase());
    if (!cur) { cubePlans.set(sc.cube_id, { skip: `cube ${sc.name} no longer exists` }); continue; }
    const curDims = new Set(cur.dim_ids);
    const moves: { from: number; to: number; dimId: number }[] = [];
    let skip: string | null = null;
    for (const id of sc.dim_ids) {
      const sd = snapDims.get(id)!;
      const cd = dimByName.get(sd.name.toLowerCase());
      if (!cd || !curDims.has(cd.dim_id)) { skip = `dimension ${sd.name} is no longer in cube ${sc.name}`; break; }
      moves.push({ from: coordPos(sd.type, sd.slot), to: coordPos(cd.type, cd.slot), dimId: cd.dim_id });
    }
    if (!skip && moves.length !== cur.dim_ids.length) skip = `cube ${sc.name} has dimensions the snapshot lacks`;
    cubePlans.set(sc.cube_id, skip ? { skip } : { cubeId: cur.cube_id, moves });
  }

  const desired = new Map<string, { k: number[]; v: number | string }>();
  const skipped = new Map<string, number>();
  const scenPos = 1, verPos = 2;
  for (const line of facts()) {
    const scenName = snapMembers.get(line[scenPos] as number)?.name.toLowerCase();
    const verName = snapMembers.get(line[verPos] as number)?.name.toLowerCase();
    if (!wantScen.has(scenName ?? '') || !wantVer.has(verName ?? '')) continue;
    const cp = cubePlans.get(line[0] as number);
    if (!cp) { skipped.set('cube unknown to the snapshot', (skipped.get('cube unknown to the snapshot') ?? 0) + 1); continue; }
    if ('skip' in cp) { skipped.set(cp.skip, (skipped.get(cp.skip) ?? 0) + 1); continue; }
    const k = new Array<number>(COORD_LENGTH).fill(0);
    k[0] = cp.cubeId;
    let missing: string | null = null;
    for (const mv of cp.moves) {
      if (target && mv.to === verPos) { k[verPos] = target; continue; }
      const old = snapMembers.get(line[mv.from] as number);
      const id = old ? leafByName.get(`${mv.dimId}\u0000${old.name.toLowerCase()}`) : undefined;
      if (!id) { missing = `${snapDims.get(old?.dim_id ?? -1)?.name ?? 'member'} ${old?.name ?? `#${line[mv.from]}`} is no longer a deployed leaf`; break; }
      k[mv.to] = id;
    }
    if (missing) { skipped.set(missing, (skipped.get(missing) ?? 0) + 1); continue; }
    if (kept(k)) { keptCells++; continue; }
    desired.set(k.join(','), { k, v: line[COORD_LENGTH]! });
  }

  // Current cells in the same scope: the scenarios and versions by name, in the cubes the snapshot has.
  const curIds = (dimType: string, names: Set<string>) => {
    const d = dims.find((x) => x.type === dimType);
    return leaves.rows.filter((r) => r.dim_id === d?.dim_id && names.has(r.name.toLowerCase())).map((r) => r.member_id);
  };
  const curScen = curIds('scenario', wantScen);
  const curVer = target ? [target] : curIds('version', wantVer);
  const cubeIds = [...cubePlans.values()].flatMap((p) => ('cubeId' in p ? [p.cubeId] : []));
  const current = await c.query<{ k: number[]; v: string }>(
    `select array[cube_id, scenario_id, version_id, years_id, period_id, entity_id, account_id, department_id,
                  c1, c2, c3, c4, c5, c6, c7, c8] as k, value::text as v
       from epm.fact
      where app_id = $1 and cube_id = any($2::int[]) and scenario_id = any($3::int[]) and version_id = any($4::int[])`,
    [appId, cubeIds, curScen, curVer],
  );
  const changes: { k: number[]; v: number | string | null }[] = [];
  let unchanged = 0;
  let cleared = 0;
  const seen = new Set<string>();
  for (const r of current.rows) {
    if (kept(r.k)) { keptCells++; continue; }
    const key = r.k.join(',');
    seen.add(key);
    const want = desired.get(key);
    if (!want) { changes.push({ k: r.k, v: null }); cleared++; }
    else if (!sameValue(want.v, r.v)) changes.push(want);
    else unchanged++;
  }
  for (const [key, want] of desired) if (!seen.has(key)) changes.push(want);
  return {
    changes,
    summary: {
      cells_set: changes.length - cleared,
      cells_cleared: cleared,
      unchanged,
      skipped: [...skipped.values()].reduce((a, b) => a + b, 0),
      skipped_reasons: [...skipped.entries()].slice(0, 20).map(([reason, count]) => ({ reason, count })),
      kept: keptCells,
    },
    versionNames: target ? [opts.intoVersion!] : opts.versions,
  };
}

/** The pre-restore snapshot's scope: the names that exist in the application today. */
async function existingScope(db: Database, s: SessionContext, appId: string, scenarios: string[], versions: string[]): Promise<SnapshotScope> {
  return withSession(db, s, async (c) => {
    const keep = async (type: string, names: string[]) => {
      const res = await c.query<{ name: string }>(
        `select m.name from epm.member m join epm.dimension d on d.dim_id = m.dim_id
          where d.app_id = $1 and d.dim_type = $2 and lower(m.name) = any($3::text[])`,
        [appId, type, names.map((n) => n.toLowerCase())],
      );
      return res.rows.length ? res.rows.map((r) => r.name) : undefined;
    };
    const scope: SnapshotScope = {};
    const sc = await keep('scenario', scenarios);
    const ve = await keep('version', versions);
    if (sc) scope.scenarios = sc;
    if (ve) scope.versions = ve;
    return scope;
  });
}

// ---------------------------------------------------------------------------
// Retention and the nightly job
// ---------------------------------------------------------------------------

export const RETENTION = { daily: 30, monthly: 12 };

/**
 * Nightly snapshots: keep the newest 30, plus the newest of each month for 12 months.
 * Pre-restore snapshots expire after 90 days; manual snapshots are kept.
 */
export async function applyRetention(deps: SnapshotDeps, actor: Actor, appId: string, now = new Date()): Promise<string[]> {
  const rows = await withActor(deps.db, actor, (c) =>
    c.query<{ snapshot_id: string; kind: string; created_at: Date; expires_at: Date | null; storage_prefix: string; manifest: Manifest | null }>(
      `select snapshot_id, kind, created_at, expires_at, storage_prefix, manifest from epm.snapshot
        where app_id = $1 and status = 'complete' order by created_at desc`,
      [appId],
    ),
  );
  const keep = new Set<string>();
  const nightly = rows.rows.filter((r) => r.kind === 'nightly');
  for (const r of nightly.slice(0, RETENTION.daily)) keep.add(r.snapshot_id);
  const months = new Set<string>();
  for (const r of nightly) {
    const m = new Date(r.created_at).toISOString().slice(0, 7);
    if (months.has(m)) continue;
    if (months.size >= RETENTION.monthly) break;
    months.add(m);
    keep.add(r.snapshot_id);
  }
  const expire = rows.rows.filter((r) =>
    r.kind === 'nightly' ? !keep.has(r.snapshot_id) : r.expires_at !== null && new Date(r.expires_at) <= now,
  );
  for (const r of expire) {
    const keys = [...(r.manifest?.files ?? []).map((f) => `${r.storage_prefix}/${f.name}`), `${r.storage_prefix}/manifest.json`];
    await deps.blobs.delete(keys);
    await withActor(deps.db, actor, (c) => c.query(`update epm.snapshot set status = 'expired' where snapshot_id = $1`, [r.snapshot_id]));
  }
  return expire.map((r) => r.snapshot_id);
}

/**
 * The scheduled job: a nightly snapshot of every online application that changed since its
 * last one (data, deployed or saved metadata, forms, imports, datasets, roles, grants, plan
 * windows), then retention. One application's failure does not stop the others. The job key
 * (Worker secret JOB_KEY) is what lets it list applications across tenants.
 */
export async function runNightlySnapshots(deps: SnapshotDeps, opts: { jobKey: string; now?: Date }) {
  const conn = await deps.db.connect();
  let targets: { tenant_id: string; app_id: string }[];
  let swept: { tenant_id: string; app_id: string }[];
  try {
    await conn.client.query('begin');
    // Copies whose restore died without cleaning up (the Worker stopped part way) are removed.
    swept = (await conn.client.query<{ tenant_id: string; app_id: string }>(
      'select tenant_id, app_id from epm.sweep_restoring_apps($1, $2)', [opts.jobKey, STALE_RUNNING_HOURS],
    )).rows;
    targets = (await conn.client.query<{ tenant_id: string; app_id: string }>('select tenant_id, app_id from epm.snapshot_targets($1)', [opts.jobKey])).rows;
    await conn.client.query('commit');
  } catch (err) {
    await conn.client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await conn.release();
  }
  const results: { app_id: string; status: 'taken' | 'unchanged' | 'failed' | 'discarded'; snapshot_id?: string; expired: number; error?: string }[] =
    swept.map((x) => ({ app_id: x.app_id, status: 'discarded', expired: 0 }));
  for (const t of targets) {
    const actor = systemActor(t.tenant_id);
    try {
      const state = await withActor(deps.db, actor, async (c) => {
        // A snapshot left 'running' by a run that died (a Worker stopped mid-export) is marked
        // failed, and whatever it had written is removed.
        const stale = await c.query<{ storage_prefix: string }>(
          `update epm.snapshot set status = 'failed', error = 'did not finish', completed_at = now()
            where app_id = $1 and status = 'running' and created_at < now() - make_interval(hours => $2)
            returning storage_prefix`,
          [t.app_id, STALE_RUNNING_HOURS],
        );
        for (const r of stale.rows) await deps.blobs.delete(await deps.blobs.list(`${r.storage_prefix}/`));
        const app = await one<{ seq: number; hash: string }>(
          c,
          `select coalesce((select max(chain_seq) from epm.change_txn where app_id = $1), 0)::bigint as seq,
                  epm.app_fingerprint($1) as hash`,
          [t.app_id],
        );
        const last = await maybeOne<{ high_chain_seq: number; content_hash: string | null }>(
          c,
          `select high_chain_seq, content_hash from epm.snapshot
            where app_id = $1 and kind = 'nightly' and status = 'complete' order by created_at desc limit 1`,
          [t.app_id],
        );
        return { unchanged: !!last && last.high_chain_seq === app.seq && last.content_hash === app.hash };
      });
      let snapshotId: string | undefined;
      if (!state.unchanged) snapshotId = (await createSnapshot(deps, actor, t.app_id, { kind: 'nightly' })).snapshot_id;
      const expired = await applyRetention(deps, actor, t.app_id, opts.now);
      results.push({ app_id: t.app_id, status: state.unchanged ? 'unchanged' : 'taken', snapshot_id: snapshotId, expired: expired.length });
    } catch (err) {
      results.push({ app_id: t.app_id, status: 'failed', expired: 0, error: String((err as Error).message ?? err) });
    }
  }
  return results;
}
