-- 0003_functions: roles, metadata deploy, security resolution, the audited write path,
-- hash-chain verification, undo, login resolution and tenant provisioning.
--
-- Error codes raised (SQLSTATE):
--   NX401 no active session user   NX403 forbidden          NX404 not found
--   NX409 conflict                  NX422 invalid request    NX423 application locked

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
create function epm.role_rank(p_role text) returns int
  language sql immutable
  as $$
  select case p_role
    when 'service_admin' then 5 when 'app_admin' then 4 when 'power_user' then 3
    when 'planner' then 2 when 'viewer' then 1 else 0 end $$;

create function epm.user_app_role(p_app uuid) returns text
  language sql stable
  as $$
  select r.role from epm.user_role r
  where r.user_id = epm.current_app_user()
    and r.tenant_id = epm.current_tenant()
    and (r.app_id = p_app or r.app_id is null)
  order by epm.role_rank(r.role) desc
  limit 1 $$;

create function epm.require_active_user() returns uuid
  language plpgsql stable
  as $$
declare
  v_user   uuid := epm.current_app_user();
  v_tenant uuid := epm.current_tenant();
begin
  if v_user is null or v_tenant is null then
    raise exception 'no session tenant or user' using errcode = 'NX401';
  end if;
  perform 1 from epm.app_user a
   where a.user_id = v_user and a.tenant_id = v_tenant and a.status = 'active';
  if not found then
    raise exception 'user is not active' using errcode = 'NX401';
  end if;
  return v_user;
end $$;

create function epm.require_role(p_app uuid, p_min text) returns text
  language plpgsql stable
  as $$
declare
  v_role text := epm.user_app_role(p_app);
begin
  if epm.role_rank(v_role) < epm.role_rank(p_min) then
    raise exception 'requires role % or higher', p_min using errcode = 'NX403';
  end if;
  return v_role;
end $$;

-- ---------------------------------------------------------------------------
-- Member-level security: expand grants into effective_access
-- Precedence: closest grant wins; at equal distance a user grant beats group grants;
-- among group grants the most permissive wins. 'none' is an explicit deny.
-- ---------------------------------------------------------------------------
create function epm.rebuild_effective_access(p_app uuid) returns int
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_tenant uuid := epm.current_tenant();
  v_rows   int;
begin
  perform epm.require_active_user();
  perform epm.require_role(p_app, 'app_admin');

  delete from epm.effective_access where app_id = p_app;

  insert into epm.effective_access (tenant_id, app_id, user_id, dim_id, member_id, access)
  with ug as (
    select g.member_id as grant_member, g.scope, g.access, u.user_id, true as is_user_grant
      from epm.access_grant g
      join epm.app_user u on u.user_id = g.principal and u.tenant_id = v_tenant and u.status <> 'disabled'
     where g.app_id = p_app and g.principal_type = 'user'
    union all
    select g.member_id, g.scope, g.access, gm.user_id, false
      from epm.access_grant g
      join epm.group_member gm on gm.group_id = g.principal
      join epm.app_user u on u.user_id = gm.user_id and u.tenant_id = v_tenant and u.status <> 'disabled'
     where g.app_id = p_app and g.principal_type = 'group'
  ),
  cov as (
    select ug.user_id, ma.dim_id, ma.descendant_id as member_id, ma.depth, ug.is_user_grant, ug.access
      from ug
      join epm.member_ancestor ma on ma.ancestor_id = ug.grant_member
     where case ug.scope
             when 'member'      then ma.depth = 0
             when 'children'    then ma.depth = 1
             when 'ichildren'   then ma.depth <= 1
             when 'descendants' then ma.depth >= 1
             else true
           end
  ),
  ranked as (
    select cov.*,
           row_number() over (
             partition by cov.user_id, cov.member_id
             order by cov.depth,
                      cov.is_user_grant desc,
                      case cov.access when 'write' then 2 when 'read' then 1 else 0 end desc) as rn
      from cov
  )
  select v_tenant, p_app, user_id, dim_id, member_id, access
    from ranked
   where rn = 1 and access <> 'none';

  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- ---------------------------------------------------------------------------
-- Metadata deploy: validate hierarchies, rebuild the closure and ordinals, bump metadata_rev.
-- ---------------------------------------------------------------------------
create function epm.deploy_metadata(p_app uuid) returns jsonb
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

  insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail)
  values (v_tenant, p_app, v_user, 'metadata_deploy', jsonb_build_object('metadata_rev', v_rev));

  perform epm.rebuild_effective_access(p_app);

  return jsonb_build_object('metadata_rev', v_rev, 'closure_rows', v_rows);
end $$;

-- ---------------------------------------------------------------------------
-- The only write path for facts. Checks role, coordinates, member-level security and
-- plan windows; detects conflicts; writes facts; logs every changed cell; links the
-- application's hash chain. Payload:
--   { app_id, source, source_ref?, comment?, client?, check_rev?, override?,
--     cells: [ { k: int[16], v: number|null, r?: bigint|null } ] }
-- ---------------------------------------------------------------------------
create function epm.apply_changes(p jsonb) returns jsonb
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
  v_now       timestamptz := now();
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
  if v_state = 'restoring' and v_source <> 'restore' then
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

  -- Every coordinate must be a deployed leaf of the cube's dimension; unused slots must be 0.
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

  -- Link the hash chain. The lock is held only until commit.
  perform pg_advisory_xact_lock(hashtextextended('nextwelve.chain.' || v_app::text, 0));
  select t.chain_seq, t.txn_hash into v_prev_seq, v_prev_hash
    from epm.change_txn t where t.app_id = v_app
   order by t.chain_seq desc limit 1;

  v_hash := epm.txn_hash(v_prev_hash, v_txn, v_tenant, v_app, v_user, v_source, v_ref, v_count, v_now,
                         epm.audit_digest(v_txn));

  insert into epm.change_txn (txn_id, tenant_id, app_id, user_id, source, source_ref, client, comment,
                              cell_count, chain_seq, prev_hash, txn_hash, created_at)
  values (v_txn, v_tenant, v_app, v_user, v_source, v_ref, p->'client', p->>'comment',
          v_count, coalesce(v_prev_seq, 0) + 1, v_prev_hash, v_hash, v_now);

  return jsonb_build_object('txn_id', v_txn, 'cell_count', v_count);
end $$;

-- ---------------------------------------------------------------------------
-- Re-walk an application's hash chain.
-- ---------------------------------------------------------------------------
create function epm.verify_chain(p_app uuid) returns jsonb
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  r      record;
  v_prev bytea := null;
  v_seq  bigint := 0;
  v_n    int := 0;
  v_calc bytea;
  v_user uuid;
  v_out  jsonb;
begin
  v_user := epm.require_active_user();
  perform epm.require_role(p_app, 'app_admin');

  for r in select * from epm.change_txn where app_id = p_app order by chain_seq loop
    v_n := v_n + 1;
    if r.chain_seq <> v_seq + 1 or r.prev_hash is distinct from v_prev then
      v_out := jsonb_build_object('ok', false, 'checked', v_n, 'broken_at', r.chain_seq,
                                  'txn_id', r.txn_id, 'reason', 'chain link');
      exit;
    end if;
    v_calc := epm.txn_hash(r.prev_hash, r.txn_id, r.tenant_id, r.app_id, r.user_id, r.source,
                           r.source_ref, r.cell_count, r.created_at, epm.audit_digest(r.txn_id));
    if v_calc <> r.txn_hash then
      v_out := jsonb_build_object('ok', false, 'checked', v_n, 'broken_at', r.chain_seq,
                                  'txn_id', r.txn_id, 'reason', 'content');
      exit;
    end if;
    v_prev := r.txn_hash;
    v_seq  := r.chain_seq;
  end loop;

  v_out := coalesce(v_out, jsonb_build_object('ok', true, 'checked', v_n, 'head', encode(v_prev, 'hex')));

  insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail)
  values (epm.current_tenant(), p_app, v_user,
          case when (v_out->>'ok')::boolean then 'audit_verified' else 'audit_chain_broken' end, v_out);
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- Undo one change transaction by writing each cell's old value back.
-- ---------------------------------------------------------------------------
create function epm.undo_txn(p_txn bigint, p_force boolean default false) returns jsonb
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  t       epm.change_txn;
  v_user  uuid;
  v_rank  int;
  v_bad   jsonb;
  v_cells jsonb;
begin
  v_user := epm.require_active_user();
  select * into t from epm.change_txn where txn_id = p_txn;
  if not found then
    raise exception 'transaction not found' using errcode = 'NX404';
  end if;

  v_rank := epm.role_rank(epm.user_app_role(t.app_id));
  if not (v_rank >= 4 or (t.user_id = v_user and v_rank >= 2)) then
    raise exception 'only the author or an admin can undo this transaction' using errcode = 'NX403';
  end if;

  select jsonb_agg(to_jsonb(b.coords)) into v_bad from (
    select distinct a.coords
      from epm.cell_audit mine
      join epm.cell_audit a on a.app_id = mine.app_id and a.cell_key = mine.cell_key
      join epm.change_txn later on later.txn_id = a.txn_id and later.chain_seq > t.chain_seq
     where mine.txn_id = p_txn and later.app_id = t.app_id
     limit 200) b;
  if v_bad is not null and not p_force then
    raise exception 'some cells changed after this transaction' using errcode = 'NX409', detail = v_bad::text;
  end if;

  select jsonb_agg(jsonb_build_object('k', coords, 'v', old_value)) into v_cells
    from epm.cell_audit where txn_id = p_txn;

  return epm.apply_changes(jsonb_build_object(
    'app_id', t.app_id, 'source', 'undo', 'source_ref', p_txn::text,
    'comment', case when v_bad is not null then 'forced undo of txn ' else 'undo of txn ' end || p_txn,
    'cells', coalesce(v_cells, '[]'::jsonb)));
end $$;

-- ---------------------------------------------------------------------------
-- Login: match a verified Google identity to a user. Runs before any tenant is known,
-- so it relies on tenant and app_user not having FORCE ROW LEVEL SECURITY.
-- ---------------------------------------------------------------------------
create function epm.resolve_login(p_sub text, p_email text, p_hd text, p_email_verified boolean)
  returns table (user_id uuid, tenant_id uuid, status text)
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
#variable_conflict use_column
declare
  u        epm.app_user;
  v_tenant uuid;
begin
  select * into u from epm.app_user a where a.google_sub = p_sub;

  if u.user_id is null and p_email_verified then
    select * into u from epm.app_user a
     where a.google_sub is null and a.status = 'invited' and lower(a.email) = lower(p_email)
     order by a.created_at limit 1;
    if u.user_id is not null then
      update epm.app_user a set google_sub = p_sub, status = 'active'
       where a.user_id = u.user_id returning * into u;
    end if;
  end if;

  if u.user_id is null and p_email_verified and p_hd is not null then
    select t.tenant_id into v_tenant from epm.tenant t where lower(t.google_domain) = lower(p_hd);
    if v_tenant is not null then
      insert into epm.app_user (tenant_id, google_sub, email, status)
      values (v_tenant, p_sub, p_email, 'active') returning * into u;
    end if;
  end if;

  if u.user_id is null then
    return;
  end if;

  perform set_config('app.tenant_id', u.tenant_id::text, true);
  if u.status = 'active' then
    update epm.app_user a set last_login_at = now() where a.user_id = u.user_id;
  end if;
  insert into epm.security_event (tenant_id, user_id, event_type, detail)
  values (u.tenant_id, u.user_id,
          case when u.status = 'active' then 'login' else 'login_denied' end,
          jsonb_build_object('email', p_email, 'hd', p_hd));

  return query select u.user_id, u.tenant_id, u.status;
end $$;

-- ---------------------------------------------------------------------------
-- Provisioning (owner only; not granted to epm_app).
-- ---------------------------------------------------------------------------
create function epm.provision_tenant(p_name text, p_domain text, p_admin_email text) returns uuid
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_tenant uuid;
  v_user   uuid;
begin
  insert into epm.tenant (name, google_domain) values (p_name, nullif(lower(p_domain), ''))
  returning tenant_id into v_tenant;
  perform set_config('app.tenant_id', v_tenant::text, true);
  insert into epm.app_user (tenant_id, email, status) values (v_tenant, lower(p_admin_email), 'invited')
  returning user_id into v_user;
  insert into epm.user_role (tenant_id, user_id, app_id, role) values (v_tenant, v_user, null, 'service_admin');
  insert into epm.security_event (tenant_id, user_id, event_type, detail)
  values (v_tenant, v_user, 'tenant_provisioned', jsonb_build_object('admin_email', lower(p_admin_email)));
  return v_tenant;
end $$;
