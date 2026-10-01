/**
 * Build the template every public demo copy is loaded from:
 *
 *   pnpm demo:template
 *
 * Builds the Fernhollow Foods sample (with its data, the July actuals import, forms and reports) in
 * a throwaway tenant through the real API, adds the demo's planner and viewer with their access,
 * takes a snapshot, stores the snapshot's files in epm.demo_template, and removes the throwaway
 * tenant. Run it again after changing the sample; copies made afterwards use the new template.
 * Uses DATABASE_URL (epm_app) and MIGRATION_DATABASE_URL (epm_owner), like seed:sample.
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import pg from 'pg';
import { pgUrl } from '../../../packages/db/src/index.js';
import { createApp } from '../src/app.js';
import { createGoogleVerifier } from '../src/auth/google.js';
import { createSessionSigner } from '../src/auth/session.js';
import { createSnapshot } from '../src/backup/snapshots.js';
import { poolDatabase } from '../src/db.js';
import { DEMO_PERSONAS, storeTemplate } from '../src/demo.js';
import { memoryBlobStore } from '../src/files/blobs.js';
import { buildSampleApp, type Call, loadSampleImports, loadSampleModel, seedFernhollowData, type Upload } from './sample.js';

const AUD = 'nextwelve-demo-template';

export async function buildDemoTemplate(ownerUrl: string, appUrl: string, log: (msg: string) => void = () => undefined): Promise<{ snapshotId: string; facts: number }> {
  const model = loadSampleModel('fernhollow');
  const [admin, planner, viewer] = DEMO_PERSONAS as [typeof DEMO_PERSONAS[number], typeof DEMO_PERSONAS[number], typeof DEMO_PERSONAS[number]];
  const owner = new pg.Client({ connectionString: pgUrl(ownerUrl) });
  await owner.connect();
  const pool = new pg.Pool({ connectionString: pgUrl(appUrl), max: 4 });
  // A throwaway tenant, marked as a demo so purge_tenant may remove it.
  const tenantId = (await owner.query<{ id: string }>('select epm.provision_tenant($1, null, $2) as id', ['NexTwelve demo template (building)', admin.email])).rows[0]!.id;
  await owner.query("update epm.tenant set demo_expires_at = now() + interval '2 hours' where tenant_id = $1", [tenantId]);
  try {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'tpl', alg: 'RS256' };
    const blobs = memoryBlobStore();
    const app = createApp({
      db: poolDatabase(pool),
      blobs,
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
    const idToken = await new SignJWT({ email: admin.email, email_verified: true })
      .setProtectedHeader({ alg: 'RS256', kid: 'tpl' })
      .setSubject(`tpl-${tenantId}`)
      .setIssuer('https://accounts.google.com')
      .setAudience(AUD)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);
    const session = await call('POST', '/v1/auth/session', { id_token: idToken });
    token = session.session_token;

    log('building the sample application');
    const appId = await buildSampleApp(call, model);
    const stats = await seedFernhollowData(call, appId);
    await loadSampleImports(call, upload, appId, model);
    log(`sample built: ${stats.cells} cells`);

    // The demo's other people: a planner for Fernhollow Canada and a viewer of everything.
    const base = `/v1/apps/${appId}`;
    for (const [p, role] of [[planner, 'planner'], [viewer, 'viewer']] as const) {
      await call('POST', '/v1/users', { email: p.email, display_name: p.display_name });
      await call('POST', `${base}/roles`, { email: p.email, role });
    }
    await call('PUT', `${base}/grants`, {
      grants: [
        { principal: { user: planner.email }, dimension: 'Entity', member: 'Fernhollow Canada', scope: 'idescendants', access: 'write' },
        { principal: { user: planner.email }, dimension: 'Department', member: 'All Departments', scope: 'idescendants', access: 'write' },
        { principal: { user: viewer.email }, dimension: 'Entity', member: 'Fernhollow Consolidated', scope: 'idescendants', access: 'read' },
        { principal: { user: viewer.email }, dimension: 'Department', member: 'All Departments', scope: 'idescendants', access: 'read' },
      ],
    });

    const snap = await createSnapshot({ db: poolDatabase(pool), blobs }, { userId: session.user_id, tenantId }, appId, { kind: 'manual', comment: 'demo template' });
    await storeTemplate(owner, blobs, snap);
    log(`template stored: snapshot ${snap.snapshot_id}, ${snap.fact_count} cells, ${snap.manifest!.files.length} files`);
    return { snapshotId: snap.snapshot_id, facts: snap.fact_count ?? 0 };
  } finally {
    await owner.query('select epm.purge_tenant($1)', [tenantId]).catch((err) => log(`could not remove the build tenant: ${(err as Error).message}`));
    await pool.end();
    await owner.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) {
    console.error('usage: DATABASE_URL=... MIGRATION_DATABASE_URL=... demo:template');
    process.exit(2);
  }
  const started = Date.now();
  const r = await buildDemoTemplate(ownerUrl, appUrl, (m) => console.log(m));
  console.log(`demo template ready (${r.facts} cells) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
