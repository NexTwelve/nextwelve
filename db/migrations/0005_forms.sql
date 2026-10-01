-- 0005_forms: saved data-entry forms, plus a helper that secures new tenant tables.

-- Every tenant table added after 0004 calls this: RLS on, forced, tenant policy.
create function epm.secure_tenant_table(p_table regclass) returns void
  language plpgsql
  as $$
begin
  execute format('alter table %s enable row level security', p_table);
  execute format('alter table %s force row level security', p_table);
  execute format(
    'create policy tenant_isolation on %s
       using (tenant_id = epm.current_tenant())
       with check (tenant_id = epm.current_tenant())', p_table);
end $$;

-- A form is a saved grid: fixed POV members, page dimensions the user picks from a list,
-- and row and column member selections.
create table epm.form (
  form_id     uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  app_id      uuid not null references epm.application on delete cascade,
  cube_id     int  not null references epm.cube on delete cascade,
  name        text not null,
  folder      text,
  description text,
  definition  jsonb not null,   -- { pov, page, rows, columns, read_only, instructions }
  version     int  not null default 1,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
create unique index form_name_ci on epm.form (app_id, lower(name));

select epm.secure_tenant_table('epm.form');
grant select, insert, update, delete on epm.form to epm_app;
