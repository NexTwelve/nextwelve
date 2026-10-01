/**
 * Build the Fernhollow Foods sample tenant and sign in to it with your own Google account:
 *
 *   pnpm seed:sample --admin-email you@gmail.com
 *
 * Provisions "Fernhollow Foods (sample)", builds the model from samples/fernhollow/model.json
 * through the real API (in-process, as a synthetic seed user), loads FY26 Actuals and an FY27
 * Budget, publishes the GL crosswalk workbook as a dataset and imports July FY27 actuals through
 * it, invites your email as service admin and app admin, then disables the seed user.
 * Uses DATABASE_URL (epm_app, direct, not Hyperdrive) and MIGRATION_DATABASE_URL (epm_owner).
 */
import { randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { createApp } from '../src/app.js';
import { createGoogleVerifier } from '../src/auth/google.js';
import { createSessionSigner } from '../src/auth/session.js';
import { poolDatabase } from '../src/db.js';
import { memoryBlobStore } from '../src/files/blobs.js';
// Note: file bytes go to an in-memory store here, so they are not in R2 afterwards; the dataset
// rows, import runs and drill-back lines are in Postgres. Re-upload a file to run it again.
import { buildSampleApp, type Call, loadSampleImports, loadSampleModel, seedFernhollowData, type Upload } from './sample.js';

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const adminEmail = flag('admin-email')?.toLowerCase();
const withData = !process.argv.includes('--no-data');
const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminEmail || !ownerUrl || !appUrl) {
  console.error('usage: DATABASE_URL=... MIGRATION_DATABASE_URL=... seed:sample --admin-email <your google email> [--no-data]');
  process.exit(2);
}

const model = loadSampleModel('fernhollow');
const SEED = 'seed@nextwelve.invalid';
const AUD = 'nextwelve-seed';

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
const tenantId = (
  await owner.query<{ id: string }>('select epm.provision_tenant($1, null, $2) as id', [`${model.company} (sample)`, SEED])
).rows[0]!.id;

// Drive the real API in-process; only the seed user's sign-in uses a local signing key.
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'seed', alg: 'RS256' };
const pool = new pg.Pool({ connectionString: appUrl, max: 4 });
const app = createApp({
  db: poolDatabase(pool),
  blobs: memoryBlobStore(),
  signer: createSessionSigner(randomBytes(32), 3600),
  verifier: createGoogleVerifier({ audiences: [AUD], keys: createLocalJWKSet({ keys: [jwk] }) }),
});

let token: string | null = null;
const call: Call = async (method, url, body) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await app.request(encodeURI(url), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`${method} ${url} -> ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
};

const upload: Upload = async (appBase, name, data, purpose) => {
  const res = await app.request(`${appBase}/files?name=${encodeURIComponent(name)}&purpose=${purpose}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    body: data,
  });
  if (res.status !== 201) throw new Error(`upload ${name} -> ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ file_id: string }>;
};

const idToken = await new SignJWT({ email: SEED, email_verified: true })
  .setProtectedHeader({ alg: 'RS256', kid: 'seed' })
  .setSubject(`seed-${tenantId}`)
  .setIssuer('https://accounts.google.com')
  .setAudience(AUD)
  .setIssuedAt()
  .setExpirationTime('5m')
  .sign(privateKey);
token = (await call('POST', '/v1/auth/session', { id_token: idToken })).session_token;

const started = Date.now();
const appId = await buildSampleApp(call, model);
const stats = withData ? await seedFernhollowData(call, appId) : { submits: 0, cells: 0 };
const runs = withData ? await loadSampleImports(call, upload, appId, model) : [];
for (const r of runs) console.log(`import ${r.status}: ${r.lines_mapped} of ${r.lines_read} lines mapped, ${r.cells} cells (${r.mode})`);

// Invite the real admin, then retire the seed user.
await owner.query('begin');
await owner.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
const u = await owner.query<{ user_id: string }>(
  "insert into epm.app_user (tenant_id, email, status) values ($1, $2, 'invited') returning user_id",
  [tenantId, adminEmail],
);
await owner.query(
  "insert into epm.user_role (tenant_id, user_id, app_id, role) values ($1, $2, null, 'service_admin'), ($1, $2, $3, 'app_admin')",
  [tenantId, u.rows[0]!.user_id, appId],
);
await owner.query("update epm.app_user set status = 'disabled' where email = $1", [SEED]);
await owner.query('commit');

await pool.end();
await owner.end();
console.log(
  `${model.company} sample ready: "${model.application}" (${appId}). ` +
    `${stats.cells} cells in ${stats.submits} submits, ${((Date.now() - started) / 1000).toFixed(1)}s. ` +
    `${adminEmail} is invited as service admin.`,
);
