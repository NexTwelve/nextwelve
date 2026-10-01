-- 0009_metadata_history: history for restoring metadata, form and report definitions to a point
-- in time, and saved reports.
--
--   * metadata_rev: when each metadata revision was deployed (clock time under the application lock,
--     so in commit order).
--   * member_version: every member as deployed, valid for revisions [from_rev, to_rev). Written by
--     deploy_metadata and add_version_leaf through record_metadata_rev.
--   * report: saved read-only reports (definitions like forms, several dimensions per axis).
--   * artifact_version: every saved state of a form or report, written by triggers, so no code path
--     can change a definition without leaving history.
--   * application.history_from: the moment history is complete from (creation for new applications,
--     this migration for existing ones).
--   * restore_slice: optional keep_members, cells on those members are left as they are.

alter table epm.application add column history_from timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- Metadata revisions and member versions
-- ---------------------------------------------------------------------------
create table epm.metadata_rev (
  tenant_id    uuid not null,
  app_id       uuid not null references epm.application on delete cascade,
  metadata_rev int  not null,
  deployed_at  timestamptz not null default clock_timestamp(),
  user_id      uuid,
  primary key (app_id, metadata_rev)
);
create index metadata_rev_time on epm.metadata_rev (app_id, deployed_at);

create table epm.member_version (
  tenant_id    uuid not null,
  app_id       uuid not null references epm.application on delete cascade,
  dim_id       int  not null,
  member_id    int  not null,
  name         text not null,
  alias        text,
  parent_id    int,
  sort_order   int  not null,
  agg_op       char(1) not null,
  account_type text,
  time_balance text,
  formula      text,
  from_rev     int  not null,
  to_rev       int,                     -- null = still deployed this way
  primary key (member_id, from_rev)
);
create index member_version_app on epm.member_version (app_id, from_rev);
create index member_version_open on epm.member_version (app_id) where to_rev is null;

-- Called inside a deploy, after metadata_rev was bumped. p_only: just that member was deployed
-- (add_version_leaf); null: everything saved was deployed.
create function epm.record_metadata_rev(p_app uuid, p_rev int, p_user uuid, p_only int default null) returns void
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_tenant uuid;
begin
  select tenant_id into v_tenant from epm.application where app_id = p_app;
  if p_only is null then
    update epm.member_version v set to_rev = p_rev
     where v.app_id = p_app and v.to_rev is null
       and not exists (
         select 1 from epm.member m
          where m.member_id = v.member_id and m.dim_id = v.dim_id and m.name = v.name
            and m.alias is not distinct from v.alias and m.parent_id is not distinct from v.parent_id
            and m.sort_order = v.sort_order and m.agg_op = v.agg_op
            and m.account_type is not distinct from v.account_type
            and m.time_balance is not distinct from v.time_balance
            and m.formula is not distinct from v.formula);
  end if;
  insert into epm.member_version (tenant_id, app_id, dim_id, member_id, name, alias, parent_id, sort_order, agg_op,
                                  account_type, time_balance, formula, from_rev)
  select v_tenant, p_app, m.dim_id, m.member_id, m.name, m.alias, m.parent_id, m.sort_order, m.agg_op,
         m.account_type, m.time_balance, m.formula, p_rev
    from epm.member m join epm.dimension d on d.dim_id = m.dim_id
   where d.app_id = p_app
     and (p_only is null or m.member_id = p_only)
     and not exists (select 1 from epm.member_version v where v.member_id = m.member_id and v.to_rev is null);
  insert into epm.metadata_rev (tenant_id, app_id, metadata_rev, user_id) values (v_tenant, p_app, p_rev, p_user);
end $$;
revoke execute on function epm.record_metadata_rev(uuid, int, uuid, int) from public;

-- ---------------------------------------------------------------------------
-- Reports and definition history
-- ---------------------------------------------------------------------------
create table epm.report (
  report_id   uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  app_id      uuid not null references epm.application on delete cascade,
  cube_id     int  not null references epm.cube on delete cascade,
  name        text not null,
  folder      text,
  description text,
  definition  jsonb not null,   -- { pov, page, rows: [...], columns: [...], suppress_missing_rows, ... }
  version     int  not null default 1,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
create unique index report_name_ci on epm.report (app_id, lower(name));
select epm.secure_tenant_table('epm.report');
grant select, insert, update, delete on epm.report to epm_app;

create table epm.artifact_version (
  tenant_id   uuid not null,
  app_id      uuid not null references epm.application on delete cascade,
  kind        text not null check (kind in ('form','report')),
  artifact_id uuid not null,
  version     int  not null,
  name        text not null,
  cube_id     int,
  folder      text,
  description text,
  definition  jsonb,
  deleted     boolean not null default false,
  changed_by  uuid,
  changed_at  timestamptz not null default clock_timestamp(),
  primary key (artifact_id, version)
);
create index artifact_version_name on epm.artifact_version (app_id, kind, lower(name), changed_at);

-- A definition's version goes up only when something in it changed.
create function epm.bump_artifact_version() returns trigger
  language plpgsql
  as $$
begin
  if (new.cube_id, new.name, new.folder, new.description, new.definition)
     is not distinct from (old.cube_id, old.name, old.folder, old.description, old.definition) then
    new.version := old.version;
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  else
    new.version := old.version + 1;
  end if;
  return new;
end $$;

-- History rows are written as the schema owner: the API role can read history but not write it.
create function epm.log_artifact_version() returns trigger
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_kind text := case tg_table_name when 'form' then 'form' else 'report' end;
  v_row  jsonb;
  v_id   uuid;
begin
  if tg_op = 'DELETE' then
    -- Rows removed with their application leave no history (the history goes too).
    if not exists (select 1 from epm.application where app_id = old.app_id) then
      return old;
    end if;
    v_row := to_jsonb(old);
    v_id := (v_row->>(v_kind || '_id'))::uuid;
    insert into epm.artifact_version (tenant_id, app_id, kind, artifact_id, version, name, cube_id, folder, description,
                                      definition, deleted, changed_by)
    values (old.tenant_id, old.app_id, v_kind, v_id,
            coalesce((select max(version) from epm.artifact_version where artifact_id = v_id), old.version) + 1,
            old.name, old.cube_id, old.folder, old.description, old.definition, true, epm.current_app_user());
    return old;
  end if;
  if tg_op = 'UPDATE' and new.version = old.version then
    return new;
  end if;
  v_row := to_jsonb(new);
  v_id := (v_row->>(v_kind || '_id'))::uuid;
  -- A version number already in history (a definition deleted and its id reused cannot happen; this
  -- guards a row inserted with an explicit version) moves past it.
  insert into epm.artifact_version (tenant_id, app_id, kind, artifact_id, version, name, cube_id, folder, description,
                                    definition, changed_by)
  values (new.tenant_id, new.app_id, v_kind, v_id,
          greatest(new.version, coalesce((select max(version) + 1 from epm.artifact_version where artifact_id = v_id), 1)),
          new.name, new.cube_id, new.folder, new.description, new.definition,
          coalesce(new.updated_by, epm.current_app_user()));
  return new;
end $$;

create trigger form_version before update on epm.form for each row execute function epm.bump_artifact_version();
create trigger report_version before update on epm.report for each row execute function epm.bump_artifact_version();
create trigger form_history after insert or update or delete on epm.form for each row execute function epm.log_artifact_version();
create trigger report_history after insert or update or delete on epm.report for each row execute function epm.log_artifact_version();

-- ---------------------------------------------------------------------------
-- Baseline for applications that already exist: their deployed members and current definitions,
-- as of this migration. One tenant at a time (row-level security is forced).
-- ---------------------------------------------------------------------------
do $$
declare
  t record;
begin
  for t in select tenant_id from epm.tenant loop
    perform set_config('app.tenant_id', t.tenant_id::text, true);
    insert into epm.member_version (tenant_id, app_id, dim_id, member_id, name, alias, parent_id, sort_order, agg_op,
                                    account_type, time_balance, formula, from_rev)
    select m.tenant_id, d.app_id, m.dim_id, m.member_id, m.name, m.alias, dp.ancestor_id, m.sort_order,
           coalesce(case dp.sign when 1 then '+' when -1 then '-' when 0 then '~' end, m.agg_op),
           m.account_type, m.time_balance, m.formula, a.metadata_rev
      from epm.member m
      join epm.dimension d on d.dim_id = m.dim_id
      join epm.application a on a.app_id = d.app_id
      left join epm.member_ancestor dp on dp.descendant_id = m.member_id and dp.depth = 1
     where m.tree_ordinal is not null and a.metadata_rev > 0;
    insert into epm.metadata_rev (tenant_id, app_id, metadata_rev, user_id)
    select a.tenant_id, a.app_id, a.metadata_rev, null from epm.application a where a.metadata_rev > 0;
    insert into epm.artifact_version (tenant_id, app_id, kind, artifact_id, version, name, cube_id, folder, description,
                                      definition, changed_by, changed_at)
    select f.tenant_id, f.app_id, 'form', f.form_id, f.version, f.name, f.cube_id, f.folder, f.description, f.definition,
           f.updated_by, now()
      from epm.form f;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

select epm.secure_tenant_table('epm.metadata_rev');
select epm.secure_tenant_table('epm.member_version');
select epm.secure_tenant_table('epm.artifact_version');
grant select on epm.metadata_rev, epm.member_version, epm.artifact_version to epm_app;

-- ---------------------------------------------------------------------------
-- Deploys record what they published.
-- ---------------------------------------------------------------------------
create or replace function epm.deploy_metadata(p_app uuid) returns jsonb
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_tenant uuid := epm.current_tenant();
  v_user   uuid;
  v_rev    int;
  v_rows   int;
  v_bad    jsonb;
  d        record;
begin
  v_user := epm.require_active_user();
  perform epm.require_role(p_app, 'app_admin');

  perform 1 from epm.application where app_id = p_app for update;
  if not found then
    raise exception 'application not found' using errcode = 'NX404';
  end if;

  -- Parents must sit in the same dimension.
  select jsonb_agg(m.name) into v_bad
    from epm.member m
    join epm.member p on p.member_id = m.parent_id
    join epm.dimension dm on dm.dim_id = m.dim_id
   where dm.app_id = p_app and p.dim_id <> m.dim_id;
  if v_bad is not null then
    raise exception 'members have a parent in another dimension' using errcode = 'NX422', detail = v_bad::text;
  end if;

  -- No cycles.
  with recursive walk(member_id, cur, path, cyc) as (
    select m.member_id, m.parent_id, array[m.member_id], false
      from epm.member m join epm.dimension dm on dm.dim_id = m.dim_id
     where dm.app_id = p_app and m.parent_id is not null
    union all
    select w.member_id, p.parent_id, w.path || p.member_id, p.member_id = any(w.path)
      from walk w join epm.member p on p.member_id = w.cur
     where not w.cyc
  )
  select jsonb_agg(distinct m.name) into v_bad
    from walk w join epm.member m on m.member_id = w.member_id
   where w.cyc;
  if v_bad is not null then
    raise exception 'hierarchy contains a cycle' using errcode = 'NX422', detail = v_bad::text;
  end if;

  -- A member that holds data cannot become a parent (facts are leaf-only).
  for d in select dim_id, dim_type, slot from epm.dimension where app_id = p_app loop
    execute format(
      'select jsonb_agg(distinct m.name) from epm.member m
        where m.dim_id = $1
          and exists (select 1 from epm.member c where c.parent_id = m.member_id)
          and exists (select 1 from epm.fact f where f.app_id = $2 and f.%I = m.member_id)',
      case d.dim_type when 'custom' then 'c' || d.slot else d.dim_type || '_id' end)
      into v_bad using d.dim_id, p_app;
    if v_bad is not null then
      raise exception 'members with data cannot become parents' using errcode = 'NX422', detail = v_bad::text;
    end if;
  end loop;

  update epm.member m
     set is_leaf = not exists (select 1 from epm.member c where c.parent_id = m.member_id)
    from epm.dimension dm
   where dm.dim_id = m.dim_id and dm.app_id = p_app;

  delete from epm.member_ancestor ma
   using epm.dimension dm
   where dm.dim_id = ma.dim_id and dm.app_id = p_app;

  insert into epm.member_ancestor (tenant_id, dim_id, ancestor_id, descendant_id, depth, sign, descendant_is_leaf)
  with recursive cl(dim_id, ancestor_id, descendant_id, depth, sign) as (
    select m.dim_id, m.member_id, m.member_id, 0, 1
      from epm.member m join epm.dimension dm on dm.dim_id = m.dim_id
     where dm.app_id = p_app
    union all
    select cl.dim_id, cl.ancestor_id, c.member_id, cl.depth + 1,
           cl.sign * case c.agg_op when '+' then 1 when '-' then -1 else 0 end
      from cl join epm.member c on c.parent_id = cl.descendant_id
  )
  select v_tenant, cl.dim_id, cl.ancestor_id, cl.descendant_id, cl.depth::smallint, cl.sign::smallint, m.is_leaf
    from cl join epm.member m on m.member_id = cl.descendant_id;
  get diagnostics v_rows = row_count;

  -- Pre-order position in each dimension (sort_order, then creation order), and leaf position.
  with recursive t(member_id, dim_id, path) as (
    select m.member_id, m.dim_id, array[m.sort_order, m.member_id]
      from epm.member m join epm.dimension dm on dm.dim_id = m.dim_id
     where dm.app_id = p_app and m.parent_id is null
    union all
    select c.member_id, c.dim_id, t.path || array[c.sort_order, c.member_id]
      from t join epm.member c on c.parent_id = t.member_id
  ),
  ord as (
    select t.member_id, row_number() over (partition by t.dim_id order by t.path) as tree_ord
      from t
  ),
  leaf as (
    select o.member_id, row_number() over (partition by m.dim_id order by o.tree_ord) as leaf_ord
      from ord o join epm.member m on m.member_id = o.member_id
     where m.is_leaf
  )
  update epm.member m
     set tree_ordinal = o.tree_ord, leaf_ordinal = l.leaf_ord
    from ord o left join leaf l on l.member_id = o.member_id
   where m.member_id = o.member_id;

  update epm.application set metadata_rev = metadata_rev + 1
   where app_id = p_app returning metadata_rev into v_rev;

  insert into epm.metadata_change (tenant_id, app_id, metadata_rev, user_id, summary)
  select v_tenant, p_app, v_rev, v_user,
         jsonb_build_object(
           'closure_rows', v_rows,
           'members', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'dimension', dm.name, 'name', m.name, 'parent', p.name, 'alias', m.alias,
                      'agg_op', m.agg_op, 'sort_order', m.sort_order, 'account_type', m.account_type,
                      'time_balance', m.time_balance, 'formula', m.formula)
                    order by dm.name, m.tree_ordinal)
               from epm.member m
               join epm.dimension dm on dm.dim_id = m.dim_id
               left join epm.member p on p.member_id = m.parent_id
              where dm.app_id = p_app), '[]'::jsonb));

  perform epm.record_metadata_rev(p_app, v_rev, v_user);

  insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail)
  values (v_tenant, p_app, v_user, 'metadata_deploy', jsonb_build_object('metadata_rev', v_rev));

  perform epm.rebuild_effective_access(p_app);

  return jsonb_build_object('metadata_rev', v_rev, 'closure_rows', v_rows);
end $$;

create or replace function epm.add_version_leaf(p_dim int, p_name text) returns int
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  d      epm.dimension;
  v_user uuid;
  v_id   int;
  v_rev  int;
begin
  v_user := epm.require_active_user();
  select * into d from epm.dimension where dim_id = p_dim;
  if not found then
    raise exception 'dimension not found' using errcode = 'NX404';
  end if;
  perform epm.require_role(d.app_id, 'app_admin');
  if d.dim_type <> 'version' then
    raise exception 'only versions can be added this way' using errcode = 'NX422';
  end if;
  if exists (select 1 from epm.member where dim_id = p_dim and lower(name) = lower(p_name)) then
    raise exception '% already has a member named %', d.name, p_name using errcode = 'NX409';
  end if;
  perform 1 from epm.application where app_id = d.app_id for update;

  insert into epm.member (tenant_id, dim_id, name, sort_order, is_leaf, tree_ordinal, leaf_ordinal)
  select d.tenant_id, p_dim, p_name,
         coalesce(max(m.sort_order), 0) + 10, true,
         coalesce(max(m.tree_ordinal), 0) + 1, coalesce(max(m.leaf_ordinal), 0) + 1
    from epm.member m where m.dim_id = p_dim
  returning member_id into v_id;
  insert into epm.member_ancestor (tenant_id, dim_id, ancestor_id, descendant_id, depth, sign, descendant_is_leaf)
  values (d.tenant_id, p_dim, v_id, v_id, 0, 1, true);

  update epm.application set metadata_rev = metadata_rev + 1 where app_id = d.app_id returning metadata_rev into v_rev;
  insert into epm.metadata_change (tenant_id, app_id, metadata_rev, user_id, summary)
  values (d.tenant_id, d.app_id, v_rev, v_user, jsonb_build_object('added_leaf', jsonb_build_object('dimension', d.name, 'name', p_name)));
  perform epm.record_metadata_rev(d.app_id, v_rev, v_user, v_id);
  insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail)
  values (d.tenant_id, d.app_id, v_user, 'version_added', jsonb_build_object('name', p_name, 'metadata_rev', v_rev));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- The digest the nightly job compares now covers reports too.
-- ---------------------------------------------------------------------------
create or replace function epm.app_fingerprint(p_app uuid) returns text
  language sql stable
  as $$
  select md5(coalesce(string_agg(t, E'\n' order by t), '')) from (
    select 'a|' || a.name || '|' || a.metadata_rev from epm.application a where a.app_id = p_app
    union all select 'd|' || d::text from epm.dimension d where d.app_id = p_app
    union all select 'm|' || m::text from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = p_app
    union all select 'c|' || c::text from epm.cube c where c.app_id = p_app
    union all select 'cd|' || cd::text from epm.cube_dimension cd join epm.cube c on c.cube_id = cd.cube_id where c.app_id = p_app
    union all select 'pw|' || x::text from epm.plan_window x where x.app_id = p_app
    union all select 'g|' || x.principal_type || x.principal || '|' || x.member_id || x.scope || x.access
      from epm.access_grant x where x.app_id = p_app
    union all select 'r|' || x.user_id || x.role from epm.user_role x where x.app_id = p_app
    union all select 'f|' || x::text from epm.form x where x.app_id = p_app
    union all select 'rp|' || x::text from epm.report x where x.app_id = p_app
    union all select 'i|' || x::text from epm.import_format x where x.app_id = p_app
    union all select 'mr|' || x::text from epm.mapping_rule x where x.app_id = p_app
    union all select 'ds|' || x::text from epm.dataset x where x.app_id = p_app
    union all select 'dv|' || v.dataset_id || ':' || v.version from epm.dataset_version v
      join epm.dataset d on d.dataset_id = v.dataset_id where d.app_id = p_app
  ) s(t) $$;

-- ---------------------------------------------------------------------------
-- restore_slice: as in 0008, plus keep_members.
-- ---------------------------------------------------------------------------
create or replace function epm.restore_slice(p jsonb) returns jsonb
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_user    uuid;
  v_app     uuid    := (p->>'app_id')::uuid;
  v_cube    int     := (p->>'cube_id')::int;
  v_scen    int     := (p->>'scenario_id')::int;
  v_ver     int     := (p->>'version_id')::int;
  v_target  int     := coalesce((p->>'target_version_id')::int, (p->>'version_id')::int);
  v_seq     bigint  := (p->>'as_of_seq')::bigint;
  v_dry     boolean := coalesce((p->>'dry_run')::boolean, false);
  v_max     int     := coalesce((p->>'max_cells')::int, 100000);
  v_cols    text[]  := array['cube_id','scenario_id','version_id','years_id','period_id','entity_id','account_id',
                             'department_id','c1','c2','c3','c4','c5','c6','c7','c8'];
  v_fa      text    := '';
  v_ff      text    := '';
  f         jsonb;
  v_i       int;
  v_ids     int[];
  v_pass    int;
  v_skipped int;
  v_sample  jsonb;
  v_set     int;
  v_clear   int;
  v_cells   jsonb;
  v_result  jsonb;
  v_head    bigint;
  v_keep    int[];
  v_kept    int := 0;
  v_n       int;
begin
  v_user := epm.require_active_user();
  perform epm.require_role(v_app, 'app_admin');

  if v_seq is null or v_seq < 0 or v_cube is null or v_scen is null or v_ver is null then
    raise exception 'cube_id, scenario_id, version_id and as_of_seq are required' using errcode = 'NX422';
  end if;
  perform 1 from epm.cube where cube_id = v_cube and app_id = v_app;
  if not found then
    raise exception 'cube not found' using errcode = 'NX404';
  end if;
  select coalesce(max(chain_seq), 0) into v_head from epm.change_txn where app_id = v_app;
  if v_seq > v_head then
    raise exception 'that point is in the future' using errcode = 'NX422';
  end if;

  for f in select * from jsonb_array_elements(coalesce(p->'filters', '[]'::jsonb)) loop
    v_i := (f->>'i')::int;
    if v_i is null or v_i < 4 or v_i > 16 then
      raise exception 'filters may narrow years, period, entity, account, department or custom dimensions'
        using errcode = 'NX422';
    end if;
    v_ids := array(select x::int from jsonb_array_elements_text(f->'ids') x);
    v_fa := v_fa || format(' and a.coords[%s] = any(%L::int[])', v_i, v_ids);
    v_ff := v_ff || format(' and f.%I = any(%L::int[])', v_cols[v_i], v_ids);
  end loop;

  -- Members whose cells stay as they are (members a metadata restore kept although they are newer).
  v_keep := array(select x::int from jsonb_array_elements_text(coalesce(p->'keep_members', '[]'::jsonb)) x);

  perform pg_advisory_xact_lock(hashtextextended(concat_ws('.', 'nextwelve.restore', v_app, v_scen, v_target), 0));

  for v_pass in 1..2 loop
    if to_regclass('pg_temp.nx_pit') is not null then drop table pg_temp.nx_pit; end if;
    if to_regclass('pg_temp.nx_out') is not null then drop table pg_temp.nx_out; end if;
    create temp table nx_pit (cell_key bytea primary key, k int[] not null, v numeric(24,6)) on commit drop;
    create temp table nx_out (k int[] not null, v numeric(24,6), cur numeric(24,6), cur_exists boolean not null default false,
                              ok boolean not null default true) on commit drop;

    -- Cells changed after S, with their value at S.
    execute format(
      'insert into nx_pit (cell_key, k, v)
       select distinct on (a.cell_key) a.cell_key, a.coords, a.old_value
         from epm.cell_audit a join epm.change_txn t on t.txn_id = a.txn_id
        where a.app_id = $1 and t.app_id = $1 and t.chain_seq > $2
          and a.coords[1] = $3 and a.coords[2] = $4 and a.coords[3] = $5 %s
        order by a.cell_key, t.chain_seq', v_fa)
      using v_app, v_seq, v_cube, v_scen, v_ver;

    if v_target = v_ver then
      insert into nx_out (k, v) select k, v from nx_pit;
    else
      execute format(
        'insert into nx_out (k, v)
         select array[f.cube_id, f.scenario_id, $5, f.years_id, f.period_id, f.entity_id, f.account_id, f.department_id,
                      f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8], f.value
           from epm.fact f
          where f.app_id = $1 and f.cube_id = $2 and f.scenario_id = $3 and f.version_id = $4 %s
            and not exists (select 1 from nx_pit x
                             where x.cell_key = epm.cell_key(array[f.cube_id, f.scenario_id, f.version_id, f.years_id,
                                     f.period_id, f.entity_id, f.account_id, f.department_id,
                                     f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8]))', v_ff)
        using v_app, v_cube, v_scen, v_ver, v_target;
      insert into nx_out (k, v)
      select k[1:2] || v_target || k[4:16], v from nx_pit where v is not null;
      execute format(
        'insert into nx_out (k, v)
         select array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                      f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8], null
           from epm.fact f
          where f.app_id = $1 and f.cube_id = $2 and f.scenario_id = $3 and f.version_id = $4 %s
            and not exists (select 1 from nx_out o
                             where o.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id,
                                               f.entity_id, f.account_id, f.department_id,
                                               f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8])', v_ff)
        using v_app, v_cube, v_scen, v_target;
    end if;

    update nx_out o set cur = f.value, cur_exists = true
      from epm.fact f
     where f.app_id = v_app
       and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
            f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
         = (o.k[1], o.k[2], o.k[3], o.k[4], o.k[5], o.k[6], o.k[7],
            o.k[8], o.k[9], o.k[10], o.k[11], o.k[12], o.k[13], o.k[14], o.k[15], o.k[16]);
    delete from nx_out where v is not distinct from cur;
    if cardinality(v_keep) > 0 then
      delete from nx_out where k[2:16] && v_keep;
      get diagnostics v_n = row_count;
      if v_pass = 1 then v_kept := v_n; end if;
    end if;

    -- Cells whose members are gone (deleted, or no longer deployed leaves) cannot be written back.
    with dims as (
      select dm.dim_id, epm.coord_index(dm.dim_type, dm.slot) as idx
        from epm.cube_dimension cd join epm.dimension dm on dm.dim_id = cd.dim_id
       where cd.cube_id = v_cube
    )
    update nx_out o set ok = false
     where exists (select 1 from dims
                    where not exists (select 1 from epm.member_ancestor ma
                                       where ma.ancestor_id = o.k[dims.idx] and ma.descendant_id = o.k[dims.idx]
                                         and ma.dim_id = dims.dim_id and ma.descendant_is_leaf)
                       or not exists (select 1 from epm.member m where m.member_id = o.k[dims.idx] and m.dim_id = dims.dim_id));

    if v_pass = 2 then
      -- After the write: anything left to do means someone else changed the slice meanwhile.
      if exists (select 1 from nx_out where ok) then
        raise exception 'the slice changed while it was being restored; run the restore again' using errcode = 'NXRTY';
      end if;
      exit;
    end if;

    select jsonb_agg(to_jsonb(s.k)) into v_sample from (select k from nx_out where not ok order by k limit 20) s;
    select count(*) into v_skipped from nx_out where not ok;
    delete from nx_out where not ok;
    select count(*) filter (where v is not null), count(*) filter (where v is null) into v_set, v_clear from nx_out;

    v_result := jsonb_build_object(
      'dry_run', v_dry, 'as_of_seq', v_seq, 'cells_set', v_set, 'cells_cleared', v_clear,
      'skipped', v_skipped, 'kept', v_kept, 'skipped_sample', coalesce(v_sample, '[]'::jsonb), 'max_cells', v_max);
    if v_dry or v_set + v_clear = 0 then
      return v_result || jsonb_build_object('txn_id', null, 'cell_count', 0);
    end if;
    if v_set + v_clear > v_max then
      raise exception 'this restore would change % cells; restore at most % at a time by narrowing the slice',
        v_set + v_clear, v_max using errcode = 'NX422';
    end if;

    select jsonb_agg(jsonb_build_object('k', k, 'v', v)) into v_cells from nx_out;
    v_result := v_result || epm.apply_changes(jsonb_build_object(
      'app_id', v_app, 'source', 'restore',
      'source_ref', 'point-in-time:' || v_seq,
      'comment', coalesce(p->>'comment', 'point-in-time restore to change #' || v_seq),
      'cells', v_cells));
  end loop;

  insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail)
  values (epm.current_tenant(), v_app, v_user, 'point_in_time_restore',
          (v_result - 'skipped_sample') || jsonb_build_object('scenario_id', v_scen, 'version_id', v_ver,
                                                              'target_version_id', v_target, 'filters', p->'filters'));
  return v_result;
end $$;
