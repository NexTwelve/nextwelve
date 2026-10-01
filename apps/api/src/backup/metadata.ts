import { z } from 'zod';
import type { Client, SessionContext } from '../db.js';
import { maybeOne, one, retrying, withSession } from '../db.js';
import { HttpError } from '../errors.js';
import { type Kind, loadDefinitions } from '../definitions.js';
import { FormDefinition, validatePlacement } from '../forms.js';
import { writeDefinition } from '../history.js';
import { type DimInfo, loadCubeById, loadDimensions, requireApp } from '../model.js';
import { ReportDefinition } from '../reports.js';
import {
  createSnapshot,
  loadSnapshot,
  MAX_IN_PLACE_CELLS,
  type Metadata,
  openSnapshot,
  planSnapshotData,
  type SnapshotDeps,
  type SnapshotRow,
  snapshotScope,
} from './snapshots.js';

/**
 * Put an application's metadata back as it was at a moment in time, or as a snapshot of it holds it:
 *
 *   members      every member of the chosen dimensions as deployed then: members deleted since come
 *                back under their original ids (so their history and old data line up again),
 *                renames, moves and property changes are undone, members added since are removed,
 *                except members added since that hold data (or that a plan window uses), which stay
 *                with their data, along with the parents they need. Then one deploy.
 *   definitions  forms and reports as they were saved then; ones created since stay unless asked.
 *   data         optionally, the data too, to the same moment (members kept above keep their cells).
 *
 * A preview runs the whole restore inside the transaction and rolls it back. A real restore first
 * takes a pre_restore snapshot of the application, then runs as one transaction.
 */
export const MetadataRestoreBody = z
  .object({
    at: z.iso.datetime({ offset: true }).optional(),
    snapshot_id: z.uuid().optional(),
    dimensions: z.array(z.string().min(1).max(200)).max(32).optional(),
    members: z.boolean().default(true),
    definitions: z.boolean().default(true),
    remove_new_definitions: z.boolean().default(false),
    data: z.boolean().default(false),
    dry_run: z.boolean().default(false),
    comment: z.string().max(500).optional(),
  })
  .refine((b) => (b.at === undefined) !== (b.snapshot_id === undefined), { message: 'give either at or snapshot_id' })
  .refine((b) => b.members || b.definitions || b.data, { message: 'choose members, definitions or data to restore' });
export type MetadataRestoreBody = z.infer<typeof MetadataRestoreBody>;

const LIST_LIMIT = 200;

interface TMember {
  member_id: number;
  dim_id: number;
  name: string;
  alias: string | null;
  parent_id: number | null;
  sort_order: number;
  agg_op: string;
  account_type: string | null;
  time_balance: string | null;
  formula: string | null;
}
const ATTRS = ['alias', 'sort_order', 'agg_op', 'account_type', 'time_balance', 'formula'] as const;

interface TDef {
  kind: Kind;
  id: string | null;
  name: string;
  cube_id: number;
  folder: string | null;
  description: string | null;
  definition: unknown;
}

interface Source {
  type: 'point_in_time' | 'snapshot';
  label: string;
  at: string | null;
  metadataRev: number | null;
  snapshot: SnapshotRow | null;
  opened: Awaited<ReturnType<typeof openSnapshot>> | null;
  members: TMember[];
  /** Dimensions the restore point knows about. */
  dimIds: Set<number>;
  forms: TDef[] | null;
  /** null: the source has no reports (a snapshot from before reports were kept in snapshots). */
  reports: TDef[] | null;
  grants: Metadata['grants'] | null;
}

// ---------------------------------------------------------------------------
// Where the metadata comes from
// ---------------------------------------------------------------------------

async function pointInTimeSource(c: Client, appId: string, at: string, wantMembers: boolean, wantDefinitions: boolean): Promise<Source> {
  const t = await one<{ too_early: boolean; future: boolean; history_from: string }>(
    c,
    `select $2::timestamptz < history_from as too_early, $2::timestamptz > clock_timestamp() as future,
            to_char(history_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as history_from
       from epm.application where app_id = $1`,
    [appId, at],
  );
  if (t.future) throw new HttpError(422, 'that time is in the future');
  if (t.too_early) throw new HttpError(422, `metadata history for this application starts at ${t.history_from}; restore from a snapshot taken before then`);
  const rev = await maybeOne<{ rev: number | null }>(c, 'select max(metadata_rev) as rev from epm.metadata_rev where app_id = $1 and deployed_at <= $2', [appId, at]);
  const revNo = rev?.rev ?? null;
  if (revNo === null && wantMembers) throw new HttpError(422, 'nothing had been deployed in this application at that time');
  const members = revNo === null ? [] : (await c.query<TMember>(
    `select member_id, dim_id, name, alias, parent_id, sort_order, agg_op, account_type, time_balance, formula
       from epm.member_version where app_id = $1 and from_rev <= $2 and (to_rev is null or to_rev > $2)`,
    [appId, revNo],
  )).rows;
  let forms: TDef[] | null = null;
  let reports: TDef[] | null = null;
  if (wantDefinitions) {
    const defs = (await c.query<TDef & { deleted: boolean }>(
      `select * from (
         select distinct on (artifact_id) kind, artifact_id::text as id, name, cube_id, folder, description, definition, deleted
           from epm.artifact_version where app_id = $1 and changed_at <= $2
          order by artifact_id, version desc) v
        where not deleted`,
      [appId, at],
    )).rows;
    forms = defs.filter((d) => d.kind === 'form');
    reports = defs.filter((d) => d.kind === 'report');
  }
  const when = await one<{ at: string }>(c, `select to_char($1::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`, [at]);
  return {
    type: 'point_in_time', label: when.at, at: when.at, metadataRev: revNo, snapshot: null, opened: null, members,
    dimIds: new Set(members.map((m) => m.dim_id)), forms, reports, grants: null,
  };
}

function snapshotSource(snap: SnapshotRow, opened: Awaited<ReturnType<typeof openSnapshot>>): Source {
  const { meta } = opened;
  const v2 = (snap.manifest?.schema_ver ?? 1) >= 2;
  const members: TMember[] = meta.members
    .filter((m) => m.deployed !== false)
    .map((m) => ({
      member_id: m.member_id, dim_id: m.dim_id, name: m.name, alias: m.alias,
      // The tree as deployed when the snapshot was taken (format 1 kept only the saved parent).
      parent_id: v2 ? (m.deployed_parent_id ?? null) : m.parent_id,
      sort_order: m.deployed_sort_order ?? m.sort_order,
      agg_op: v2 ? (m.deployed_agg_op ?? m.agg_op) : m.agg_op,
      account_type: m.account_type, time_balance: m.time_balance, formula: m.formula,
    }));
  const def = (kind: Kind) => (d: Metadata['forms'][number]): TDef => ({
    kind, id: d.id ?? null, name: d.name, cube_id: d.cube_id, folder: d.folder, description: d.description, definition: d.definition,
  });
  return {
    type: 'snapshot',
    label: `the snapshot of ${snap.manifest!.taken_at}`,
    at: null,
    metadataRev: snap.metadata_rev,
    snapshot: snap,
    opened,
    members,
    dimIds: new Set(meta.dimensions.map((d) => d.dim_id)),
    forms: meta.forms.map(def('form')),
    reports: meta.reports ? meta.reports.map(def('report')) : null,
    grants: meta.grants,
  };
}

// ---------------------------------------------------------------------------
// The restore itself
// ---------------------------------------------------------------------------

/** Saved-but-not-deployed member changes per dimension: live rows against the deployed versions. */
async function pendingByDim(c: Client, appId: string): Promise<Map<number, number>> {
  const res = await c.query<{ dim_id: number; n: number }>(
    `with live as (select m.* from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1),
          dep as (select v.* from epm.member_version v where v.app_id = $1 and v.to_rev is null),
          diff as (
            select coalesce(l.dim_id, p.dim_id) as dim_id, coalesce(l.member_id, p.member_id) as member_id
              from live l full join dep p on p.member_id = l.member_id
             where l.member_id is null or p.member_id is null
                or (l.name, l.alias, l.parent_id, l.sort_order, l.agg_op, l.account_type, l.time_balance, l.formula)
                   is distinct from (p.name, p.alias, p.parent_id, p.sort_order, p.agg_op, p.account_type, p.time_balance, p.formula)
            union
            -- Deployed members deleted since (the closure keeps them until the next deploy).
            select ma.dim_id, ma.descendant_id
              from epm.member_ancestor ma join epm.dimension d on d.dim_id = ma.dim_id
             where d.app_id = $1 and ma.depth = 0
               and not exists (select 1 from epm.member m where m.member_id = ma.descendant_id))
     select dim_id, count(*)::int as n from diff group by 1`,
    [appId],
  );
  return new Map(res.rows.map((r) => [r.dim_id, r.n]));
}

/** Of these members, the ones that hold data or that a plan window uses (and so must stay). */
async function inUse(c: Client, appId: string, dim: DimInfo, ids: number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const res = await c.query<{ id: number; cells: number }>(
    `select x.id, (select count(*)::int from epm.fact f where f.app_id = $2 and f.${dim.column} = x.id) as cells
       from unnest($1::int[]) x(id)
      where exists (select 1 from epm.fact f where f.app_id = $2 and f.${dim.column} = x.id)
         or exists (select 1 from epm.plan_window w
                     where x.id in (w.scenario_id, w.version_id, w.years_id, w.start_period_id, w.end_period_id))`,
    [ids, appId],
  );
  return new Map(res.rows.map((r) => [r.id, r.cells]));
}

interface DimReport {
  dimension: string;
  recreated: string[];
  changed: { name: string; was?: string; fields: string[] }[];
  removed: string[];
  kept: { name: string; cells: number }[];
  conflicts: string[];
  pending_discarded: number;
  note?: string;
}

export interface MetadataRestoreResult {
  dry_run: boolean;
  source: { type: string; at: string | null; snapshot_id: string | null; metadata_rev: number | null };
  members: { dimensions: DimReport[]; deployed: boolean; metadata_rev: number | null; grants_restored: number; notes: string[] } | null;
  definitions: {
    created: { type: Kind; name: string }[];
    updated: { type: Kind; name: string }[];
    unchanged: number;
    removed: { type: Kind; name: string }[];
    kept_new: { type: Kind; name: string }[];
    invalid: { type: Kind; name: string; message: string }[];
    notes: string[];
  } | null;
  data: { cells_set: number; cells_cleared: number; parents_cleared: number; kept: number; skipped: number; txn_ids: number[]; max_cells: number; over_limit: boolean } | null;
  changes: number;
  pre_restore_snapshot_id: string | null;
}

const cap = <T>(list: T[]) => list.slice(0, LIST_LIMIT);

async function run(c: Client, s: SessionContext, appId: string, src: Source, body: MetadataRestoreBody, preview: boolean): Promise<MetadataRestoreResult> {
  await c.query('select 1 from epm.application where app_id = $1 for update', [appId]);
  const dims = await loadDimensions(c, appId);
  const result: MetadataRestoreResult = {
    dry_run: preview,
    source: { type: src.type, at: src.at, snapshot_id: src.snapshot?.snapshot_id ?? null, metadata_rev: src.metadataRev },
    members: null,
    definitions: null,
    data: null,
    changes: 0,
    pre_restore_snapshot_id: null,
  };
  const keep = new Set<number>();

  // ---- Members: work out the whole plan before touching anything.
  type DimPlan = {
    dim: DimInfo;
    current: Map<number, TMember>;
    /** Every member that will exist afterwards, as it will be: the restore point's, plus kept ones. */
    final: Map<number, TMember>;
    remove: number[];
    recreate: number[];
    kept: Set<number>;
    report: DimReport;
  };
  const plans: DimPlan[] = [];
  let parentsWithData: { dim: DimInfo; ids: number[] }[] = [];
  if (body.members) {
    const wanted = body.dimensions
      ? [...new Map(body.dimensions.map((n) => {
          const d = dims.find((x) => x.name.toLowerCase() === n.toLowerCase());
          if (!d) throw new HttpError(422, `no dimension named ${n}`);
          return [d.dimId, d] as const;
        })).values()]
      : dims;
    const pending = await pendingByDim(c, appId);
    // A dimension the restore point knows nothing about is left as it is, so like one outside the
    // scope, its saved-but-undeployed edits would be published by the deploy below.
    const restorable = (d: DimInfo) => src.dimIds.has(d.dimId) && src.members.some((m) => m.dim_id === d.dimId);
    const scope = new Set(wanted.filter(restorable).map((d) => d.dimId));
    const blocked = dims.filter((d) => !scope.has(d.dimId) && (pending.get(d.dimId) ?? 0) > 0);
    if (blocked.length) {
      throw new HttpError(409, `${blocked.map((d) => d.name).join(', ')} ${blocked.length === 1 ? 'has' : 'have'} saved changes that are not deployed; deploy them first or include ${blocked.length === 1 ? 'it' : 'them'} in the restore`);
    }
    result.members = { dimensions: [], deployed: false, metadata_rev: null, grants_restored: 0, notes: [] };
    for (const dim of wanted) {
      const report: DimReport = { dimension: dim.name, recreated: [], changed: [], removed: [], kept: [], conflicts: [], pending_discarded: pending.get(dim.dimId) ?? 0 };
      if (!scope.has(dim.dimId)) {
        report.note = `${dim.name} had no deployed members at the restore point; left as it is`;
        report.pending_discarded = 0;
        result.members.dimensions.push(report);
        continue;
      }
      const target = new Map(src.members.filter((m) => m.dim_id === dim.dimId).map((m) => [m.member_id, m]));
      const cols = 'member_id, dim_id, name, alias, parent_id, sort_order, agg_op, account_type, time_balance, formula';
      const current = new Map((await c.query<TMember>(`select ${cols} from epm.member where dim_id = $1`, [dim.dimId])).rows.map((m) => [m.member_id, m]));
      const deployed = new Map((await c.query<TMember>(
        `select ${cols} from epm.member_version where app_id = $1 and dim_id = $2 and to_rev is null`, [appId, dim.dimId],
      )).rows.map((m) => [m.member_id, m]));

      // Members added since that are in use stay, as they are deployed (saved-but-undeployed edits to
      // them are undone like any others), together with the deployed parents they hang under.
      const added = [...current.keys()].filter((id) => !target.has(id));
      const used = await inUse(c, appId, dim, added);
      const kept = new Set<number>();
      for (const id of used.keys()) {
        for (let cur: number | null = id; cur !== null && !target.has(cur) && !kept.has(cur); cur = (deployed.get(cur) ?? current.get(cur))?.parent_id ?? null) {
          if (!current.has(cur)) break;
          kept.add(cur);
        }
      }
      const remove = added.filter((id) => !kept.has(id));

      // Names: kept members first, then members that exist now, then ones coming back. A member whose
      // name is taken keeps the name it has now; one coming back whose name is taken stays away.
      const final = new Map<number, TMember>();
      const owner = new Map<string, number>();
      const skipped = new Set<number>();
      const take = (m: TMember, name: string) => { owner.set(name.toLowerCase(), m.member_id); final.set(m.member_id, { ...m, name }); };
      for (const id of kept) {
        const m = deployed.get(id) ?? current.get(id)!;
        if (!owner.has(m.name.toLowerCase())) take(m, m.name);
        else { take(m, current.get(id)!.name); }
      }
      const existing = [...target.values()].filter((t) => current.has(t.member_id));
      const returning = [...target.values()].filter((t) => !current.has(t.member_id));
      for (const t of existing) {
        if (!owner.has(t.name.toLowerCase())) { take(t, t.name); continue; }
        const now = current.get(t.member_id)!.name;
        const by = current.get(owner.get(t.name.toLowerCase())!)?.name ?? t.name;
        if (!owner.has(now.toLowerCase())) {
          take(t, now);
          report.conflicts.push(`${now} keeps its name: ${t.name} is taken by ${by}`);
        } else {
          const name = `${t.name} (${t.member_id})`;
          take(t, name);
          report.conflicts.push(`${name}: both ${t.name} and ${now} are taken`);
        }
      }
      for (const t of returning) {
        if (!owner.has(t.name.toLowerCase())) { take(t, t.name); continue; }
        skipped.add(t.member_id);
        report.conflicts.push(`${t.name} was not brought back: a member that stays has that name`);
      }
      // Parents: the restore point's, or the nearest ancestor that will exist; kept members keep their deployed parent.
      for (const [id, m] of final) {
        const up = (x: number) => (kept.has(id) ? (deployed.get(x) ?? current.get(x))?.parent_id : target.get(x)?.parent_id) ?? null;
        let p = m.parent_id;
        for (let guard = 0; p !== null && !final.has(p) && guard < 10_000; guard++) p = up(p);
        final.set(id, { ...m, parent_id: p !== null && final.has(p) ? p : null });
      }
      const recreate = returning.filter((t) => !skipped.has(t.member_id)).map((t) => t.member_id);

      for (const [id, f] of final) {
        const cur = current.get(id);
        if (!cur) continue;
        const fields: string[] = [];
        if (cur.name !== f.name) fields.push('name');
        if (cur.parent_id !== f.parent_id) fields.push('parent');
        for (const a of ATTRS) if ((cur[a] ?? null) !== (f[a] ?? null)) fields.push(a);
        if (fields.length) report.changed.push({ name: f.name, ...(fields.includes('name') ? { was: cur.name } : {}), fields });
      }
      report.recreated = recreate.map((id) => final.get(id)!.name);
      report.removed = remove.map((id) => current.get(id)!.name);
      report.kept = [...kept].map((id) => ({ name: final.get(id)!.name, cells: used.get(id) ?? 0 }));

      // Members that will have children but hold data now.
      const parents = new Set<number>();
      for (const f of final.values()) if (f.parent_id !== null) parents.add(f.parent_id);
      const withData = [...(await inUse(c, appId, dim, [...parents].filter((id) => current.has(id)))).entries()].filter(([, n]) => n > 0).map(([id]) => id);
      if (withData.length) parentsWithData.push({ dim, ids: withData });

      plans.push({ dim, current, final, remove, recreate, kept, report });
      result.members.dimensions.push(report);
    }
    if (parentsWithData.length && !body.data) {
      const names = parentsWithData.flatMap((p) => p.ids.map((id) => `${p.dim.name} ${plans.find((x) => x.dim.dimId === p.dim.dimId)!.current.get(id)!.name}`));
      throw new HttpError(422, `${names.slice(0, 20).join(', ')} ${names.length === 1 ? 'holds' : 'hold'} data but had children at the restore point; restore the data too, or clear ${names.length === 1 ? 'it' : 'them'} first`, { members: names });
    }
    for (const p of plans) for (const id of p.kept) keep.add(id);
  }

  // ---- Data on members that become parents again: cleared first (their value then was empty).
  let parentsCleared = 0;
  if (parentsWithData.length) {
    for (const p of parentsWithData) {
      const cells = (await c.query<{ k: number[] }>(
        `select array[cube_id, scenario_id, version_id, years_id, period_id, entity_id, account_id, department_id,
                      c1, c2, c3, c4, c5, c6, c7, c8] as k
           from epm.fact where app_id = $1 and ${p.dim.column} = any($2::int[])`,
        [appId, p.ids],
      )).rows;
      parentsCleared += cells.length;
      if (parentsCleared > MAX_IN_PLACE_CELLS) throw new HttpError(422, `restoring the data would change more than ${MAX_IN_PLACE_CELLS} cells`);
      // Also in a preview (rolled back): the deploy below refuses parents that hold data.
      if (cells.length) {
        await c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({
          app_id: appId, source: 'restore', source_ref: `metadata-restore:${src.snapshot?.snapshot_id ?? src.at}`,
          comment: `cleared members that become parents again (restore to ${src.label})`,
          cells: cells.map((x) => ({ k: x.k, v: null })),
        })]);
      }
    }
  }

  // ---- Member edits, then one deploy.
  if (plans.length) {
    let edits = 0;
    for (const p of plans) {
      const { current, final } = p;
      // 1. Loosen: members that move or are renamed let go of their parent and name first.
      const moving = [...final.values()].filter((f) => current.has(f.member_id) && (current.get(f.member_id)!.parent_id !== f.parent_id || current.get(f.member_id)!.name !== f.name)).map((f) => f.member_id);
      if (moving.length) {
        await c.query(`update epm.member set parent_id = null, name = '\u0001nx' || member_id where member_id = any($1::int[])`, [moving]);
      }
      // 2. Members added since and not in use go (children before parents does not matter in one statement).
      if (p.remove.length) {
        await c.query('update epm.member set parent_id = null where member_id = any($1::int[])', [p.remove]);
        await c.query('delete from epm.member where member_id = any($1::int[])', [p.remove]);
      }
      // 3. Members deleted since come back under their own ids.
      if (p.recreate.length) {
        await c.query(
          `insert into epm.member (member_id, tenant_id, dim_id, name, alias, sort_order, agg_op, account_type, time_balance, formula)
           overriding system value
           select (r->>'member_id')::int, $1, $2, r->>'name', r->>'alias', (r->>'sort_order')::int, r->>'agg_op',
                  r->>'account_type', r->>'time_balance', r->>'formula'
             from jsonb_array_elements($3::jsonb) r`,
          [s.tenantId, p.dim.dimId, JSON.stringify(p.recreate.map((id) => final.get(id)))],
        );
      }
      // 4. Everything as it will be: names, parents, properties.
      await c.query(
        `update epm.member m set name = r.name, parent_id = r.parent_id, alias = r.alias, sort_order = r.sort_order, agg_op = r.agg_op,
                account_type = r.account_type, time_balance = r.time_balance, formula = r.formula
           from jsonb_to_recordset($1::jsonb) as r(member_id int, name text, parent_id int, alias text, sort_order int, agg_op char(1),
                                                   account_type text, time_balance text, formula text)
          where m.member_id = r.member_id
            and (m.name, m.parent_id, m.alias, m.sort_order, m.agg_op, m.account_type, m.time_balance, m.formula)
                is distinct from (r.name, r.parent_id, r.alias, r.sort_order, r.agg_op, r.account_type, r.time_balance, r.formula)`,
        [JSON.stringify([...final.values()])],
      );
      edits += p.remove.length + p.recreate.length + p.report.changed.length;
    }
    // Deploy when anything differs from what is deployed (also undoes saved-but-undeployed edits).
    const pendingNow = await pendingByDim(c, appId);
    if ([...pendingNow.values()].some((n) => n > 0)) {
      const d = await one<{ r: { metadata_rev: number } }>(c, 'select epm.deploy_metadata($1) as r', [appId]);
      result.members!.deployed = true;
      result.members!.metadata_rev = d.r.metadata_rev;
      edits = Math.max(edits, 1);
    }
    result.changes += edits;

    // Access grants on members that came back: from a snapshot, which keeps them.
    const recreatedIds = new Set(plans.flatMap((p) => p.recreate));
    if (recreatedIds.size && src.grants) {
      const users = new Map((await c.query<{ user_id: string; email: string }>('select user_id, lower(email) as email from epm.app_user')).rows.map((r) => [r.email, r.user_id]));
      const groups = new Map((await c.query<{ group_id: string; name: string }>('select group_id, lower(name) as name from epm.principal_group')).rows.map((r) => [r.name, r.group_id]));
      const principals = new Set<string>();
      for (const g of src.grants.filter((x) => recreatedIds.has(x.member_id))) {
        const principal = g.principal_type === 'user' ? users.get(g.principal.toLowerCase()) : groups.get(g.principal.toLowerCase());
        if (!principal) continue;
        const ins = await c.query(
          `insert into epm.access_grant (tenant_id, app_id, principal_type, principal, member_id, scope, access)
           values ($1, $2, $3, $4, $5, $6, $7) on conflict do nothing`,
          [s.tenantId, appId, g.principal_type, principal, g.member_id, g.scope, g.access],
        );
        if (ins.rowCount) { result.members!.grants_restored += ins.rowCount; principals.add(g.principal); }
      }
      if (result.members!.grants_restored) {
        await c.query('select epm.rebuild_effective_access($1)', [appId]);
        if (!preview) {
          await c.query(
            `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'grants_changed', $4)`,
            [s.tenantId, appId, s.userId, { count: result.members!.grants_restored, principals: [...principals], from_snapshot: src.snapshot?.snapshot_id ?? null, reason: 'metadata restore' }],
          );
        }
      }
    } else if (recreatedIds.size) {
      result.members!.notes.push('access grants on members that came back are not kept in point-in-time history; grant them again, or restore from a snapshot');
    }
    for (const d of result.members!.dimensions) {
      d.recreated = cap(d.recreated); d.changed = cap(d.changed); d.removed = cap(d.removed); d.kept = cap(d.kept); d.conflicts = cap(d.conflicts);
    }
  }

  // ---- Form and report definitions.
  if (body.definitions) {
    const out: NonNullable<MetadataRestoreResult['definitions']> = { created: [], updated: [], unchanged: 0, removed: [], kept_new: [], invalid: [], notes: [] };
    for (const kind of ['form', 'report'] as Kind[]) {
      const list = kind === 'form' ? src.forms : src.reports;
      if (list === null) { out.notes.push(`the source has no ${kind}s (it is older than ${kind}s in snapshots); ${kind}s were left as they are`); continue; }
      const current = new Map((await loadDefinitions(c, appId, [kind])).map((d) => [d.name.toLowerCase(), d]));
      const wantedNames = new Set(list.map((d) => d.name.toLowerCase()));
      for (const t of list) {
        const cube = await loadCubeById(c, appId, t.cube_id);
        if (!cube) { out.invalid.push({ type: kind, name: t.name, message: 'its cube no longer exists; not restored' }); continue; }
        const cur = current.get(t.name.toLowerCase());
        const def = (kind === 'form' ? FormDefinition : ReportDefinition).safeParse(t.definition);
        if (!def.success) { out.invalid.push({ type: kind, name: t.name, message: 'the saved definition is not valid; not restored' }); continue; }
        const same = cur && cur.cube === cube.name && (cur.folder ?? null) === (t.folder ?? null) && (cur.description ?? null) === (t.description ?? null)
          && JSON.stringify(normalize(cur.definition)) === JSON.stringify(normalize(def.data));
        if (same) { out.unchanged++; continue; }
        await writeDefinition(c, s, appId, kind, { id: t.id, name: cur?.name ?? t.name, cubeId: cube.cubeId, folder: t.folder, description: t.description, definition: def.data });
        (cur ? out.updated : out.created).push({ type: kind, name: cur?.name ?? t.name });
        try {
          await validatePlacement(c, cube, def.data as never, `${kind} ${t.name}`);
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          out.invalid.push({ type: kind, name: t.name, message: `restored, but it does not open with today's metadata: ${e.message}` });
        }
      }
      for (const [lname, cur] of current) {
        if (wantedNames.has(lname)) continue;
        if (body.remove_new_definitions) {
          await c.query(`delete from epm.${kind} where ${kind}_id = $1`, [cur.id]);
          out.removed.push({ type: kind, name: cur.name });
        } else {
          out.kept_new.push({ type: kind, name: cur.name });
        }
      }
    }
    result.changes += out.created.length + out.updated.length + out.removed.length;
    out.created = cap(out.created); out.updated = cap(out.updated); out.removed = cap(out.removed); out.kept_new = cap(out.kept_new); out.invalid = cap(out.invalid);
    result.definitions = out;
  }

  // ---- Data to the same moment.
  if (body.data) {
    const data = { cells_set: 0, cells_cleared: 0, parents_cleared: parentsCleared, kept: 0, skipped: 0, txn_ids: [] as number[], max_cells: MAX_IN_PLACE_CELLS, over_limit: false };
    if (src.type === 'point_in_time') {
      const seq = (await one<{ seq: number }>(c, 'select coalesce(max(chain_seq), 0)::bigint as seq from epm.change_txn where app_id = $1 and created_at <= $2', [appId, src.at])).seq;
      const slices = (await c.query<{ cube_id: number; scenario_id: number; version_id: number }>(
        `select distinct a.coords[1] as cube_id, a.coords[2] as scenario_id, a.coords[3] as version_id
           from epm.cell_audit a join epm.change_txn t on t.txn_id = a.txn_id
          where a.app_id = $1 and t.app_id = $1 and t.chain_seq > $2
            and exists (select 1 from epm.cube cu where cu.cube_id = a.coords[1] and cu.app_id = $1)
          order by 1, 2, 3`,
        [appId, seq],
      )).rows;
      for (const sl of slices) {
        const left = MAX_IN_PLACE_CELLS - data.cells_set - data.cells_cleared - parentsCleared;
        const r = await one<{ r: { cells_set: number; cells_cleared: number; skipped: number; kept: number; txn_id: number | null } }>(
          c, 'select epm.restore_slice($1::jsonb) as r',
          [JSON.stringify({
            app_id: appId, ...sl, as_of_seq: seq, filters: [], dry_run: preview, max_cells: Math.max(left, 0),
            keep_members: [...keep], comment: body.comment ?? `restore to ${src.label} (with metadata)`,
          })],
        );
        data.cells_set += r.r.cells_set;
        data.cells_cleared += r.r.cells_cleared;
        data.skipped += r.r.skipped;
        data.kept += r.r.kept;
        if (r.r.txn_id) data.txn_ids.push(r.r.txn_id);
      }
    } else {
      const { scenarios, versions } = snapshotScope(src.opened!.meta, src.snapshot!);
      const plan = await planSnapshotData(c, appId, src.opened!, { scenarios, versions, keep });
      data.cells_set = plan.summary.cells_set;
      data.cells_cleared = plan.summary.cells_cleared;
      data.skipped = plan.summary.skipped;
      data.kept = plan.summary.kept;
      if (!preview && plan.changes.length) {
        if (plan.changes.length > MAX_IN_PLACE_CELLS) throw new HttpError(422, `restoring the data would change ${plan.changes.length} cells; the limit is ${MAX_IN_PLACE_CELLS}`);
        const r = await one<{ r: { txn_id: number | null } }>(c, 'select epm.apply_changes($1::jsonb) as r', [JSON.stringify({
          app_id: appId, source: 'restore', source_ref: `snapshot:${src.snapshot!.snapshot_id}`,
          comment: body.comment ?? `restored from ${src.label} (with metadata)`, cells: plan.changes,
        })]);
        if (r.r.txn_id) data.txn_ids.push(r.r.txn_id);
        if ((await planSnapshotData(c, appId, src.opened!, { scenarios, versions, keep })).changes.length) {
          throw new HttpError(409, 'the data changed while it was being restored; run the restore again', undefined, 'NXRTY');
        }
      }
    }
    data.over_limit = data.cells_set + data.cells_cleared + data.parents_cleared > MAX_IN_PLACE_CELLS;
    if (data.over_limit && !preview) throw new HttpError(422, `restoring the data would change more than ${MAX_IN_PLACE_CELLS} cells`);
    result.changes += data.cells_set + data.cells_cleared + data.parents_cleared;
    result.data = data;
  }

  if (!preview && result.changes > 0) {
    await c.query(
      `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'metadata_restored', $4)`,
      [s.tenantId, appId, s.userId, {
        source: result.source,
        members: result.members?.dimensions.map((d) => ({ dimension: d.dimension, recreated: d.recreated.length, changed: d.changed.length, removed: d.removed.length, kept: d.kept.length })) ?? null,
        metadata_rev: result.members?.metadata_rev ?? null,
        grants_restored: result.members?.grants_restored ?? 0,
        definitions: result.definitions ? { created: result.definitions.created.length, updated: result.definitions.updated.length, removed: result.definitions.removed.length } : null,
        data: result.data ? { cells_set: result.data.cells_set, cells_cleared: result.data.cells_cleared, txn_ids: result.data.txn_ids } : null,
      }],
    );
  }
  return result;
}

/** Definitions compare by content: the single-dimension axis shape and the list shape are the same thing. */
function normalize(def: unknown): unknown {
  const canon = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v;
  const d = { ...(def as Record<string, unknown>) };
  for (const axis of ['rows', 'columns']) if (d[axis] && !Array.isArray(d[axis])) d[axis] = [d[axis]];
  return canon(d);
}

export async function restoreMetadata(deps: SnapshotDeps, s: SessionContext, appId: string, body: MetadataRestoreBody): Promise<MetadataRestoreResult> {
  // The source: point-in-time history, or a snapshot of this application (every file checked first).
  const snap = await withSession(deps.db, s, async (c) => {
    await requireApp(c, appId, 'app_admin');
    return body.snapshot_id ? loadSnapshot(c, appId, body.snapshot_id) : null;
  });
  const opened = snap ? await openSnapshot(deps.blobs, snap) : null;
  const source = (c: Client) => (snap ? Promise.resolve(snapshotSource(snap, opened!)) : pointInTimeSource(c, appId, body.at!, body.members, body.definitions));

  // Preview: the whole restore, rolled back.
  const preview = await withSession(deps.db, s, async (c) => {
    await requireApp(c, appId, 'app_admin');
    await c.query('savepoint nx_metadata_preview');
    try {
      return await run(c, s, appId, await source(c), body, true);
    } finally {
      await c.query('rollback to savepoint nx_metadata_preview');
    }
  });
  if (body.dry_run || preview.changes === 0) return { ...preview, dry_run: body.dry_run };
  if (preview.data?.over_limit) throw new HttpError(422, `restoring the data would change more than ${MAX_IN_PLACE_CELLS} cells; restore metadata alone, then the data a slice at a time`);

  const pre = await createSnapshot(deps, s, appId, {
    kind: 'pre_restore',
    comment: `before restoring metadata to ${snap ? `the snapshot of ${snap.manifest!.taken_at}` : body.at}`,
  });
  const done = await retrying(() => withSession(deps.db, s, async (c) => {
    await requireApp(c, appId, 'app_admin');
    return run(c, s, appId, await source(c), body, false);
  }));
  return { ...done, pre_restore_snapshot_id: pre.snapshot_id };
}

