/**
 * Create a tenant and invite its first service admin. Runs as epm_owner.
 *
 *   pnpm provision --name "Acme" --admin-email cfo@acme.com [--domain acme.com]
 *
 * --domain lets anyone signing in with that Google Workspace domain in (with no roles until
 * granted). Leave it out for invite-only tenants, including personal Gmail testing.
 */
import pg from 'pg';
import { pgUrl } from '../../../packages/db/src/index.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const url = process.env.MIGRATION_DATABASE_URL;
const name = arg('name');
const adminEmail = arg('admin-email');
const domain = arg('domain') ?? null;
if (!url || !name || !adminEmail) {
  console.error('usage: MIGRATION_DATABASE_URL=... provision --name <tenant> --admin-email <email> [--domain <workspace domain>]');
  process.exit(2);
}

const client = new pg.Client({ connectionString: pgUrl(url) });
await client.connect();
try {
  const res = await client.query<{ id: string }>('select epm.provision_tenant($1, $2, $3) as id', [name, domain, adminEmail]);
  console.log(`tenant ${name} created (${res.rows[0]!.id}); ${adminEmail} is invited as service admin`);
} finally {
  await client.end();
}
