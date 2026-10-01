-- 0007_backup: point-in-time restore of a slice, and application snapshots kept in object storage.

-- ---------------------------------------------------------------------------
-- Snapshots: a consistent export of one application (metadata, datasets, facts) to R2.
-- The files live under storage_prefix; the manifest (file names, row counts, SHA-256) is kept
-- here as well, so a file changed in storage is caught on restore.
-- No foreign key to application: a snapshot must outlive the application it came from.
-- ---------------------------------------------------------------------------
create table epm.snapshot (
  snapshot_id    uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  app_id         uuid not null,
  app_name       text not null,
  kind           text not null check (kind in ('nightly','manual','pre_deploy','pre_restore')),
  scope          jsonb not null default '{}'::jsonb,   -- {} = all data; else { scenarios: [...], versions: [...] }
  schema_ver     int  not null,
  storage_prefix text not null,
  status         text not null check (status in ('running','complete','failed','expired')),
  metadata_rev   int,
  high_chain_seq bigint,                              -- newest change transaction included
  fact_count     bigint,
  byte_size      bigint,
  manifest       jsonb,
  error          text,
  comment        text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz,
  expires_at     timestamptz
);
create index snapshot_app on epm.snapshot (app_id, created_at desc);

select epm.secure_tenant_table('epm.snapshot');
-- Snapshots are never deleted through the API; retention marks them expired and removes the files.
grant select, insert, update on epm.snapshot to epm_app;

-- ---------------------------------------------------------------------------
-- Applications due a nightly snapshot, across tenants. Called by the scheduled job with no
-- tenant in the session; it switches tenant for each read so RLS still applies per tenant.
-- Returns ids only.
-- ---------------------------------------------------------------------------
create function epm.snapshot_targets() returns table (tenant_id uuid, app_id uuid)
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  t record;
begin
  if epm.current_tenant() is not null then
    raise exception 'snapshot_targets runs without a tenant in the session' using errcode = 'NX422';
  end if;
  for t in select tn.tenant_id from epm.tenant tn order by tn.tenant_id loop
    perform set_config('app.tenant_id', t.tenant_id::text, true);
    return query select a.tenant_id, a.app_id from epm.application a where a.state = 'online' order by a.app_id;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

-- ---------------------------------------------------------------------------
-- Point-in-time restore of a slice (cube x scenario x version, optionally narrowed by members).
-- The value of a cell at chain position S is the old_value of its first change after S; cells
-- with no change after S already hold their value at S. Payload:
--   { app_id, cube_id, scenario_id, version_id, as_of_seq,
--     target_version_id?   -- default: the same version (restore in place)
--     filters?: [ { i: <1-based coordinate index>, ids: [leaf member ids] } ],
--     dry_run?, comment? }
-- Writes through apply_changes as one 'restore' transaction, so the restore is audited and can
-- be undone. Cells whose members were deleted (or became parents) since are skipped and reported.
-- ---------------------------------------------------------------------------
create function epm.restore_slice(p jsonb) returns jsonb
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
  v_cols    text[]  := array['cube_id','scenario_id','version_id','years_id','period_id','entity_id','account_id',
                             'department_id','c1','c2','c3','c4','c5','c6','c7','c8'];
  v_fa      text    := '';   -- filter on cell_audit coordinates
  v_ff      text    := '';   -- the same filter on fact columns
  f         jsonb;
  v_i       int;
  v_ids     int[];
  v_skipped int;
  v_sample  jsonb;
  v_set     int;
  v_clear   int;
  v_cells   jsonb;
  v_result  jsonb;
  v_head    bigint;
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

  -- Member filters: coordinate index -> allowed leaf ids. Indexes are checked, ids cast to int[].
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

  -- One restore of a slice at a time.
  perform pg_advisory_xact_lock(hashtextextended(concat_ws('.', 'nextwelve.restore', v_app, v_scen, v_target), 0));

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
    -- In place: put back each changed cell.
    insert into nx_out (k, v) select k, v from nx_pit;
  else
    -- Into another version: the whole source slice as it was at S ...
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
    -- ... and clear target cells that slice did not have.
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

  -- Current values, to report what will change.
  update nx_out o set cur = f.value, cur_exists = true
    from epm.fact f
   where f.app_id = v_app
     and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
          f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
       = (o.k[1], o.k[2], o.k[3], o.k[4], o.k[5], o.k[6], o.k[7],
          o.k[8], o.k[9], o.k[10], o.k[11], o.k[12], o.k[13], o.k[14], o.k[15], o.k[16]);
  delete from nx_out where v is not distinct from cur;

  -- Cells whose members no longer exist as deployed leaves cannot be written back.
  with dims as (
    select dm.dim_id, epm.coord_index(dm.dim_type, dm.slot) as idx
      from epm.cube_dimension cd join epm.dimension dm on dm.dim_id = cd.dim_id
     where cd.cube_id = v_cube
  )
  update nx_out o set ok = false
   where exists (select 1 from dims
                  where not exists (select 1 from epm.member_ancestor ma
                                     where ma.ancestor_id = o.k[dims.idx] and ma.descendant_id = o.k[dims.idx]
                                       and ma.dim_id = dims.dim_id and ma.descendant_is_leaf));
  select jsonb_agg(to_jsonb(s.k)) into v_sample from (select k from nx_out where not ok order by k limit 20) s;
  select count(*) into v_skipped from nx_out where not ok;
  delete from nx_out where not ok;

  select count(*) filter (where v is not null), count(*) filter (where v is null)
    into v_set, v_clear from nx_out;

  v_result := jsonb_build_object(
    'dry_run', v_dry, 'as_of_seq', v_seq, 'cells_set', v_set, 'cells_cleared', v_clear,
    'skipped', v_skipped, 'skipped_sample', coalesce(v_sample, '[]'::jsonb));
  if v_dry or v_set + v_clear = 0 then
    return v_result || jsonb_build_object('txn_id', null, 'cell_count', 0);
  end if;

  select jsonb_agg(jsonb_build_object('k', k, 'v', v)) into v_cells from nx_out;
  v_result := v_result || epm.apply_changes(jsonb_build_object(
    'app_id', v_app, 'source', 'restore',
    'source_ref', 'point-in-time:' || v_seq,
    'comment', coalesce(p->>'comment', 'point-in-time restore to change #' || v_seq),
    'cells', v_cells));

  insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail)
  values (epm.current_tenant(), v_app, v_user, 'point_in_time_restore',
          (v_result - 'skipped_sample') || jsonb_build_object('scenario_id', v_scen, 'version_id', v_ver,
                                                              'target_version_id', v_target, 'filters', p->'filters'));
  return v_result;
end $$;

grant execute on function epm.restore_slice(jsonb), epm.snapshot_targets() to epm_app;
