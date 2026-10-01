-- Run once per cluster as a superuser (or the Cloud SQL admin user).
-- Creates the two login roles NexTwelve uses. Passwords / IAM auth are set
-- outside this file (Cloud SQL IAM database authentication in production).
--
--   epm_owner : owns the schema, runs migrations, owns SECURITY DEFINER functions.
--               Not a superuser and has no BYPASSRLS, so FORCE ROW LEVEL SECURITY binds it.
--   epm_app   : the API's login role. Owns nothing, no BYPASSRLS, cannot write
--               fact / cell_audit / change_txn directly.
do $$
begin
  if not exists (select from pg_roles where rolname = 'epm_owner') then
    create role epm_owner login nosuperuser nobypassrls nocreaterole;
  end if;
  if not exists (select from pg_roles where rolname = 'epm_app') then
    create role epm_app login nosuperuser nobypassrls nocreaterole nocreatedb;
  end if;
end $$;
