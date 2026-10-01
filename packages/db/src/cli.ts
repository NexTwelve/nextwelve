import { bootstrapRoles, createDatabase, grantOnExistingDatabase, migrate, setJobKey } from './index.js';

const [command, ...args] = process.argv.slice(2);

function need(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set`);
    process.exit(2);
  }
  return value;
}

const passwords = { owner: process.env.EPM_OWNER_PASSWORD, app: process.env.EPM_APP_PASSWORD };

if (command === 'bootstrap') {
  const adminUrl = need('ADMIN_DATABASE_URL');
  await bootstrapRoles(adminUrl, passwords);
  if (args.includes('--existing')) {
    // Managed Postgres: grant on the database ADMIN_DATABASE_URL points at.
    const name = await grantOnExistingDatabase(adminUrl);
    console.log(`roles ready; epm_owner and epm_app granted on existing database ${name}`);
  } else {
    // Local: create the database (default name "nextwelve") owned by epm_owner.
    const name = args.find((a) => !a.startsWith('--')) ?? 'nextwelve';
    try {
      await createDatabase(adminUrl, name);
      console.log(`roles ready; created database ${name}`);
    } catch (err) {
      if (/already exists/.test((err as Error).message)) console.log(`roles ready; database ${name} already exists`);
      else throw err;
    }
  }
} else if (command === 'migrate') {
  const result = await migrate(need('MIGRATION_DATABASE_URL'));
  console.log(`applied: ${result.applied.join(', ') || 'none'}; already applied: ${result.skipped.length}`);
} else if (command === 'job-key') {
  const key = await setJobKey(need('MIGRATION_DATABASE_URL'));
  console.log('job key stored (as a hash). Give the Worker the key itself:');
  console.log(`  echo '${key}' | npx wrangler secret put JOB_KEY      # local dev: JOB_KEY=${key} in apps/api/.dev.vars`);
} else {
  console.error('usage: cli.ts bootstrap [dbname | --existing] | migrate | job-key');
  process.exit(2);
}
