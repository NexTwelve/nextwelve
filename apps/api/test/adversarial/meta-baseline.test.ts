import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapRoles, createDatabase, migrate, migrationsDir } from '../../../../packages/db/src/index.js';
import { createApp } from '../../src/app.js';
import { createGoogleVerifier } from '../../src/auth/google.js';
import { createSessionSigner } from '../../src/auth/session.js';
import { poolDatabase } from '../../src/db.js';
import { memoryBlobStore } from '../../src/files/blobs.js';
import { Api, expectOk, FakeGoogle, type Harness, provisionTenant, seedPlanApp, signIn, SUPER_URL, TEST_CLIENT_ID, type TestDb } from '../helpers.js';
import { asUser } from './abuse-helpers.js';
import { byDim } from './meta-helpers.js';

function urlFor(base: string, user: string, db: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = '';
  u.pathname = `/${db}`;
  return u.toString();
}

/**
 * Applications that already existed when 0009 was applied: their history is a baseline taken by the
 * migration (deployed parents and aggregation from the closure, form definitions as they were).
 * The database is migrated to 0008, the applications are built (with saved-but-undeployed edits in
 * some), and only then is 0009 applied.
 */
describe('adversarial: the metadata history baseline of applications that existed before 0009', () => {
  let db: TestDb;
  let h: Harness;
  let su: pg.Client;
  let admin: Api;
  let tenantId: string;
  const apps: Record<'clean' | 'moved' | 'deleted', { id: string; base: string }> = {} as never;

  const now = async () => (await su.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`)).rows[0]!.t;
  const restore = (k: keyof typeof apps, body: Record<string, unknown>) => admin.post(`${apps[k].base}/metadata/restore`, body);

  beforeAll(async () => {
    const name = `nx_t_${randomBytes(6).toString('hex')}`;
    await bootstrapRoles(SUPER_URL);
    await createDatabase(SUPER_URL, name);
    const ownerUrl = urlFor(SUPER_URL, 'epm_owner', name);
    db = {
      name, jobKey: '', ownerUrl, appUrl: urlFor(SUPER_URL, 'epm_app', name), superUrl: urlFor(SUPER_URL, 'postgres', name),
      async drop() {
        const c = new pg.Client({ connectionString: SUPER_URL });
        await c.connect();
        await c.query(`drop database if exists ${name} with (force)`);
        await c.end();
      },
    };
    // Migrations up to 0008 only, recorded as migrate() records them.
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    await owner.query(`create schema if not exists epm;
      create table if not exists epm.schema_migrations (version text primary key, applied_at timestamptz not null default now())`);
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql') && x < '0009').sort()) {
      await owner.query('begin');
      await owner.query(readFileSync(join(migrationsDir, f), 'utf8'));
      await owner.query('insert into epm.schema_migrations (version) values ($1)', [f]);
      await owner.query('commit');
    }
    await owner.end();

    const pool = new pg.Pool({ connectionString: db.appUrl, max: 6 });
    pool.on('error', () => undefined);
    const google = await FakeGoogle.create();
    const blobs = memoryBlobStore();
    const app = createApp({
      db: poolDatabase(pool), blobs, signer: createSessionSigner(randomBytes(32), 900),
      verifier: createGoogleVerifier({ audiences: [TEST_CLIENT_ID], keys: google.keys() }),
    });
    h = { db, pool, app, google, blobs, async close() { await pool.end(); await db.drop(); } };
    tenantId = await provisionTenant(db, 'Baseline Co', null, 'admin@base.test');
    admin = await signIn(h, 'admin@base.test');
    su = new pg.Client({ connectionString: db.superUrl });
    await su.connect();

    for (const k of ['clean', 'moved', 'deleted'] as const) {
      const id = await seedPlanApp(admin, `Baseline ${k}`);
      apps[k] = { id, base: `/v1/apps/${id}` };
    }
    expectOk(await admin.put(`${apps.clean.base}/forms/Entry`, {
      cube: 'Plan',
      definition: { pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } },
    }));
    // Saved, not deployed, when 0009 arrives: a move in one application, a deletion in another.
    expectOk(await admin.put(`${apps.moved.base}/dimensions/Account/members`, { members: [{ name: 'COGS', parent: 'Net Income' }] }));
    expectOk(await admin.del(`${apps.deleted.base}/dimensions/Product/members/Gadgets`));

    const done = await migrate(ownerUrl);
    expect(done.applied[0]).toBe('0009_metadata_history.sql');
  }, 30_000);
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  it('records the deployed tree as the baseline: no undeployed edits are invented in a clean application', async () => {
    const r = await restore('clean', { at: await now(), dimensions: ['Account'], dry_run: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changes).toBe(0);
    const mismatch = await su.query(
      `select m.name from epm.member m join epm.dimension d on d.dim_id = m.dim_id
         left join epm.member_version v on v.member_id = m.member_id and v.to_rev is null
        where d.app_id = $1 and (v.member_id is null or v.parent_id is distinct from m.parent_id or v.agg_op <> m.agg_op)`,
      [apps.clean.id],
    );
    expect(mismatch.rows).toEqual([]);
  });

  it('sees a move saved but not deployed at the migration (deployed parent from the closure)', async () => {
    const out = await restore('moved', { at: await now(), dimensions: ['Product'], dry_run: true });
    expect(out.status).toBe(409);
    expect(out.body.message).toMatch(/Account has saved changes that are not deployed/);
    const inScope = expectOk(await restore('moved', { at: await now(), dimensions: ['Account'], definitions: false, dry_run: true }));
    expect(byDim(inScope).Account).toMatchObject({ changed: [{ name: 'COGS', fields: ['parent'] }], pending_discarded: 1 });
  });

  it('brings form definitions back to how the migration found them', async () => {
    const t = await now();
    expectOk(await admin.del(`${apps.clean.base}/forms/Entry`));
    const r = expectOk(await restore('clean', { at: t, members: false }));
    expect(r.definitions.created).toEqual([{ type: 'form', name: 'Entry' }]);
    expect(expectOk(await admin.get(`${apps.clean.base}/forms/Entry`)).definition.columns).toEqual([{ dimension: 'Period', members: ['Jan'] }]);
  });

  it('FINDING: the moment history starts (history_from, as GET /metadata/history reports it) cannot be restored to: "nothing had been deployed"', async () => {
    const hist = expectOk(await admin.get(`${apps.clean.base}/metadata/history`));
    expect(hist.deploys).toHaveLength(1);
    // The baseline revision counts from the moment history starts.
    expect(hist.deploys[0].deployed_at <= hist.history_from).toBe(true);
    const members = await restore('clean', { at: hist.history_from, dry_run: true });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    // Not even the definitions, which the baseline holds at exactly history_from.
    const defs = await restore('clean', { at: hist.history_from, members: false, dry_run: true });
    expect(defs.status, JSON.stringify(defs.body)).toBe(200);
  });

  it('FINDING: a deletion saved but not deployed at the migration is invisible to the undeployed-edits check, so a restore of another dimension publishes it', async () => {
    const t = await now();
    const versionDim = (await su.query<{ dim_id: number }>(`select dim_id from epm.dimension where app_id = $1 and name = 'Version'`, [apps.deleted.id])).rows[0]!.dim_id;
    // A version added on its own (no full deploy): Gadgets' deletion is still only saved.
    await asUser(h.pool, tenantId, 'admin@base.test', (c) => c.query('select epm.add_version_leaf($1, $2)', [versionDim, 'V9']));
    const gadgetsInClosure = async () =>
      (await su.query(
        `select 1 from epm.member_ancestor ma join epm.dimension d on d.dim_id = ma.dim_id
          where d.app_id = $1 and d.name = 'Product' and ma.depth = 0
            and not exists (select 1 from epm.member m where m.member_id = ma.descendant_id)`,
        [apps.deleted.id],
      )).rowCount;
    expect(await gadgetsInClosure()).toBe(1);

    const r = await restore('deleted', { at: t, dimensions: ['Version'], definitions: false });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(r.body.message).toMatch(/Product has saved changes that are not deployed/);
    expect(await gadgetsInClosure()).toBe(1);
  });
});
