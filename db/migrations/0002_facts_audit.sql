-- 0002_facts_audit: sparse leaf-level facts, change transactions and the cell-level audit trail.

-- Coordinates are always carried as one int[16] in this order:
--   [cube, scenario, version, years, period, entity, account, department, c1, c2, c3, c4, c5, c6, c7, c8]
-- Department is optional per cube; it and unused custom slots hold 0 when a cube does not use them.

create table epm.fact (
  tenant_id   uuid not null,
  app_id      uuid not null,
  cube_id     int  not null,
  scenario_id int  not null,
  version_id  int  not null,
  years_id    int  not null,
  period_id   int  not null,
  entity_id   int  not null,
  account_id  int  not null,
  department_id int not null default 0,
  c1 int not null default 0, c2 int not null default 0,
  c3 int not null default 0, c4 int not null default 0,
  c5 int not null default 0, c6 int not null default 0,
  c7 int not null default 0, c8 int not null default 0,
  value       numeric(24,6) not null,
  rev         bigint not null,                  -- txn_id of the last change
  primary key (app_id, cube_id, scenario_id, version_id, entity_id, account_id, department_id,
               years_id, period_id, c1, c2, c3, c4, c5, c6, c7, c8)
) partition by hash (app_id);

do $$
begin
  for i in 0..15 loop
    execute format('create table epm.fact_p%s partition of epm.fact for values with (modulus 16, remainder %s)', i, i);
  end loop;
end $$;

-- txn ids are reserved at the start of epm.apply_changes(); the change_txn row is inserted last.
create sequence epm.txn_seq;

create table epm.change_txn (
  txn_id     bigint primary key,
  tenant_id  uuid not null,
  app_id     uuid not null,
  user_id    uuid,                               -- null for scheduled system jobs
  source     text not null check (source in
             ('grid_submit','rule','data_load','version_copy','clear','undo','restore','api')),
  source_ref text,                               -- form, rule run, load, snapshot or undone txn
  client     jsonb,                              -- spreadsheet id, sheet, add-on version, IP
  comment    text,
  cell_count int not null,
  chain_seq  bigint not null,                    -- position in the application's hash chain
  prev_hash  bytea,
  txn_hash   bytea not null,
  created_at timestamptz not null,
  unique (app_id, chain_seq)
);
create index change_txn_app_created on epm.change_txn (app_id, created_at desc);

create table epm.cell_audit (
  tenant_id  uuid   not null,
  app_id     uuid   not null,
  txn_id     bigint not null,
  cell_key   bytea  not null,                    -- 16-byte hash of the coordinates
  coords     int[]  not null,
  old_value  numeric(24,6),                      -- null = the cell was empty
  new_value  numeric(24,6),                      -- null = the cell was cleared
  changed_at timestamptz not null
) partition by range (changed_at);

create index cell_audit_cell on epm.cell_audit (app_id, cell_key, changed_at desc);
create index cell_audit_txn  on epm.cell_audit (txn_id);

-- Safety net; monthly partitions are created ahead of time so this stays empty.
create table epm.cell_audit_default partition of epm.cell_audit default;

create function epm.ensure_audit_partitions(p_from date, p_months int) returns int
  language plpgsql
  as $$
declare
  v_start date := date_trunc('month', p_from)::date;
  v_made  int  := 0;
  v_name  text;
begin
  for i in 0..p_months - 1 loop
    v_name := 'cell_audit_' || to_char(v_start + make_interval(months => i), 'YYYY_MM');
    if to_regclass('epm.' || v_name) is null then
      execute format(
        'create table epm.%I partition of epm.cell_audit for values from (%L) to (%L)',
        v_name,
        (v_start + make_interval(months => i))::timestamptz,
        (v_start + make_interval(months => i + 1))::timestamptz);
      v_made := v_made + 1;
    end if;
  end loop;
  return v_made;
end $$;

select epm.ensure_audit_partitions((now() - interval '1 month')::date, 15);

-- Stable 16-byte key for a cell's coordinates.
create function epm.cell_key(p_coords int[]) returns bytea
  language sql immutable parallel safe
  as $$ select substring(sha256(convert_to(array_to_string(p_coords, ','), 'UTF8')) from 1 for 16) $$;

-- Position of a dimension's member in the coordinate array.
create function epm.coord_index(p_dim_type text, p_slot smallint) returns int
  language sql immutable parallel safe
  as $$
  select case p_dim_type
    when 'scenario' then 2 when 'version' then 3 when 'years' then 4
    when 'period'   then 5 when 'entity'  then 6 when 'account' then 7
    when 'department' then 8
    when 'custom'   then 8 + p_slot
  end $$;

-- Digest of one transaction's audit rows, in cell_key order.
create function epm.audit_digest(p_txn bigint) returns bytea
  language sql stable
  as $$
  select sha256(convert_to(coalesce(string_agg(
           encode(cell_key, 'hex') || ':' || coalesce(old_value::text, '-') || ':' || coalesce(new_value::text, '-'),
           E'\n' order by cell_key), ''), 'UTF8'))
  from epm.cell_audit where txn_id = p_txn $$;

create function epm.txn_hash(
  p_prev bytea, p_txn bigint, p_tenant uuid, p_app uuid, p_user uuid, p_source text,
  p_ref text, p_count int, p_at timestamptz, p_digest bytea) returns bytea
  language sql immutable
  as $$
  select sha256(
    coalesce(p_prev, '\x'::bytea)
    || convert_to(concat_ws('|', p_txn, p_tenant, p_app, coalesce(p_user::text, ''), p_source,
                            coalesce(p_ref, ''), p_count, (extract(epoch from p_at) * 1000000)::bigint), 'UTF8')
    || p_digest) $$;
