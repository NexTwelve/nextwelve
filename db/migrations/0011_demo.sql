-- 0011_demo: public demo sandboxes. Each visitor who clicks "Try the demo" gets a tenant of their
-- own, holding a copy of the sample application, that is deleted when it expires.
--
--   * tenant.demo_expires_at: set only on demo tenants (real tenants have null).
--   * demo_template: the files of the snapshot every demo copy is loaded from (written by
--     `pnpm demo:template`, read only through demo_template_files()).
--   * demo_signup: one row per demo started, by a hash of the visitor's IP, for rate limiting.
--   * start_demo(): checks the per-IP rate and the cap on live copies, removes a few expired
--     copies, and creates the tenant with its demo users. Callable without a session.
--   * purge_tenant(): removes every row of a demo tenant (owner only; used by start_demo and the
--     scheduled sweep). sweep_demo_tenants(): the scheduled job's entry point (job key).

alter table epm.tenant add column demo_expires_at timestamptz;
create index tenant_demo_expiry on epm.tenant (demo_expires_at) where demo_expires_at is not null;

create table epm.demo_template (
  name       text primary key,         -- manifest.json, metadata.json.gz, datasets.json.gz, facts-0001.ndjson.gz, ...
  bytes      bytea not null,
  created_at timestamptz not null default now()
);
revoke all on epm.demo_template from epm_app;

create table epm.demo_signup (
  ip_hash    bytea not null,
  created_at timestamptz not null default now()
);
create index demo_signup_ip on epm.demo_signup (ip_hash, created_at);
revoke all on epm.demo_signup from epm_app;

create function epm.demo_template_files() returns table (name text, bytes bytea)
  language sql stable security definer set search_path = epm, pg_temp
  as $$ select t.name, t.bytes from epm.demo_template t order by t.name $$;

-- ---------------------------------------------------------------------------
-- Remove every row of a demo tenant. Row-level security is forced, so it runs as that tenant.
-- ---------------------------------------------------------------------------
create function epm.purge_tenant(p_tenant uuid) returns boolean
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_prev text := coalesce(current_setting('app.tenant_id', true), '');
  v_apps uuid[];
begin
  perform 1 from epm.tenant where tenant_id = p_tenant and demo_expires_at is not null for update;
  if not found then
    return false;           -- gone already, or not a demo tenant (those are never purged here)
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  v_apps := array(select app_id from epm.application where tenant_id = p_tenant);
  delete from epm.fact where app_id = any(v_apps);
  delete from epm.cell_audit where app_id = any(v_apps);
  delete from epm.change_txn where tenant_id = p_tenant;
  delete from epm.metadata_change where tenant_id = p_tenant;
  delete from epm.member_ancestor where tenant_id = p_tenant;
  delete from epm.effective_access where tenant_id = p_tenant;
  delete from epm.snapshot where tenant_id = p_tenant;
  delete from epm.security_event where tenant_id = p_tenant;
  delete from epm.application where tenant_id = p_tenant;   -- cascades to the rest of each application
  delete from epm.tenant where tenant_id = p_tenant;        -- users, roles and groups go with it
  perform set_config('app.tenant_id', v_prev, true);
  return true;
end $$;
revoke execute on function epm.purge_tenant(uuid) from public;

-- ---------------------------------------------------------------------------
-- Start a demo: limits first, then the tenant and its users (the first user is the
-- administrator). p_users: [{ "email": ..., "display_name": ... }, ...].
-- ---------------------------------------------------------------------------
create function epm.start_demo(p_ip_hash bytea, p_max_live int, p_per_ip_hour int, p_hours int, p_users jsonb)
  returns jsonb
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_tenant  uuid;
  v_expires timestamptz := now() + make_interval(hours => greatest(least(p_hours, 168), 1));
  v_purged  uuid[] := '{}';
  v_users   jsonb := '[]'::jsonb;
  t         record;
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
  -- One demo start at a time, so the cap holds under concurrent clicks.
  perform pg_advisory_xact_lock(hashtextextended('nextwelve.demo', 0));

  -- Tidy up: a few expired copies go now (the scheduled sweep takes the rest).
  for t in select tenant_id from epm.tenant where demo_expires_at < now() order by demo_expires_at limit 3 loop
    if epm.purge_tenant(t.tenant_id) then
      v_purged := v_purged || t.tenant_id;
    end if;
  end loop;
  delete from epm.demo_signup where created_at < now() - interval '1 day';

  if (select count(*) from epm.demo_signup where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= p_per_ip_hour then
    raise exception 'too many demos started from your network in the last hour; try again later'
      using errcode = 'NX429', detail = jsonb_build_object('purged', v_purged)::text;
  end if;
  if (select count(*) from epm.tenant where demo_expires_at > now()) >= p_max_live then
    raise exception 'the demo is busy right now; try again in a few minutes'
      using errcode = 'NX503', detail = jsonb_build_object('purged', v_purged)::text;
  end if;

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
  insert into epm.demo_signup (ip_hash) values (p_ip_hash);
  perform set_config('app.tenant_id', '', true);
  return jsonb_build_object('tenant_id', v_tenant, 'expires_at', v_expires, 'users', v_users, 'purged', to_jsonb(v_purged));
end $$;

-- A demo session ends early ("Start over"): its own tenant only, while a session of it is in use.
create function epm.end_demo() returns boolean
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  v_tenant uuid := epm.current_tenant();
begin
  perform epm.require_active_user();
  if not exists (select 1 from epm.tenant where tenant_id = v_tenant and demo_expires_at is not null) then
    raise exception 'only a demo can be ended' using errcode = 'NX403';
  end if;
  return epm.purge_tenant(v_tenant);
end $$;

-- The scheduled job: every expired demo tenant goes (job key, like snapshot_targets).
create function epm.sweep_demo_tenants(p_key text) returns table (tenant_id uuid)
  language plpgsql security definer set search_path = epm, pg_temp
  as $$
declare
  t record;
begin
  if epm.current_tenant() is not null then
    raise exception 'sweep_demo_tenants runs without a tenant in the session' using errcode = 'NX422';
  end if;
  if p_key is null or length(p_key) < 32
     or not exists (select 1 from epm.job_credential c where c.key_hash = sha256(convert_to(p_key, 'UTF8'))) then
    raise exception 'a valid job key is required' using errcode = 'NX403';
  end if;
  for t in select x.tenant_id from epm.tenant x where x.demo_expires_at < now() order by x.demo_expires_at limit 500 loop
    if epm.purge_tenant(t.tenant_id) then
      tenant_id := t.tenant_id;
      return next;
    end if;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;

grant execute on function epm.demo_template_files(), epm.start_demo(bytea, int, int, int, jsonb), epm.end_demo(),
  epm.sweep_demo_tenants(text) to epm_app;

-- The nightly snapshots skip demo copies (they are thrown away anyway).
create or replace function epm.snapshot_targets(p_key text) returns table (tenant_id uuid, app_id uuid)
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
  for t in select tn.tenant_id from epm.tenant tn where tn.demo_expires_at is null order by tn.tenant_id loop
    perform set_config('app.tenant_id', t.tenant_id::text, true);
    return query select a.tenant_id, a.app_id from epm.application a where a.state = 'online' order by a.app_id;
  end loop;
  perform set_config('app.tenant_id', '', true);
end $$;
