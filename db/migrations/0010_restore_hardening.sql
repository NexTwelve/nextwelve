-- 0010_restore_hardening: fixes from adversarial testing of metadata restore and definitions.
--
--   * apply_changes takes a key-share lock on the application row, so cell writes wait for a deploy
--     or a metadata restore instead of landing on members those are removing; and analyzes its
--     temporary table, so large writes into an application that already has data plan well.
--   * Definition history refuses changes made without a tenant in the session (it could not tell
--     an application being dropped from one it cannot see).
--   * The migration baseline of 0009 is dated at the moment history starts, so a restore to that
--     moment works.
--   * Form and report names lose leading and trailing spaces (the API trims them from now on).

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

  -- A key-share lock on the application row: writes wait while a deploy or a metadata restore
  -- (which lock it for update) is running, so no cell lands on a member being removed.
  select a.state into v_state from epm.application a where a.app_id = v_app for key share;
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
  -- Temporary tables are never analyzed automatically; without row counts the planner can pick a
  -- nested loop over thousands of cells against the application's facts (seconds per batch).
  -- The index makes a lookup from the facts side cheap too, whichever way the planner joins.
  create index on nx_cells (k);
  analyze nx_cells;
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
       and c.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                       f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8]
      for update of f;

  update nx_cells c
     set cur_value = f.value, cur_rev = f.rev, cur_exists = true
    from epm.fact f
   where f.app_id = v_app
     and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
          f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
       = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
          c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16])
       and c.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                       f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8];

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
          c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16])
       and c.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                       f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8];

  update epm.fact f
     set value = c.v, rev = v_txn
    from nx_cells c
   where c.cur_exists and c.v is not null
     and f.app_id = v_app
     and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
          f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
       = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
          c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16])
       and c.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                       f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8];

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
          c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16])
       and c.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                       f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8];

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
       and c.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                       f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8]
        for update of f;

    update nx_cells c
       set cur_value = f.value, cur_rev = f.rev, cur_exists = true
      from epm.fact f
     where not c.done and f.app_id = v_app
       and (f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
            f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8)
         = (c.k[1], c.k[2], c.k[3], c.k[4], c.k[5], c.k[6], c.k[7],
            c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16])
       and c.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                       f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8];

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
            c.k[8], c.k[9], c.k[10], c.k[11], c.k[12], c.k[13], c.k[14], c.k[15], c.k[16])
       and c.k = array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id, f.account_id,
                       f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8];

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

create or replace function epm.log_artifact_version() returns trigger
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_kind text := case tg_table_name when 'form' then 'form' else 'report' end;
  v_row  jsonb;
  v_id   uuid;
begin
  if epm.current_tenant() is null then
    raise exception 'form and report definitions change only with a tenant in the session' using errcode = 'NX422';
  end if;
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
  insert into epm.artifact_version (tenant_id, app_id, kind, artifact_id, version, name, cube_id, folder, description,
                                    definition, changed_by)
  values (new.tenant_id, new.app_id, v_kind, v_id,
          greatest(new.version, coalesce((select max(version) + 1 from epm.artifact_version where artifact_id = v_id), 1)),
          new.name, new.cube_id, new.folder, new.description, new.definition,
          coalesce(new.updated_by, epm.current_app_user()));
  return new;
end $$;

do $$
declare
  t record;
begin
  for t in select tenant_id from epm.tenant loop
    perform set_config('app.tenant_id', t.tenant_id::text, true);
    -- The baseline revision (no user, the first one recorded) counts from the moment history starts.
    update epm.metadata_rev r set deployed_at = a.history_from
      from epm.application a
     where a.app_id = r.app_id and r.user_id is null and r.deployed_at > a.history_from
       and r.metadata_rev = (select min(x.metadata_rev) from epm.metadata_rev x where x.app_id = r.app_id);
    update epm.form f set name = btrim(f.name)
     where f.name <> btrim(f.name) and btrim(f.name) <> ''
       and not exists (select 1 from epm.form o where o.app_id = f.app_id and lower(o.name) = lower(btrim(f.name)));
    update epm.report f set name = btrim(f.name)
     where f.name <> btrim(f.name) and btrim(f.name) <> ''
       and not exists (select 1 from epm.report o where o.app_id = f.app_id and lower(o.name) = lower(btrim(f.name)));
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
