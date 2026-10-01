-- 0004_security: row-level security on every tenant table, and the privileges of epm_app.

-- Tenant isolation policy on every table (and partition) in epm that has tenant_id.
-- FORCE also binds the owner, so SECURITY DEFINER functions stay inside one tenant.
-- tenant and app_user are the exceptions: resolve_login() must find a user before any
-- tenant is known. epm_app is still bound by their policies.
do $$
declare
  r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'epm'
       and c.relkind in ('r', 'p')
       and exists (select 1 from pg_attribute a
                    where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped)
  loop
    execute format('alter table epm.%I enable row level security', r.relname);
    if r.relname not in ('tenant', 'app_user') then
      execute format('alter table epm.%I force row level security', r.relname);
    end if;
    execute format(
      'create policy tenant_isolation on epm.%I
         using (tenant_id = epm.current_tenant())
         with check (tenant_id = epm.current_tenant())', r.relname);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Privileges for the API role
-- ---------------------------------------------------------------------------
revoke all on schema epm from public;
grant usage on schema epm to epm_app;

-- Read access to the parent tables only; partitions get nothing directly.
grant select on
  epm.tenant, epm.app_user, epm.application, epm.user_role, epm.principal_group, epm.group_member,
  epm.cube, epm.dimension, epm.cube_dimension, epm.member, epm.member_ancestor, epm.plan_window,
  epm.access_grant, epm.effective_access, epm.metadata_change, epm.security_event, epm.grid_session,
  epm.fact, epm.change_txn, epm.cell_audit
  to epm_app;

-- Metadata and administration the API maintains directly (role checks happen in the API).
grant insert, update, delete on
  epm.app_user, epm.application, epm.user_role, epm.principal_group, epm.group_member,
  epm.cube, epm.dimension, epm.cube_dimension, epm.member, epm.plan_window, epm.access_grant,
  epm.grid_session
  to epm_app;

-- Logs are append-only for the API.
grant insert on epm.security_event to epm_app;

-- Explicitly: no direct writes to facts, the audit trail, the closure or resolved access.
revoke insert, update, delete, truncate on
  epm.fact, epm.cell_audit, epm.change_txn, epm.member_ancestor, epm.effective_access, epm.metadata_change
  from epm_app;

-- Functions: nothing is executable by PUBLIC; epm_app gets the entry points it needs.
revoke execute on all functions in schema epm from public;
grant execute on function
  epm.current_tenant(), epm.current_app_user(), epm.role_rank(text), epm.user_app_role(uuid),
  epm.require_active_user(), epm.require_role(uuid, text), epm.cell_key(int[]),
  epm.coord_index(text, smallint),
  epm.apply_changes(jsonb), epm.deploy_metadata(uuid), epm.rebuild_effective_access(uuid),
  epm.verify_chain(uuid), epm.undo_txn(bigint, boolean),
  epm.resolve_login(text, text, text, boolean)
  to epm_app;
-- epm.provision_tenant and epm.ensure_audit_partitions stay owner-only.

-- New functions created later must not become PUBLIC-executable by default.
alter default privileges in schema epm revoke execute on functions from public;
