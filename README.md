# NexTwelve

Open-source planning and budgeting (EPM) for finance teams, free to deploy on your own
infrastructure. Planners work in browser forms today (a Google Sheets add-on is next); the plan
lives in Postgres. One API is the only path to the data: it checks member-level security, writes
the cells, and records a cell-level audit row in the same transaction.

**Stack:** Cloudflare Workers (Hono) · Hyperdrive · R2 · Workers static assets · Postgres 16
(PlanetScale Postgres or any managed Postgres). **License:** [Apache 2.0](LICENSE).

The site the Worker serves explains the product: `/` (landing page and live demo),
[`/architecture`](apps/api/public/architecture.html) (architecture and MVP requirements) and
[`/roadmap`](apps/api/public/roadmap.html) (the road to 1.0). The planning app itself is at `/app/`.

What is built:

- Postgres schema for tenants, applications, cubes, dimensions (including **Department**), members, facts, audit and security
- Row-level security on every tenant table, forced, so it binds `SECURITY DEFINER` functions too
- `epm.apply_changes()`: the single audited write path, with conflict detection and a per-application hash chain
- Metadata deploy, member-level access, plan windows, undo, chain verification
- **Forms**: saved layouts with a fixed POV, page drop-downs, and up to three dimensions on rows and on columns; open, edit, paste from Excel, submit, cell history
- **Reports**: read-only layouts with empty rows and columns hidden, units / thousands / millions, rounding, and Excel or CSV downloads
- **Definitions in Excel**: export every form and report to a workbook (a Definitions sheet and a Layout sheet) or CSV, edit, check and import; every saved version is kept and can be restored
- **File imports**: CSV or XLSX through mapping rules, validation (dry run), load, and drill-back from a cell to its source lines
- **Datasets**: workbooks kept as versioned reference data that mapping rules read by name
- **Backup and restore**: point-in-time restore of a data slice; **metadata restore** (members, hierarchies, forms, reports) to a moment or a snapshot; snapshots in R2 (manual, nightly with retention, pre-restore); restore from a snapshot in place or into a new application. Every restore is one undoable change
- **Phone access**: a read-only view of forms and reports on a phone, paired by QR code and approved on the computer
- **Public demo**: each visitor gets a private copy of the sample company in its own tenant, with three personas, guard rails and automatic cleanup
- A sample company, **Fernhollow Foods**, with a full model, forms, reports, a crosswalk workbook and a GL extract
- 523 tests in 75 suites, run against a real Postgres; 388 of them adversarial

## Layout

```
db/
  bootstrap/roles.sql          epm_owner and epm_app roles (run once per database cluster)
  migrations/0001..0013        core, facts and audit, functions, RLS, forms, imports and datasets, backup,
                               backup hardening, metadata history, restore hardening, demo, demo hardening,
                               device links
packages/db/                   migration runner and bootstrap CLI
apps/api/
  src/worker.ts                Worker entry: Hyperdrive, R2 and config bindings; the Cron Triggers
  src/app.ts                   Hono app (also runs in Node for tests and scripts)
  src/routes/                  auth, admin, grid, forms, definitions, data (files, datasets, imports), audit, backup
  src/backup/                  point-in-time restore, snapshots, snapshot restore, metadata restore, retention
  src/demo.ts                  public demo: template, start, personas, guard rails, cleanup
  src/devices.ts               read-only phone access: QR pairing, number match, read-only sessions
  src/files/                   CSV parser, small XLSX reader and writer (fflate; no xlsx package)
  public/                      landing, architecture and roadmap pages; the browser app under app/; the phone view under m/
  scripts/                     provision-tenant, seed-sample, demo-template
  test/                        vitest suites (fresh database per suite); adversarial/ holds the attack suites
  wrangler.jsonc               Worker config
samples/fernhollow/            model.json, gl_crosswalk.xlsx, gl_actuals_fy27_p01.csv
docker-compose.yml             local Postgres 16 on port 54329
```

## Local development

Requires Node 22+, pnpm 10 and Docker (or any Postgres 16).

```bash
docker compose up -d
cp .env.example .env                       # local defaults work as-is
cp apps/api/.dev.vars.example apps/api/.dev.vars   # set SESSION_SECRET (and your OAuth client ID)
pnpm install
pnpm db:bootstrap                          # roles + database "nextwelve"
pnpm db:migrate                            # schema, as epm_owner
pnpm seed:sample --admin-email you@gmail.com
pnpm demo:template                         # optional: the copy "Try the live demo" hands out (about a minute)
pnpm dev                                   # wrangler dev on http://localhost:8787
```

`wrangler dev` runs the Worker in workerd. Hyperdrive's `localConnectionString` in `wrangler.jsonc`
points at the local Postgres as `epm_app`, and R2 is simulated on disk under `.wrangler/`.

`http://localhost:8787` is the landing page; **Try the live demo** works without any Google setup
once `pnpm demo:template` has run. The planning app is at `/app/`. To sign in with Google, the browser UI needs a **Web application**
OAuth client whose authorized JavaScript origins include `http://localhost:8787`; put its client ID
in `GOOGLE_CLIENT_IDS` (`.dev.vars` locally, `wrangler.jsonc` vars when deployed).
For a personal Gmail account, set the consent screen to **External**, leave it in **Testing**, and
add yourself as a test user.

## Deploying to Cloudflare with PlanetScale Postgres

1. **Create the database.** In PlanetScale, create a **Postgres** database (a single node is enough to
   start; pick the region nearest your users). Its database is named `postgres`. Click **Connect**,
   choose the `main` branch and the default `postgres` role, and copy the host, username and
   password. The username has the branch id after a dot (`postgres.abc123xyz`); keep that suffix,
   because every role connects as `<role>.<branch id>`. The `postgres` role has `CREATEROLE` but
   also `BYPASSRLS`, so use it only for bootstrap.

2. **Create the roles and the schema** from your machine. Generate the two passwords with
   `openssl rand -hex 32` (hex, so they need no escaping in a URL), then in `.env`:

   ```bash
   ADMIN_DATABASE_URL=postgresql://postgres.<branch>:<password>@<host>:5432/postgres?sslmode=verify-full
   EPM_OWNER_PASSWORD=<hex password 1>
   EPM_APP_PASSWORD=<hex password 2>
   MIGRATION_DATABASE_URL=postgresql://epm_owner.<branch>:<hex password 1>@<host>:5432/postgres?sslmode=verify-full
   DATABASE_URL=postgresql://epm_app.<branch>:<hex password 2>@<host>:5432/postgres?sslmode=verify-full
   ```

   ```bash
   pnpm db:bootstrap --existing         # creates epm_owner and epm_app, grants on the postgres database
   pnpm db:migrate                      # applies db/migrations/0001..0013 in order
   ```

   `--existing` grants on the database the admin URL points at instead of creating one. Use port
   5432 (direct), not 6432 (PgBouncer): Hyperdrive pools connections itself. Do not give `epm_app`
   the dashboard's `pg_read_all_data` / `pg_write_all_data` roles: the API must not be able to
   write cells except through `apply_changes`.

3. **Hyperdrive** connects the Worker to Postgres as `epm_app`. Caching must be off: grid reads
   must see the latest committed values, and every request runs in its own transaction.

   ```bash
   cd apps/api
   npx wrangler hyperdrive create nextwelve-db --caching-disabled \
     --connection-string="postgresql://epm_app.<branch>:<hex password 2>@<host>:5432/postgres"
   # copy the id into wrangler.jsonc → hyperdrive[0].id (TLS is on by default)
   ```

4. **R2, secrets, config**

   ```bash
   npx wrangler r2 bucket create nextwelve-files
   openssl rand -base64 48 | npx wrangler secret put SESSION_SECRET
   cd ../.. && pnpm db:job-key && cd apps/api      # prints the key for the nightly job, stores only its hash
   echo '<that key>' | npx wrangler secret put JOB_KEY
   # set GOOGLE_CLIENT_IDS in wrangler.jsonc (add the workers.dev or custom-domain origin to the OAuth client)
   ```

   The public demo is on by default (`DEMO_ENABLED` in `wrangler.jsonc`, with `DEMO_MAX_LIVE`,
   `DEMO_PER_IP_HOUR`, `DEMO_PER_IP_LIVE` and `DEMO_HOURS`). To put Cloudflare Turnstile in front of it,
   create a widget, set `TURNSTILE_SITE_KEY` in `wrangler.jsonc` and
   `npx wrangler secret put TURNSTILE_SECRET`. A site key without its secret switches the demo off
   rather than showing a check nothing verifies.

5. **Deploy, seed and build the demo template**

   ```bash
   pnpm run deploy                                 # `pnpm deploy` is a pnpm built-in
   pnpm seed:sample --admin-email you@gmail.com     # optional; runs locally against the production database
   pnpm demo:template                              # needed for "Try the live demo"
   ```

6. **Custom domain** (for example nextwelve.com). Add the domain to your Cloudflare account,
   uncomment the `routes` entry in `wrangler.jsonc`, run `pnpm run deploy` again, and add
   `https://nextwelve.com` to the OAuth client's authorized JavaScript origins.

**Upgrading:** `pnpm db:migrate` (new migrations only), then `pnpm run deploy`. Run
`pnpm demo:template` again when the sample changes; copies started afterwards use the new template.

For a real tenant instead of the sample: `pnpm provision --name "Acme" --admin-email cfo@acme.com [--domain acme.com]`.
With `--domain`, anyone signing in from that Workspace domain is admitted with no roles; without it
the tenant is invite-only (use this for personal Gmail testing).

### Runtime notes

- Hyperdrive pools connections per transaction and resets session state, so the API sets
  `app.tenant_id` and `app.user_id` with `set_config(..., true)` inside each request's transaction.
- Smart placement runs the Worker near the database; a grid read makes several round trips.
- Uploaded files go to R2 (`FILES`); their catalogue rows, dataset rows and import lines are in Postgres.
  `seed:sample` keeps file bytes in memory, so re-upload a seeded file before re-running its import.
- Snapshots are written to the same bucket under `<tenant>/<app>/snapshots/<id>/`. For production, add an
  R2 bucket lock rule on that prefix so snapshots cannot be deleted early (retention removes nightly ones
  after 30 days / 12 months, so the lock period should be shorter than that, e.g. 7 days).
- The Cron Triggers in `wrangler.jsonc` take the nightly snapshots (07:17 UTC) and remove expired demo
  copies (hourly, rows then files; a tenant stays on a to-do list until its files are gone). Both need
  the `JOB_KEY` secret: listing applications across tenants is refused to the API role without it.
  Locally, put `JOB_KEY=` in `.dev.vars`, run `wrangler dev --test-scheduled` and open `/__scheduled`.
- With an R2 bucket lock on snapshot files, an expired demo copy's snapshot files go once their lock
  period ends; the hourly sweep keeps retrying them.

## Sample company: Fernhollow Foods

Invented for NexTwelve. Fernhollow makes small-batch sauces, spice blends and cold-brew concentrates
in two US kitchens and through a Canadian co-packer, sells to grocery chains, restaurants and its own
online store, and runs a July–June fiscal year.

| Dimension | Members (summary) |
|---|---|
| Scenario | Actual, Budget, Forecast, What-If |
| Version | Working, Final, Upside Case, Downside Case |
| Years | FY26, FY27, FY28 |
| Period | YearTotal → Q1–Q4 → Jul…Jun |
| Entity | Consolidated → US (Portland Kitchen, Savannah Kitchen), Canada (Vancouver Co-Pack) |
| Department | Operations (Production, Quality Assurance, Supply Chain), Commercial (Sales, Marketing, Customer Care), G&A (Finance, People & Culture, Technology), No Department |
| Account | Net Income → Gross Profit, Operating Expenses, Other Income & Expense; Statistics (Cases Sold, Average Price per Case, Headcount) |
| Product | Sauces, Spice Blends, Cold Brew → 8 SKUs, No Product |
| Channel | Grocery (Regional, National), Foodservice, Direct to Consumer (Online Store, Subscription Boxes), No Channel |

Forms: *Revenue Inputs by Product*, *Department Opex*, *Headcount by Department*, *P&L Summary*
(read-only), *Channel Mix* (read-only). Data: FY26 Actuals, an FY27 Budget, and July FY27 actuals
loaded from `gl_actuals_fy27_p01.csv` through the *ERP GL Actuals* import format, which maps GL
accounts, cost centers and item SKUs through the *Fernhollow Crosswalk* dataset.

## Forms

A form places every dimension of its cube exactly once:

```json
{
  "cube": "Plan",
  "folder": "Expenses",
  "definition": {
    "pov":  { "Scenario": "Budget", "Version": "Working", "Years": "FY27", "Product": "No Product", "Channel": "No Channel" },
    "page": { "Entity": ["@leaves(Fernhollow Consolidated)"], "Department": ["@leaves(All Departments)"] },
    "rows": { "dimension": "Account", "members": ["@idescendants(Operating Expenses)"] },
    "columns": { "dimension": "Period", "members": ["@leaves(Q1)", "Q1", "@leaves(Q2)", "Q2"] },
    "instructions": "Enter monthly opex for your department."
  }
}
```

Page lists only offer members the user can read. Member functions: `@children`, `@ichildren`,
`@descendants`, `@idescendants`, `@leaves`.

## Imports and mapping

An **import format** says where each dimension comes from (a column, or a fixed value that a run can
override) and which column holds the amount (`flip_sign`, `scale`). Optional `filters`, `skip_zero`,
`header_row`, `sheet`.

**Mapping rules** translate source values into member names, per dimension, evaluated in order
`explicit` → `dataset` → `between` → `in` → `like`. A target of `*` keeps the source value;
`#skip` drops the line. With no rule, the source value must already be a member name.

A **run** reads an uploaded file or a dataset sheet, maps every line, and sums lines that land on the
same cell. Modes: `merge` (write the cells in the file), `replace` (also clear cells in the same
scenario × version × year × period × entity slices that the file does not mention), `accumulate`
(add to current values). `dry_run` validates only. Any rejected line blocks the load unless
`load_valid_lines` is set. Loads go through `apply_changes` with source `data_load`, so they are
audited, hash-chained and undoable like grid edits. `POST /drill` returns the source lines behind a cell.

## Datasets

`PUT /datasets/:name` with an uploaded file publishes a new version; each sheet becomes a table of
rows keyed by column header. Older versions stay readable, and each import run records the dataset
versions its mapping rules used. Today datasets feed mapping rules (`rule_type: "dataset"`, with
`sheet` and `key_column`) and can be the source of an import. Planned uses: a `lookup()` in the
rules language, reference panels beside forms, member loads, and validations such as spending limits.

## Backup and restore

All of it is for application admins and writes through `apply_changes` with source `restore`, so a
restore is audited, hash-chained and can be undone like any other change. A restore that finds the
data moved under it (another user saved in between) rolls back and runs again, up to three times,
then answers 409. Values are exact: snapshots keep them as decimal text, never as floating point.

**Point-in-time restore of a slice** (`POST …/restore`). A cell's value at a moment is the old value of
its first change after that moment; cells with no later change already hold it. Choose cube, scenario
and version, optionally narrow by members of other dimensions (`filters`, parents mean all their
leaves), and the moment as a time (`at`) or "just before" a change (`before_txn`). The result lands in
place or in another version (`into_version`, created on request with `create_version`; the new
version is added on its own, without deploying anyone's pending metadata edits). `dry_run` reports
cells to set, cells to clear, and cells skipped because their members were deleted since. Up to
100,000 changed cells per restore. Change times are recorded when a change joins the history (in
commit order) and reported to the microsecond, so "as it was at 10:00" is exact.

**Snapshots** (`POST …/snapshots`). One REPEATABLE READ transaction exports the application to R2:
`metadata.json.gz` (dimensions, members, cubes, plan windows, grants, roles, forms, import formats and
mapping rules), `datasets.json.gz` (each dataset's current version) and `facts-NNNN.ndjson.gz` (50,000
cells per file), plus `manifest.json`. The manifest, with a SHA-256 per file, is also kept in Postgres;
a restore refuses files that no longer match it. A scope (`scenarios`, `versions`) limits the data.
The nightly job snapshots every online application that changed since its last nightly snapshot
(data, deployed or saved metadata, forms, imports, datasets, roles, grants, plan windows) and keeps
the newest 30 plus the newest of each month for 12 months. Pre-restore snapshots expire after 90
days; manual ones are kept. Snapshots record the hierarchy as deployed and any saved-but-undeployed
edits separately, so a restored copy rolls up exactly like the source and keeps the pending edits
pending.

**Restore from a snapshot** (`POST …/snapshots/:id/restore`):

| `target` | What happens | Who |
|---|---|---|
| `new_app` | A new application (named "… (restored date)" unless `name` is given) with the snapshot's metadata, forms, imports, datasets and data. By default it gets no application roles or member grants (`access: "none"`), because access removed since the snapshot would otherwise come back; `access: "copy"` re-creates them, lists each in the response and logs it. While it loads, the copy is closed to everyone (423); if the restore fails, the copy is removed. Works even if the source application is gone. | service admin |
| `in_place` | Data only: the chosen scenarios and versions are made to match the snapshot (cells set and cleared). Members are matched by name; cells whose members are gone are skipped and reported. `into_version` puts one version's data into another. A pre-restore snapshot is taken first. Up to 100,000 changed cells per restore. | app admin |

## API

All routes except `/healthz`, `/v1/config` and `/v1/auth/session` need `authorization: Bearer <session_token>`.
Application routes are under `/v1/apps/:app`.

| Method and path | Role | Purpose |
|---|---|---|
| `POST /v1/auth/session` | – | Google ID token → 15-minute session token |
| `GET /v1/me` | any | Current user and roles |
| `GET/POST /v1/users`, `PATCH /v1/users/:email` | service admin | List, invite, disable or re-enable users |
| `POST /v1/groups`, `PUT /v1/groups/:name/members` | service admin | Groups and membership |
| `GET/POST /v1/apps` | any / service admin | List visible apps, create an app |
| `POST …/roles`, `DELETE …/roles/:email` | app admin | Grant or revoke an app role |
| `GET/POST …/dimensions`, `PATCH …/dimensions/:dim` | viewer / app admin | Dimensions (types include `department`) and the `secured` flag |
| `GET/PUT …/dimensions/:dim/members`, `DELETE …/dimensions/:dim/members/:name` | viewer / app admin | Members |
| `POST …/cubes` | app admin | Create a cube (six fixed dimensions; Department and custom ones optional) |
| `POST …/deploy` | app admin | Validate hierarchies, rebuild the closure |
| `GET/PUT …/grants`, `PUT …/plan-windows` | app admin | Member-level grants; open or lock a scenario × version × year |
| `POST …/grid/read`, `POST …/grid/submit` | viewer / planner | Ad hoc grids; 409 lists conflicts |
| `GET …/forms`, `GET/PUT/DELETE …/forms/:name` | viewer / power user | Saved forms |
| `POST …/forms/:name/open` | viewer | Open a form with page selections |
| `GET …/reports`, `GET/PUT/DELETE …/reports/:name` | viewer / power user | Saved reports |
| `POST …/reports/:name/run` | viewer | Run a report (`?format=xlsx\|csv` to download) |
| `GET …/{forms\|reports}/:name/history`, `POST …/history/restore` | power user | Saved versions of a definition; bring one back |
| `GET …/definitions/export`, `POST …/definitions/import` | power user | Forms and reports as Excel or CSV; `?dry_run=true` checks only |
| `POST/GET …/files` | power user | Upload a file (raw body, `?name=&purpose=import\|dataset`), list uploads |
| `GET …/datasets`, `GET/PUT …/datasets/:name` | viewer / power user | Dataset versions; publish a version |
| `GET …/datasets/:name/rows` | viewer | Rows (`?sheet=&version=&limit=&offset=&where.<column>=`) |
| `GET …/import-formats`, `GET/PUT …/import-formats/:name` | power user | Import formats |
| `GET/PUT …/import-formats/:name/mappings` | power user | Mapping rules |
| `POST …/import-formats/:name/run` | power user | Validate or load a file or dataset |
| `GET …/imports`, `GET …/imports/:run/lines` | power user | Runs and their lines (with errors) |
| `POST …/drill` | viewer | Source lines behind a cell |
| `POST …/history`, `GET …/txns` | viewer | Cell history; recent transactions |
| `POST …/txns/:txn/undo` | author or app admin | Undo a transaction |
| `POST …/audit/verify` | app admin | Re-walk the hash chain |
| `POST …/restore` | app admin | Point-in-time restore of a slice (preview with `dry_run`) |
| `GET/POST …/snapshots`, `GET …/snapshots/:id` | app admin | List, take and inspect snapshots |
| `GET …/snapshots/:id/files/:file` | app admin | Download a snapshot file (logged) |
| `POST …/snapshots/:id/restore` | app admin / service admin | Restore in place or into a new application |
| `GET …/metadata/history`, `POST …/metadata/restore` | app admin | Metadata history; restore members, hierarchies and definitions to a moment or a snapshot (preview with `dry_run`) |
| `POST /v1/devices/links`, `GET …/links/:id`, `POST …/links/:id/approve\|deny` | any (not a phone) | Show a QR code for a phone; approve it with the number the phone shows |
| `GET /v1/devices`, `DELETE /v1/devices/:id` | any | Phones connected as you; disconnect one |
| `POST /v1/devices/claim`, `POST /v1/devices/claim/poll` | public (the code is the credential) | The phone claims a code, then collects its read-only session once approved |
| `GET/DELETE /v1/devices/current` | phone | The phone's own link; disconnect |
| `GET /v1/demo`, `POST/DELETE /v1/demo/session`, `POST /v1/demo/persona` | public / demo | Start, end or switch people in a demo copy |

## Security model

| Layer | Where it is enforced |
|---|---|
| Identity | Google ID token (signature, issuer, audience, expiry). Users match on `sub`; invites bind by verified email; `hd` admits a tenant's domain. |
| Tenant isolation | RLS on every tenant table, `FORCE`d so owner-run functions are bound too. The API connects as `epm_app` (no `BYPASSRLS`, owns nothing). |
| Roles | `service_admin` (tenant); `app_admin`, `power_user`, `planner`, `viewer` (per application). Checked in the API and again inside the database functions. |
| Member-level access | Grants on secured dimensions expand into `effective_access`. Closest grant wins; a user grant beats group grants at equal distance; `none` denies. |
| Writes | `epm_app` cannot write facts, audit, closure or resolved access. Every write goes through `epm.apply_changes()`, which re-checks role, coordinates, write access and plan windows. |
| Phones | A one-time QR code (two minutes), approved on the computer by typing the number the phone shows. The phone's session (`ro` claim) may call only read routes, runs in READ ONLY transactions, and is checked against its device link on every request, so revoking it from either side ends access at once. Eight hours at most. |
| Audit | One `cell_audit` row per changed cell (old and new value; the transaction records its source: grid submit, data load, undo, …); one `change_txn` per transaction in a SHA-256 hash chain. |

## Tests

```bash
docker compose up -d && pnpm install
cd apps/api && npx vitest run test/grid.test.ts     # one suite; `pnpm test` runs all
```

Each suite creates and drops its own database through `NX_TEST_SUPERUSER_URL` (local Postgres only).
Google sign-in uses a local signing key in place of Google's, so the real verifier code runs.

| Suite | Covers |
|---|---|
| `rls` | RLS on every tenant table (forms, files, datasets, imports, snapshots included), cross-tenant reads and writes, no direct write privileges |
| `auth` | Invites, `sub` matching, domain admission, unverified email, bad tokens, tampered sessions, disabled users |
| `grid` | Rollups, writable cells, conflicts and override, clears, history, undo, stale grids, tamper detection |
| `security` | Grant precedence, explicit deny, write checks inside `apply_changes`, plan windows, admin-only operations |
| `metadata` | Hierarchy order, fixed and optional dimensions (Department), custom slots, deploy validation |
| `concurrency` | Racing writers on new and existing cells; hash chain under parallel submits |
| `forms` | Form validation, page lists filtered by access, read-only forms, submit through a form |
| `imports` | Mapping rule types and `#skip`, rejects and dry runs, merge / replace / accumulate, XLSX sheets, dataset sources, drill-back, undo of a load |
| `datasets` | CSV and XLSX readers, dataset versions, row queries, roles, tenant isolation |
| `sample` | Builds Fernhollow, opens every form, imports July actuals through the crosswalk, checks the P&L and a drill-back |
| `restore` | Point-in-time restore: previews, member filters, in place and undo, into a new version, deleted members, roles, the restoring lock |
| `snapshots` | Snapshot files and checksums, scopes, in-place and cross-version restore, new-application restore, tampered and missing files, nightly job, retention |
| `sample-backup` | About 22,500 Fernhollow cells: snapshot, restore into a new application with matching P&Ls, and a restore to before the July load |
| `reports`, `definitions` | Report suppression, scaling and rounding, Excel and CSV output; definition export, import, checks and history |
| `metadata-restore` | Metadata restore to a moment or a snapshot: deleted members back, members with data kept, previews |
| `demo` | Demo template, start, personas, guard rails, limits, start over and cleanup |
| `devices` | Phone pairing: one-time codes, number match, expiry, read-only routes, read-only transactions, revocation, member-level security |
| `adversarial/` | 57 suites from six rounds of adversarial testing: backup and restore, metadata restore, definitions, reports and the public demo. Authorization and tenant isolation, injection, tampered and corrupt files, exact values, races, time boundaries, partial failures, abuse of limits, cleanup under failure, and the browser screens in headless Chromium (skipped when Playwright is not installed; `NX_PLAYWRIGHT` points at it) |

## Design notes

- **Coordinates** are `int[16]`: `[cube, scenario, version, years, period, entity, account, department, c1..c8]`;
  unused slots are 0. Department is optional per cube.
- **Closure table** `member_ancestor` holds every ancestor–descendant pair; rollups use `descendant_is_leaf`.
- **Hash chain order** follows `chain_seq`, assigned under a per-application advisory lock, so the chain matches commit order.
- **Undo and point-in-time restore** rely on `old_value` in `cell_audit`; nothing in the audit trail is updated.

## Not built yet

See [the roadmap](apps/api/public/roadmap.html) (served at `/roadmap`) for the order. In short:

- The Google Sheets add-on (sidebar, refresh, submit, cell history) on top of the same API.
- Spreading, cell comments and supporting detail; time balance in period rollups.
- Member formulas, the rules language and its dataset `lookup()`; allocations; currencies and eliminations.
- Approvals workflow; single sign-on beyond Google; scheduled ERP connectors; an Excel add-in.
- Running large snapshots and restores as Queue jobs instead of inside the request or the cron run.
- Archiving cell audit beyond an online window (point-in-time restore reaches back as far as the audit does).
- Anchoring the chain head outside the database (to detect deletion of the newest transactions).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
