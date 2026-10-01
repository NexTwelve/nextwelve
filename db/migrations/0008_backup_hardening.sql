-- 0008_backup_hardening: fixes from adversarial testing of backup and restore.
--
--   * apply_changes: a 'restoring' application takes writes only from its restore loader;
--     coordinates must name members that still exist; change_txn.created_at is taken under the
--     chain lock, so it follows chain (commit) order and "as of time T" is exact.
--   * restore_slice: skips deleted members, refuses more than 100,000 changed cells, and checks
--     after writing that the slice really is at the chosen point (raising NXRTY, retried by the
--     API, when a concurrent writer got in between).
--   * add_version_leaf: a new version for a restore without deploying anyone's pending edits.
--   * discard_restoring_app / sweep_restoring_apps: remove an application whose restore failed
--     part way, from the loader itself or, for restores that died, from the nightly job.
--   * app_fingerprint + snapshot.content_hash: the nightly job notices changes to datasets,
--     forms, imports, grants, roles and plan windows, not only to data and deploys.
--   * snapshot_targets needs the job key held by the scheduled Worker (not the API role alone).

create or replace function epm.apply_changes(p jsonb) returns jsonb
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_tenant    uuid := epm.current_tenant();
  v_user      uuid;
  v_app       uuid := (p->>'app_id')::uuid;
  v_source    text := coalesce(p->>'source', 'api');
  v_ref       text := p->>'source_ref';
  v_check     boolean := coalesce((p->>'check_rev')::boolean, false);
  v_override  boolean := coalesce((p->>'override')::boolean, false);
  v_rank      int;
  v_admin     boolean;
  v_state     text;
  v_txn       bigint;
  v_now       timestamptz := now();          -- cell_audit.changed_at (the writer's start)
  v_joined    timestamptz;                    -- change_txn.created_at: when it joined the history
  v_bad       jsonb;
  v_count     int;
  v_prev_seq  bigint;
  v_prev_hash bytea;
  v_hash      bytea;
begin
  v_user := epm.require_active_user();

  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'apply_changes requires READ COMMITTED isolation' using errcode = 'NX422';
  end if;

  select a.state into v_state from epm.application a where a.app_id = v_app;
  if not found then
    raise exception 'application not found' using errcode = 'NX404';
  end if;
  -- While an application is being restored only the restore's own loader may write to it: the
  -- loader marks its transactions with app.restoring_app.
  if v_state = 'restoring'
     and not (v_source = 'restore' and coalesce(current_setting('app.restoring_app', true), '') = v_app::text) then
    raise exception 'application is being restored' using errcode = 'NX423';
  end if;
  if v_source not in ('grid_submit','rule','data_load','version_copy','clear','undo','restore','api') then
    raise exception 'unknown source %', v_source using errcode = 'NX422';
  end if;

  v_rank  := epm.role_rank(epm.user_app_role(v_app));
  v_admin := v_rank >= 4;
  if v_rank < 2
     or (v_source in ('rule','data_load') and v_rank < 3)
     or (v_source in ('version_copy','clear','restore') and not v_admin) then
    raise exception 'role cannot write with source %', v_source using errcode = 'NX403';
  end if;

  if jsonb_typeof(p->'cells') is distinct from 'array' then
    raise exception 'cells must be an array' using errcode = 'NX422';
  end if;

  if to_regclass('pg_temp.nx_cells') is not null then
    drop table pg_temp.nx_cells;
  end if;
  create temp table nx_cells (
    k          int[] not null,
    v          numeric(24,6),
    r          bigint,
    has_r      boolean not null,
    cell_key   bytea,
    cur_value  numeric(24,6),
    cur_rev    bigint,
    cur_exists boolean not null default false,
    done       boolean not null default false
  ) on commit drop;

  insert into nx_cells (k, v, r, has_r)
  select array(select e.x::int from jsonb_array_elements_text(c->'k') with ordinality e(x, n) order by e.n),
         (c->>'v')::numeric,
         (c->>'r')::bigint,
         c ? 'r'
    from jsonb_array_elements(p->'cells') c;

  if exists (select 1 from nx_cells where cardinality(k) <> 16 or array_position(k, null) is not null) then
    raise exception 'each cell needs 16 integer coordinates' using errcode = 'NX422';
  end if;
  if exists (select 1 from nx_cells where v = 'NaN'::numeric) then
    raise exception 'cell values must be numbers' using errcode = 'NX422';
  end if;

  update nx_cells set cell_key = epm.cell_key(k);
  if (select count(*) from nx_cells) <> (select count(distinct cell_key) from nx_cells) then
    raise exception 'duplicate cells in one request' using errcode = 'NX422';
  end if;
  analyze nx_cells;

  -- Cubes must belong to the application.
  select jsonb_agg(distinct c.k[1]) into v_bad
    from nx_cells c
   where not exists (select 1 from epm.cube cu where cu.cube_id = c.k[1] and cu.app_id = v_app);
  if v_bad is not null then
    raise exception 'cube not in application' using errcode = 'NX422', detail = v_bad::text;
  end if;

  -- Every coordinate must be a deployed leaf of the cube's dimension that still exists (a deleted
  -- member keeps its closure rows until the next deploy); unused slots must be 0.
  with dims as (
    select cd.cube_id, dm.dim_id, epm.coord_index(dm.dim_type, dm.slot) as idx
      from epm.cube_dimension cd join epm.dimension dm on dm.dim_id = cd.dim_id
     where dm.app_id = v_app
  ),
  bad as (
    select c.k
      from nx_cells c join dims on dims.cube_id = c.k[1]
     where not exists (
             select 1 from epm.member_ancestor ma
              where ma.ancestor_id = c.k[dims.idx] and ma.descendant_id = c.k[dims.idx]
                and ma.dim_id = dims.dim_id and ma.descendant_is_leaf)
        or not exists (select 1 from epm.member m where m.member_id = c.k[dims.idx] and m.dim_id = dims.dim_id)
    union all
    select c.k
      from nx_cells c cross join generate_series(2, 16) i
     where c.k[i] <> 0
       and not exists (select 1 from dims where dims.cube_id = c.k[1] and dims.idx = i)
  )
  select jsonb_agg(to_jsonb(b.k)) into v_bad from (select distinct k from bad limit 50) b;
  if v_bad is not null then
    raise exception 'coordinates must be deployed leaf members of the cube''s dimensions'
      using errcode = 'NX422', detail = v_bad::text;
  end if;

  if not v_admin then
    -- Write access in every secured dimension.
    with sdims as (
      select cd.cube_id, dm.dim_id, epm.coord_index(dm.dim_type, dm.slot) as idx
        from epm.cube_dimension cd join epm.dimension dm on dm.dim_id = cd.dim_id
       where dm.app_id = v_app and dm.secured
    ),
    bad as (
      select distinct c.k
        from nx_cells c join sdims s on s.cube_id = c.k[1]
       where not exists (
               select 1 from epm.effective_access ea
                where ea.app_id = v_app and ea.user_id = v_user and ea.dim_id = s.dim_id
                  and ea.member_id = c.k[s.idx] and ea.access = 'write')
    )
    select jsonb_agg(to_jsonb(b.k)) into v_bad from (select k from bad limit 50) b;
    if v_bad is not null then
      raise exception 'no write access to some cells' using errcode = 'NX403', detail = v_bad::text;
    end if;

    -- Plan windows.
    select jsonb_agg(to_jsonb(b.k)) into v_bad from (
      select c.k
        from nx_cells c
        join epm.plan_window w
          on w.app_id = v_app and w.scenario_id = c.k[2] and w.version_id = c.k[3] and w.years_id = c.k[4]
        left join epm.member pm on pm.member_id = c.k[5]
        left join epm.member ps on ps.member_id = w.start_period_id
        left join epm.member pe on pe.member_id = w.end_period_id
       where w.locked
          or (ps.member_id is not null and pm.leaf_ordinal < ps.leaf_ordinal)
          or (pe.member_id is not null and pm.leaf_ordinal > pe.leaf_ordinal)
       limit 50) b;
    if v_bad is not null then
      raise exception 'plan window is closed for some cells' using errcode = 'NX403', detail = v_bad::text;
    end if;
  end if;

  -- Lock existing rows, then read current values (a fresh snapshot sees committed writers).
  perform 1
     from epm.fact f join nx_cells c
       on f.app_id = v_app
      and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
           f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
        = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
           c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16])
      for update of f;

  update nx_cells c
     set cur_value = f.value, cur_rev = f.rev, cur_exists = true
    from epm.fact f
   where f.app_id = v_app
     and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
          f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
       = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
          c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16]);

  if v_check and not v_override then
    select jsonb_agg(jsonb_build_object('k', b.k, 'expected_rev', b.r, 'current_rev', b.cur_rev,
                                        'current_value', b.cur_value))
      into v_bad
      from (select * from nx_cells where has_r and cur_rev is distinct from r limit 200) b;
    if v_bad is not null then
      raise exception 'some cells changed after they were read' using errcode = 'NX409', detail = v_bad::text;
    end if;
  end if;

  -- Only real changes go further.
  delete from nx_cells where v is not distinct from cur_value;
  select count(*) into v_count from nx_cells;
  if v_count = 0 then
    return jsonb_build_object('txn_id', null, 'cell_count', 0);
  end if;

  v_txn := nextval('epm.txn_seq');

  delete from epm.fact f
   using nx_cells c
   where c.cur_exists and c.v is null
     and f.app_id = v_app
     and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
          f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
       = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
          c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16]);

  update epm.fact f
     set value = c.v, rev = v_txn
    from nx_cells c
   where c.cur_exists and c.v is not null
     and f.app_id = v_app
     and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
          f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
       = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
          c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16]);

  update nx_cells set done = true where cur_exists;

  with ins as (
    insert into epm.fact (tenant_id, app_id, cube_id, scenario_id, version_id, years_id, period_id,
                          entity_id, account_id, department_id, c1, c2, c3, c4, c5, c6, c7, c8, value, rev)
    select v_tenant, v_app, k[1], k[2], k[3], k[4], k[5], k[6], k[7],
           k[8], k[9], k[10], k[11], k[12], k[13], k[14], k[15], k[16], v, v_txn
      from nx_cells
     where not cur_exists and v is not null
    on conflict do nothing
    returning cube_id, scenario_id, version_id, years_id, period_id, entity_id, account_id,
              department_id, c1, c2, c3, c4, c5, c6, c7, c8
  )
  update nx_cells c
     set done = true
    from ins f
   where (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
          f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
       = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
          c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16]);

  -- Cells another transaction created between our read and our insert.
  if exists (select 1 from nx_cells where not done) then
    if v_check and not v_override then
      select jsonb_agg(jsonb_build_object('k', k, 'expected_rev', r)) into v_bad from nx_cells where not done;
      raise exception 'some cells were created by another user' using errcode = 'NX409', detail = v_bad::text;
    end if;

    perform 1
       from epm.fact f join nx_cells c
         on not c.done and f.app_id = v_app
        and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
             f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
          = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
             c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16])
        for update of f;

    update nx_cells c
       set cur_value = f.value, cur_rev = f.rev, cur_exists = true
      from epm.fact f
     where not c.done and f.app_id = v_app
       and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
            f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
         = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
            c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16]);

    if exists (select 1 from nx_cells where not done and not cur_exists) then
      raise exception 'concurrent change; retry the request' using errcode = 'NX409';
    end if;

    delete from nx_cells where not done and v is not distinct from cur_value;

    update epm.fact f
       set value = c.v, rev = v_txn
      from nx_cells c
     where not c.done and f.app_id = v_app
       and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
            f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
         = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
            c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16]);

    update nx_cells set done = true where not done;
    select count(*) into v_count from nx_cells;
    if v_count = 0 then
      return jsonb_build_object('txn_id', null, 'cell_count', 0);
    end if;
  end if;

  insert into epm.cell_audit (tenant_id, app_id, txn_id, cell_key, coords, old_value, new_value, changed_at)
  select v_tenant, v_app, v_txn, cell_key, k, cur_value, v, v_now from nx_cells;

  -- Link the hash chain. The lock is held only until commit. The transaction's time is taken under
  -- the lock, so created_at follows chain order: "the history as of time T" is exactly the
  -- transactions with created_at <= T, however long each writer took.
  perform pg_advisory_xact_lock(hashtextextended('nextwelve.chain.' || v_app::text, 0));
  v_joined := clock_timestamp();
  select t.chain_seq, t.txn_hash into v_prev_seq, v_prev_hash
    from epm.change_txn t where t.app_id = v_app
   order by t.chain_seq desc limit 1;

  v_hash := epm.txn_hash(v_prev_hash, v_txn, v_tenant, v_app, v_user, v_source, v_ref, v_count, v_joined,
                         epm.audit_digest(v_txn));

  insert into epm.change_txn (txn_id, tenant_id, app_id, user_id, source, source_ref, client, comment,
                              cell_count, chain_seq, prev_hash, txn_hash, created_at)
  values (v_txn, v_tenant, v_app, v_user, v_source, v_ref, p->'client', p->>'comment',
          v_count, coalesce(v_prev_seq, 0) + 1, v_prev_hash, v_hash, v_joined);

  return jsonb_build_object('txn_id', v_txn, 'cell_count', v_count);
end $$;

-- ---------------------------------------------------------------------------
-- Point-in-time restore of a slice (see 0007). Plans, writes through apply_changes, then plans
-- again in the same transaction: if anything is still to do, a concurrent writer committed in
-- between, and the whole restore is rolled back with NXRTY so the caller can run it again.
-- Payload as in 0007, plus max_cells (default 100000) for real runs.
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
      'skipped', v_skipped, 'skipped_sample', coalesce(v_sample, '[]'::jsonb), 'max_cells', v_max);
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

-- ---------------------------------------------------------------------------
-- A new top-level leaf in a dimension, deployed on its own: for restores into a new version.
-- A full deploy would also publish other administrators' pending edits.
-- ---------------------------------------------------------------------------
create function epm.add_version_leaf(p_dim int, p_name text) returns int
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
  insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail)
  values (d.tenant_id, d.app_id, v_user, 'version_added', jsonb_build_object('name', p_name, 'metadata_rev', v_rev));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Remove an application whose restore failed part way (state 'restoring'). Its change history
-- stays, like all history; its facts, metadata and any snapshot rows go.
--   discard_restoring_app: a service administrator, or the restore's own loader cleaning up
--     after itself (app.restoring_app names the application; no user needed, so a loader whose
--     user was disabled mid-restore still cleans up).
--   sweep_restoring_apps: the nightly job, for restores that died without cleaning up.
-- ---------------------------------------------------------------------------
create function epm.discard_app_internal(p_app uuid, p_user uuid, p_reason text) returns boolean
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_name  text;
  v_state text;
begin
  select name, state into v_name, v_state from epm.application where app_id = p_app for update;
  if not found then
    return false;
  end if;
  if v_state <> 'restoring' then
    raise exception 'only an application that is being restored can be discarded' using errcode = 'NX409';
  end if;
  delete from epm.fact where app_id = p_app;
  delete from epm.member_ancestor ma using epm.dimension dm where dm.dim_id = ma.dim_id and dm.app_id = p_app;
  delete from epm.effective_access where app_id = p_app;
  delete from epm.plan_window where app_id = p_app;
  delete from epm.access_grant where app_id = p_app;
  delete from epm.snapshot where app_id = p_app;
  delete from epm.member m using epm.dimension dm where dm.dim_id = m.dim_id and dm.app_id = p_app;
  delete from epm.application where app_id = p_app;
  insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail)
  values (epm.current_tenant(), p_app, p_user, 'restore_discarded', jsonb_build_object('name', v_name, 'reason', p_reason));
  return true;
end $$;

create function epm.discard_restoring_app(p_app uuid) returns void
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_user uuid := epm.current_app_user();
begin
  if epm.current_tenant() is null then
    raise exception 'no session tenant' using errcode = 'NX401';
  end if;
  if coalesce(current_setting('app.restoring_app', true), '') <> p_app::text then
    v_user := epm.require_active_user();
    if epm.role_rank(epm.user_app_role(null)) < epm.role_rank('service_admin') then
      raise exception 'requires role service_admin' using errcode = 'NX403';
    end if;
  end if;
  if not epm.discard_app_internal(p_app, v_user, 'restore failed') then
    raise exception 'application not found' using errcode = 'NX404';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- A digest of everything a snapshot holds besides facts. Runs with the caller's rights (RLS).
-- ---------------------------------------------------------------------------
create function epm.app_fingerprint(p_app uuid) returns text
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
    union all select 'i|' || x::text from epm.import_format x where x.app_id = p_app
    union all select 'mr|' || x::text from epm.mapping_rule x where x.app_id = p_app
    union all select 'ds|' || x::text from epm.dataset x where x.app_id = p_app
    union all select 'dv|' || v.dataset_id || ':' || v.version from epm.dataset_version v
      join epm.dataset d on d.dataset_id = v.dataset_id where d.app_id = p_app
  ) s(t) $$;

alter table epm.snapshot add column content_hash text;

-- ---------------------------------------------------------------------------
-- The scheduled job's credential. Only the schema owner reads it; the API role can call
-- snapshot_targets only with the key the scheduled Worker holds (secret JOB_KEY).
-- ---------------------------------------------------------------------------
create table epm.job_credential (
  id         int primary key default 1 check (id = 1),
  key_hash   bytea not null,
  created_at timestamptz not null default now()
);

create function epm.set_job_key(p_key text) returns void
  language sql
  as $$
  insert into epm.job_credential (id, key_hash) values (1, sha256(convert_to(p_key, 'UTF8')))
  on conflict (id) do update set key_hash = excluded.key_hash, created_at = now() $$;

drop function epm.snapshot_targets();
create function epm.snapshot_targets(p_key text) returns table (tenant_id uuid, app_id uuid)
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  t record;
begin
  if epm.current_tenant() is not null then
    raise exception 'snapshot_targets runs without a tenant in the session' using errcode = 'NX422';
  end if;
  if p_key is null or length(p_key) < 32
     or not exists (select 1 from epm.job_credential c where c.key_hash = sha256(convert_to(p_key, 'UTF8'))) then
    raise exception 'a valid job key is required' using errcode = 'NX403';
  end if;
  for t in select tn.tenant_id from epm.tenant tn order by tn.tenant_id loop
    perform set_config('app.tenant_id', t.tenant_id::text, true);
    return query select a.tenant_id, a.app_id from epm.application a where a.state = 'online' order by a.app_id;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

create function epm.sweep_restoring_apps(p_key text, p_hours int) returns table (tenant_id uuid, app_id uuid)
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  t record;
  a record;
begin
  if epm.current_tenant() is not null then
    raise exception 'sweep_restoring_apps runs without a tenant in the session' using errcode = 'NX422';
  end if;
  if p_key is null or length(p_key) < 32
     or not exists (select 1 from epm.job_credential c where c.key_hash = sha256(convert_to(p_key, 'UTF8'))) then
    raise exception 'a valid job key is required' using errcode = 'NX403';
  end if;
  for t in select tn.tenant_id from epm.tenant tn order by tn.tenant_id loop
    perform set_config('app.tenant_id', t.tenant_id::text, true);
    for a in select x.app_id from epm.application x
              where x.state = 'restoring' and x.created_at < now() - make_interval(hours => greatest(p_hours, 1)) loop
      if epm.discard_app_internal(a.app_id, null, 'restore did not finish') then
        tenant_id := t.tenant_id;
        app_id := a.app_id;
        return next;
      end if;
    end loop;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

revoke execute on function epm.set_job_key(text) from public;
revoke execute on function epm.discard_app_internal(uuid, uuid, text) from public;
grant execute on function
  epm.restore_slice(jsonb), epm.snapshot_targets(text), epm.add_version_leaf(int, text),
  epm.discard_restoring_app(uuid), epm.app_fingerprint(uuid), epm.sweep_restoring_apps(text, int)
  to epm_app;
