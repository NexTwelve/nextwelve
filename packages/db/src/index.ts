import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));

/** Repository db/ folder (works from src/ under tsx and from dist/ after build). */
export const dbDir = resolve(here, '..', '..', '..', 'db');
export const migrationsDir = join(dbDir, 'migrations');
export const bootstrapDir = join(dbDir, 'bootstrap');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface RolePasswords {
  owner?: string;
  app?: string;
}

/**
 * Connection strings as node-postgres needs them. libpq's `sslrootcert=system`, which PlanetScale's
 * dashboard puts in the strings it gives you, means "use the system CA store"; node-postgres would
 * try to open a file called "system". Dropping it keeps `sslmode=verify-full`: Node then verifies
 * the server certificate against its own CA bundle.
 */
export function pgUrl(url: string): string {
  return url.replace(/([?&])sslrootcert=system(&|$)/i, (_m, pre: string, post: string) => (post ? pre : '')).replace(/[?&]$/, '');
}

/**
 * Create the epm_owner and epm_app roles; safe to repeat. Needs a role with CREATEROLE:
 * a local superuser, or PlanetScale's default "postgres" role. Passwords are set when given
 * (managed databases need them; local trust auth does not).
 */
export async function bootstrapRoles(adminUrl: string, passwords: RolePasswords = {}): Promise<void> {
  const client = new pg.Client({ connectionString: pgUrl(adminUrl) });
  await client.connect();
  try {
    await client.query(readFileSync(join(bootstrapDir, 'roles.sql'), 'utf8'));
    for (const [role, password] of [['epm_owner', passwords.owner], ['epm_app', passwords.app]] as const) {
      if (password) await client.query(`alter role ${role} password ${client.escapeLiteral(password)}`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Managed Postgres (PlanetScale): the database already exists and belongs to the provider's
 * admin role. Let epm_owner create the schema in it and epm_app connect to it.
 */
export async function grantOnExistingDatabase(adminUrl: string): Promise<string> {
  const client = new pg.Client({ connectionString: pgUrl(adminUrl) });
  await client.connect();
  try {
    const name = (await client.query<{ db: string }>('select current_database() as db')).rows[0]!.db;
    const db = client.escapeIdentifier(name);
    await client.query(`grant connect, create, temporary on database ${db} to epm_owner`);
    await client.query(`grant connect, temporary on database ${db} to epm_app`);
    return name;
  } finally {
    await client.end();
  }
}

/** Create a database owned by epm_owner. Run as a superuser. */
export async function createDatabase(superUrl: string, name: string): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid database name: ${name}`);
  const client = new pg.Client({ connectionString: pgUrl(superUrl) });
  await client.connect();
  try {
    await client.query(`create database ${name} owner epm_owner`);
    await client.query(`revoke all on database ${name} from public`);
    await client.query(`grant connect, temporary on database ${name} to epm_app`);
  } finally {
    await client.end();
  }
}

/** Apply pending migrations in file-name order, each in its own transaction. Run as epm_owner. */
export async function migrate(ownerUrl: string, dir: string = migrationsDir): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: pgUrl(ownerUrl) });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    // Kept in the epm schema: on managed Postgres epm_owner may not create objects in public.
    await client.query(`
      create schema if not exists epm;
      create table if not exists epm.schema_migrations (
        version    text primary key,
        applied_at timestamptz not null default now()
      )`);
    const done = new Set(
      (await client.query<{ version: string }>('select version from epm.schema_migrations')).rows.map((r) => r.version),
    );
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const sql = readFileSync(join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into epm.schema_migrations (version) values ($1)', [file]);
        await client.query('commit');
        result.applied.push(file);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }
  } finally {
    await client.end();
  }
  return result;
}

/**
 * Create (or replace) the key the scheduled Worker uses to list applications for the nightly
 * snapshots. Run as epm_owner; only a hash is stored. Returns the key to save as the JOB_KEY secret.
 */
export async function setJobKey(ownerUrl: string, key?: string): Promise<string> {
  const value = key ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  if (value.length < 32) throw new Error('a job key needs at least 32 characters');
  const client = new pg.Client({ connectionString: pgUrl(ownerUrl) });
  await client.connect();
  try {
    await client.query('select epm.set_job_key($1)', [value]);
  } finally {
    await client.end();
  }
  return value;
}
