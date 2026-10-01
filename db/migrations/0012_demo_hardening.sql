-- 0012_demo_hardening: the public demo under abuse and failure.
--
--   * start_demo checks every limit before doing any work, and does no tidying of its own (that
--     moved to tidy_demo_tenants, run after a successful start, outside the start lock). Besides
--     the per-hour rate, one network may hold only so many live copies at once. A copy being
--     replaced ("Start over") does not count against the limits; it is ended after the new one
--     is ready. A refusal says nothing about other copies.
--   * purge_tenant locks the copy's applications first, so a write in flight finishes before
--     its cells are deleted (apply_changes holds a key-share lock on the application), finds
--     each table's rows through an index, and records the tenant in demo_purged_files until its
--     stored files are known to be gone.
--   * sweep_demo_tenants and tidy_demo_tenants skip copies another purge has locked, so a demo
--     start never waits behind the hourly sweep; the sweep works in small batches.

-- Indexes the purge (and deploy, for member_ancestor) use instead of scanning every tenant's rows.
create index if not exists change_txn_tenant on epm.change_txn (tenant_id);
create index if not exists metadata_change_tenant on epm.metadata_change (tenant_id);
create index if not exists member_ancestor_dim on epm.member_ancestor (dim_id);

-- Which copy each start made, so live copies can be counted per network. (Not tenant_id: this
-- log belongs to no tenant and is closed to the API role; tenant tables are the ones under RLS.)
alter table epm.demo_signup add column demo_tenant uuid;
create index demo_signup_demo_tenant on epm.demo_signup (demo_tenant);

-- Tenants whose rows are gone but whose stored files may not be (the sweep retries them).
create table epm.demo_purged_files (
  purged_tenant uuid primary key,
  purged_at     timestamptz not null default now()
);
revoke all on epm.demo_purged_files from epm_app;

-- ---------------------------------------------------------------------------
create or replace function epm.purge_tenant(p_tenant uuid) returns boolean
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_prev text := coalesce(current_setting('app.tenant_id', true), '');
  v_apps uuid[];
  v_hist uuid[];
  v_dims int[];
begin
  perform 1 from epm.tenant where tenant_id = p_tenant and demo_expires_at is not null for update;
  if not found then
    return false;           -- gone already, or not a demo tenant (those are never purged here)
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  -- Writers hold a key-share lock on their application until they commit: wait for them, and
  -- keep new ones out, before any cell is deleted.
  perform 1 from epm.application where tenant_id = p_tenant order by app_id for update;
  v_apps := array(select app_id from epm.application where tenant_id = p_tenant);
  -- History can name applications that no longer exist (a discarded restore).
  v_hist := array(select distinct app_id from epm.change_txn where tenant_id = p_tenant) || v_apps;
  v_dims := array(select dim_id from epm.dimension where app_id = any(v_apps));
  delete from epm.fact where app_id = any(v_apps);
  delete from epm.cell_audit where app_id = any(v_hist);
  delete from epm.change_txn where tenant_id = p_tenant;
  delete from epm.metadata_change where tenant_id = p_tenant;
  delete from epm.member_ancestor where dim_id = any(v_dims);
  delete from epm.effective_access where app_id = any(v_apps);
  delete from epm.snapshot where app_id = any(v_hist);
  delete from epm.security_event where tenant_id = p_tenant;
  delete from epm.application where tenant_id = p_tenant;   -- cascades to the rest of each application
  delete from epm.tenant where tenant_id = p_tenant;        -- users, roles and groups go with it
  update epm.demo_signup set demo_tenant = null where demo_tenant = p_tenant;   -- the start stays counted
  insert into epm.demo_purged_files (purged_tenant) values (p_tenant) on conflict do nothing;
  perform set_config('app.tenant_id', v_prev, true);
  return true;
end $$;
revoke execute on function epm.purge_tenant(uuid) from public;

-- ---------------------------------------------------------------------------
drop function if exists epm.start_demo(bytea, int, int, int, jsonb);

-- Start a demo. Every limit is checked first; a refusal does no other work.
--   p_per_ip_live: live copies one network may hold at once.
--   p_replacing:   the copy a "Start over" replaces (left out of the counts; the caller ends it).
create function epm.start_demo(p_ip_hash bytea, p_max_live int, p_per_ip_hour int, p_per_ip_live int, p_hours int,
                               p_users jsonb, p_replacing uuid default null)
  returns jsonb
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_tenant  uuid;
  v_hours   int := greatest(least(p_hours, 168), 1);
  v_expires timestamptz := now() + make_interval(hours => greatest(least(p_hours, 168), 1));
  v_users   jsonb := '[]'::jsonb;
  u         jsonb;
  v_user    uuid;
  v_first   boolean := true;
begin
  if epm.current_tenant() is not null then
    raise exception 'start_demo runs without a tenant in the session' using errcode = 'NX422';
  end if;
  if p_ip_hash is null or length(p_ip_hash) < 16 then
    raise exception 'missing client hash' using errcode = 'NX422';
  end if;
  -- One demo start at a time, so the caps hold under concurrent clicks.
  perform pg_advisory_xact_lock(hashtextextended('nextwelve.demo', 0));

  if (select count(*) from epm.demo_signup where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= p_per_ip_hour then
    raise exception 'too many demos started from your network in the last hour; try again later' using errcode = 'NX429';
  end if;
  if (select count(*) from epm.demo_signup s join epm.tenant t on t.tenant_id = s.demo_tenant
       where s.ip_hash = p_ip_hash and t.demo_expires_at > now() and t.tenant_id is distinct from p_replacing) >= p_per_ip_live then
    raise exception 'your network already has as many demo copies as it may hold; use one of them, or try again later'
      using errcode = 'NX429';
  end if;
  if (select count(*) from epm.tenant where demo_expires_at > now() and tenant_id is distinct from p_replacing) >= p_max_live then
    raise exception 'the demo is busy right now; try again in a few minutes' using errcode = 'NX503';
  end if;

  delete from epm.demo_signup where created_at < now() - make_interval(hours => greatest(v_hours, 24) + 1);

  insert into epm.tenant (name, google_domain, demo_expires_at) values ('NexTwelve demo', null, v_expires)
  returning tenant_id into v_tenant;
  perform set_config('app.tenant_id', v_tenant::text, true);
  for u in select * from jsonb_array_elements(p_users) loop
    insert into epm.app_user (tenant_id, email, display_name, status)
    values (v_tenant, lower(u->>'email'), u->>'display_name', 'active')
    returning user_id into v_user;
    if v_first then
      insert into epm.user_role (tenant_id, user_id, app_id, role) values (v_tenant, v_user, null, 'service_admin');
      v_first := false;
    end if;
    v_users := v_users || jsonb_build_object('email', lower(u->>'email'), 'user_id', v_user);
  end loop;
  insert into epm.security_event (tenant_id, event_type, detail)
  values (v_tenant, 'demo_started', jsonb_build_object('expires_at', v_expires));
  insert into epm.demo_signup (ip_hash, demo_tenant) values (p_ip_hash, v_tenant);
  perform set_config('app.tenant_id', '', true);
  return jsonb_build_object('tenant_id', v_tenant, 'expires_at', v_expires, 'users', v_users);
end $$;

-- A few expired copies go after a successful start (the hourly sweep takes the rest). Copies
-- another purge is working on are skipped, never waited for.
create function epm.tidy_demo_tenants(p_limit int) returns table (tenant_id uuid)
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  t record;
begin
  if epm.current_tenant() is not null then
    raise exception 'tidy_demo_tenants runs without a tenant in the session' using errcode = 'NX422';
  end if;
  for t in select x.tenant_id from epm.tenant x where x.demo_expires_at < now()
            order by x.demo_expires_at limit greatest(least(p_limit, 3), 0) for update skip locked loop
    if epm.purge_tenant(t.tenant_id) then
      tenant_id := t.tenant_id;
      return next;
    end if;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

-- The scheduled job: expired copies in batches (the caller repeats until a batch comes back short).
drop function if exists epm.sweep_demo_tenants(text);
create function epm.sweep_demo_tenants(p_key text, p_limit int default 25) returns table (tenant_id uuid)
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  t record;
begin
  if epm.current_tenant() is not null then
    raise exception 'sweep_demo_tenants runs without a tenant in the session' using errcode = 'NX422';
  end if;
  perform epm.require_job_key(p_key);
  for t in select x.tenant_id from epm.tenant x where x.demo_expires_at < now()
            order by x.demo_expires_at limit greatest(least(p_limit, 500), 1) for update skip locked loop
    if epm.purge_tenant(t.tenant_id) then
      tenant_id := t.tenant_id;
      return next;
    end if;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

-- Tenants whose files the sweep should (re)delete, and marking them done (job key).
create function epm.demo_files_pending(p_key text, p_limit int default 500) returns table (tenant_id uuid)
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
begin
  perform epm.require_job_key(p_key);
  return query select f.purged_tenant from epm.demo_purged_files f
                order by f.purged_at limit greatest(least(p_limit, 5000), 1);
end $$;

create function epm.demo_files_cleared(p_key text, p_tenants uuid[]) returns void
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
begin
  perform epm.require_job_key(p_key);
  delete from epm.demo_purged_files where purged_tenant = any(p_tenants);
end $$;

-- The job key check shared by the scheduled entry points above.
create function epm.require_job_key(p_key text) returns void
  language plpgsql stable security definer set search_path = epm, pg_temp
  as $$
begin
  if p_key is null or length(p_key) < 32
     or not exists (select 1 from epm.job_credential c where c.key_hash = sha256(convert_to(p_key, 'UTF8'))) then
    raise exception 'a valid job key is required' using errcode = 'NX403';
  end if;
end $$;
revoke execute on function epm.require_job_key(text) from public;

grant execute on function epm.start_demo(bytea, int, int, int, int, jsonb, uuid), epm.tidy_demo_tenants(int),
  epm.sweep_demo_tenants(text, int), epm.demo_files_pending(text, int), epm.demo_files_cleared(text, uuid[]) to epm_app;
