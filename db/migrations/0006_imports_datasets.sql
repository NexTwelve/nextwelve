-- 0006_imports_datasets: uploaded files, import formats, mapping rules, import runs with
-- drill-back lines, and versioned datasets (spreadsheets kept as queryable reference data).

-- Uploaded files. The bytes live in object storage (R2); this row is the catalogue entry.
create table epm.stored_file (
  file_id      uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null,
  app_id       uuid not null references epm.application on delete cascade,
  name         text not null,
  content_type text,
  byte_size    bigint not null,
  sha256       text not null,
  storage_key  text not null,
  purpose      text not null check (purpose in ('import','dataset')),
  uploaded_by  uuid,
  uploaded_at  timestamptz not null default now()
);
create index stored_file_app on epm.stored_file (app_id, uploaded_at desc);

-- Datasets: a named workbook or CSV whose sheets become tables. Each upload is a new version.
create table epm.dataset (
  dataset_id      uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null,
  app_id          uuid not null references epm.application on delete cascade,
  name            text not null,
  description     text,
  current_version int  not null default 0
);
create unique index dataset_name_ci on epm.dataset (app_id, lower(name));

create table epm.dataset_version (
  tenant_id   uuid not null,
  dataset_id  uuid not null references epm.dataset on delete cascade,
  version     int  not null,
  file_id     uuid references epm.stored_file on delete set null,
  sheets      jsonb not null,             -- [{ name, columns: [...], rows: n }]
  uploaded_by uuid,
  uploaded_at timestamptz not null default now(),
  primary key (dataset_id, version)
);

create table epm.dataset_row (
  tenant_id  uuid not null,
  dataset_id uuid not null,
  version    int  not null,
  sheet      text not null,
  row_no     int  not null,               -- row number in the source sheet
  data       jsonb not null,              -- { column: value }
  primary key (dataset_id, version, sheet, row_no),
  foreign key (dataset_id, version) references epm.dataset_version on delete cascade
);

-- Import formats: how a file's columns become cube coordinates and an amount.
create table epm.import_format (
  format_id   uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  app_id      uuid not null references epm.application on delete cascade,
  cube_id     int  not null references epm.cube on delete cascade,
  name        text not null,
  definition  jsonb not null,
  version     int  not null default 1,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
create unique index import_format_name_ci on epm.import_format (app_id, lower(name));

-- Mapping rules translate source values into member names, per format and dimension.
-- Evaluated explicit, dataset, between, in, like; priority orders rules of one type.
create table epm.mapping_rule (
  rule_id     bigint generated always as identity primary key,
  tenant_id   uuid not null,
  app_id      uuid not null,
  format_id   uuid not null references epm.import_format on delete cascade,
  dimension   text not null,
  rule_type   text not null check (rule_type in ('explicit','dataset','between','in','like')),
  source      text not null,   -- explicit: value · between: low..high · in: a,b,c · like: pattern with * and ? · dataset: dataset name
  target      text not null,   -- member name; * = the source value; #skip = drop the line · dataset: value column
  options     jsonb,           -- dataset: { sheet, key_column }
  priority    int  not null default 0,
  description text
);
create index mapping_rule_format on epm.mapping_rule (format_id, dimension);

create table epm.import_run (
  run_id         uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null,
  app_id         uuid not null references epm.application on delete cascade,
  format_id      uuid references epm.import_format on delete set null,
  format_version int,
  file_id        uuid references epm.stored_file on delete set null,
  source_dataset jsonb,              -- { dataset, version, sheet } when the source is a dataset
  mode           text not null check (mode in ('merge','replace','accumulate')),
  dry_run        boolean not null default false,
  status         text not null check (status in ('validated','failed','loaded')),
  lines_read     int not null default 0,
  lines_mapped   int not null default 0,
  lines_skipped  int not null default 0,
  lines_rejected int not null default 0,
  cells          int not null default 0,
  txn_id         bigint,
  datasets_used  jsonb,              -- [{ dataset, version }] read by mapping rules
  errors         jsonb,              -- first rejected lines with reasons
  created_by     uuid,
  created_at     timestamptz not null default now()
);
create index import_run_app on epm.import_run (app_id, created_at desc);

-- Every source line of a run, mapped or rejected: the drill-back from a cell to its file rows.
create table epm.import_line (
  tenant_id uuid not null,
  run_id    uuid not null references epm.import_run on delete cascade,
  line_no   int  not null,             -- row number in the source sheet
  source    jsonb not null,
  coords    int[],                     -- null when the line was skipped or rejected
  amount    numeric(24,6),
  error     text,
  primary key (run_id, line_no)
);
create index import_line_coords on epm.import_line (coords) where coords is not null;

select epm.secure_tenant_table('epm.stored_file');
select epm.secure_tenant_table('epm.dataset');
select epm.secure_tenant_table('epm.dataset_version');
select epm.secure_tenant_table('epm.dataset_row');
select epm.secure_tenant_table('epm.import_format');
select epm.secure_tenant_table('epm.mapping_rule');
select epm.secure_tenant_table('epm.import_run');
select epm.secure_tenant_table('epm.import_line');

grant select, insert, update, delete on
  epm.stored_file, epm.dataset, epm.dataset_version, epm.dataset_row,
  epm.import_format, epm.mapping_rule, epm.import_run, epm.import_line
  to epm_app;
