-- 0001_core: tenancy, identity, roles, applications, dimensions, members, security grants.
-- Every tenant-owned table carries tenant_id; RLS policies are added in 0004.

create schema if not exists epm;

-- Session context. The API sets these with set_config(..., true) per transaction.
create function epm.current_tenant() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.tenant_id', true), '')::uuid $$;

create function epm.current_app_user() returns uuid
  language sql stable
  as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Tenancy and identity
-- ---------------------------------------------------------------------------
create table epm.tenant (
  tenant_id     uuid primary key default gen_random_uuid(),
  name          text not null,
  google_domain text unique,                    -- the hd claim, e.g. acme.com; null = invite-only
  created_at    timestamptz not null default now()
);

create table epm.app_user (
  user_id       uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references epm.tenant on delete cascade,
  google_sub    text unique,                    -- stable Google account id; null until first sign-in
  email         text not null,
  display_name  text,
  status        text not null default 'invited'
                check (status in ('invited','active','disabled')),
  created_at    timestamptz not null default now(),
  last_login_at timestamptz,
  unique (tenant_id, email)
);
create unique index app_user_email_ci on epm.app_user (tenant_id, lower(email));
create index app_user_email on epm.app_user (lower(email));

create table epm.application (
  app_id       uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references epm.tenant on delete cascade,
  name         text not null,
  metadata_rev int  not null default 0,          -- bumped on every deploy
  state        text not null default 'online'
               check (state in ('online','admin_only','restoring')),
  created_at   timestamptz not null default now(),
  unique (tenant_id, name)
);

-- Functional roles. service_admin is tenant-wide (app_id null); the rest are per application.
create table epm.user_role (
  tenant_id uuid not null references epm.tenant on delete cascade,
  user_id   uuid not null references epm.app_user on delete cascade,
  app_id    uuid references epm.application on delete cascade,
  role      text not null check (role in ('service_admin','app_admin','power_user','planner','viewer')),
  check ((role = 'service_admin') = (app_id is null))
);
create unique index user_role_one_per_scope
  on epm.user_role (user_id, coalesce(app_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table epm.principal_group (
  group_id  uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references epm.tenant on delete cascade,
  name      text not null,
  unique (tenant_id, name)
);

create table epm.group_member (
  tenant_id uuid not null references epm.tenant on delete cascade,
  group_id  uuid not null references epm.principal_group on delete cascade,
  user_id   uuid not null references epm.app_user on delete cascade,
  primary key (group_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Cubes, dimensions, members
-- ---------------------------------------------------------------------------
create table epm.cube (
  cube_id   int generated always as identity primary key,
  tenant_id uuid not null,
  app_id    uuid not null references epm.application on delete cascade,
  name      text not null,
  unique (app_id, name)
);

create table epm.dimension (
  dim_id    int generated always as identity primary key,
  tenant_id uuid not null,
  app_id    uuid not null references epm.application on delete cascade,
  name      text not null,
  dim_type  text not null check (dim_type in
            ('account','entity','period','years','scenario','version','department','custom')),
  slot      smallint check (slot between 1 and 8),   -- fact column c1..c8 for custom dims
  secured   boolean not null default false,         -- member-level access applies
  unique (app_id, name),
  check ((dim_type = 'custom') = (slot is not null))
);
create unique index dimension_fixed_type on epm.dimension (app_id, dim_type) where dim_type <> 'custom';
create unique index dimension_slot on epm.dimension (app_id, slot) where slot is not null;

create table epm.cube_dimension (
  tenant_id uuid not null,
  cube_id   int not null references epm.cube on delete cascade,
  dim_id    int not null references epm.dimension on delete cascade,
  primary key (cube_id, dim_id)
);

create table epm.member (
  member_id    int generated always as identity primary key,
  tenant_id    uuid not null,
  dim_id       int  not null references epm.dimension on delete cascade,
  name         text not null,
  alias        text,
  parent_id    int references epm.member,
  sort_order   int  not null default 0,
  agg_op       char(1) not null default '+' check (agg_op in ('+','-','~')),
  is_leaf      boolean not null default true,       -- maintained by deploy
  tree_ordinal int,                                 -- pre-order position in the dimension; set on deploy
  leaf_ordinal int,                                 -- position among leaves; set on deploy
  account_type text check (account_type in
               ('revenue','expense','asset','liability','equity','saved_assumption')),
  time_balance text check (time_balance in ('flow','first','last','average')),
  formula      text,                                -- dynamic member formula (rules DSL, step 3)
  unique (dim_id, name)
);
create index member_parent on epm.member (parent_id);
-- Names resolve case-insensitively, so they must be unique that way too.
create unique index member_name_ci on epm.member (dim_id, lower(name));
create unique index dimension_name_ci on epm.dimension (app_id, lower(name));
create unique index cube_name_ci on epm.cube (app_id, lower(name));
create unique index application_name_ci on epm.application (tenant_id, lower(name));
create unique index principal_group_name_ci on epm.principal_group (tenant_id, lower(name));

-- Closure over every deployed member: each ancestor paired with every descendant (depth 0 = itself).
-- sign = product of agg_op on the path (+ = 1, - = -1, ~ = 0). Rollups use descendant_is_leaf rows;
-- security resolution uses all rows. Rebuilt only by epm.deploy_metadata().
create table epm.member_ancestor (
  tenant_id          uuid not null,
  dim_id             int  not null,
  ancestor_id        int  not null,
  descendant_id      int  not null,
  depth              smallint not null,
  sign               smallint not null,
  descendant_is_leaf boolean not null,
  primary key (ancestor_id, descendant_id)
);
create index member_ancestor_desc on epm.member_ancestor (descendant_id);

-- Data-entry window per scenario, version and year. No row = open.
create table epm.plan_window (
  tenant_id       uuid not null,
  app_id          uuid not null references epm.application on delete cascade,
  scenario_id     int  not null references epm.member,
  version_id      int  not null references epm.member,
  years_id        int  not null references epm.member,
  start_period_id int references epm.member,
  end_period_id   int references epm.member,
  locked          boolean not null default false,
  primary key (app_id, scenario_id, version_id, years_id)
);

-- ---------------------------------------------------------------------------
-- Member-level security
-- ---------------------------------------------------------------------------
create table epm.access_grant (
  grant_id       bigint generated always as identity primary key,
  tenant_id      uuid not null,
  app_id         uuid not null references epm.application on delete cascade,
  principal_type text not null check (principal_type in ('user','group')),
  principal      uuid not null,                   -- user_id or group_id
  member_id      int  not null references epm.member on delete cascade,
  scope          text not null check (scope in ('member','children','ichildren','descendants','idescendants')),
  access         text not null check (access in ('none','read','write')),
  unique (app_id, principal_type, principal, member_id, scope)
);

-- Materialised by epm.rebuild_effective_access() on every grant change or deploy.
create table epm.effective_access (
  tenant_id uuid not null,
  app_id    uuid not null,
  user_id   uuid not null,
  dim_id    int  not null,
  member_id int  not null,
  access    text not null check (access in ('read','write')),
  primary key (app_id, user_id, dim_id, member_id)
);

-- ---------------------------------------------------------------------------
-- Logs
-- ---------------------------------------------------------------------------
create table epm.metadata_change (
  change_id    bigint generated always as identity primary key,
  tenant_id    uuid not null,
  app_id       uuid not null,
  metadata_rev int  not null,
  user_id      uuid,
  summary      jsonb not null,
  changed_at   timestamptz not null default now()
);

create table epm.security_event (
  event_id   bigint generated always as identity primary key,
  tenant_id  uuid not null,
  app_id     uuid,
  user_id    uuid,
  event_type text not null,
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index security_event_tenant on epm.security_event (tenant_id, created_at desc);

-- Server-side copy of each grid sent to the Sheets add-on; submit diffs against it.
create table epm.grid_session (
  grid_session_id uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  app_id          uuid not null references epm.application on delete cascade,
  user_id         uuid not null,
  cube_id         int  not null,
  metadata_rev    int  not null,
  spec            jsonb not null,
  layout          jsonb not null,   -- row/column member ids and POV coordinates
  cells           jsonb not null,   -- writable leaf cells: [{i, j, k, r, v}]
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default now() + interval '12 hours'
);
