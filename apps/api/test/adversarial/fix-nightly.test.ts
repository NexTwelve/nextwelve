import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setJobKey } from '../../../../packages/db/src/index.js';
import { runNightlySnapshots } from '../../src/backup/snapshots.js';
import { poolDatabase } from '../../src/db.js';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

/**
 * Second pass on the nightly job: snapshot_targets now needs the job key whose SHA-256 is kept in
 * the owner-only epm.job_credential; the job marks stale 'running' snapshots failed and skips
 * applications whose (high_chain_seq, content_hash) did not change.
 */
describe('fix: the nightly job and its key', () => {
  let h: Harness;
  let su: pg.Client;
  let admin: Api;
  let appId: string;
  let base: string;
  const deps = () => ({ db: poolDatabase(h.pool), blobs: h.blobs });
  /** Call snapshot_targets as the API role with no tenant in the session; the error code and message, or the row count. */
  async function targets(key: unknown): Promise<string> {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      const r = await c.query('select * from epm.snapshot_targets($1)', [key]);
      return `rows:${r.rowCount}`;
    } catch (e: any) {
      return `${e.code} ${e.message}`;
    } finally {
      await c.query('rollback').catch(() => undefined);
      c.release();
    }
  }
  async function asApi(sql: string): Promise<string> {
    const c = await h.pool.connect();
    try {
      await c.query(sql);
      return 'ok';
    } catch (e: any) {
      return e.code;
    } finally {
      c.release();
    }
  }

  beforeAll(async () => {
    h = await createHarness();
    su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    await provisionTenant(h.db, 'Night Co', null, 'admin@nc.test');
    await provisionTenant(h.db, 'Secret Tenant Name', null, 'admin@secret.test');
    admin = await signIn(h, 'admin@nc.test');
    appId = await seedPlanApp(admin, 'Night Plan');
    base = `/v1/apps/${appId}`;
  });
  afterAll(async () => {
    await su?.end();
    await h?.close();
  });

  it('lists targets only with the exact key; every wrong key gets the same answer, naming no tenant', async () => {
    expect(await targets(h.db.jobKey)).toMatch(/^rows:\d+$/);
    const wrong = await Promise.all([null, '', 'x'.repeat(31), h.db.jobKey.slice(0, -1), `${h.db.jobKey} `, h.db.jobKey.toUpperCase(), 'y'.repeat(10_000)].map(targets));
    expect(new Set(wrong)).toEqual(new Set(['NX403 a valid job key is required']));
    expect(wrong.join(' ')).not.toMatch(/Secret|Night/);
  });

  it('the API role can neither read the key hash nor set a key', async () => {
    expect({
      read: await asApi('select key_hash from epm.job_credential'),
      set: await asApi("select epm.set_job_key('" + 'z'.repeat(40) + "')"),
      write: await asApi("update epm.job_credential set key_hash = sha256('a'::bytea)"),
    }).toEqual({ read: '42501', set: '42501', write: '42501' });
  });

  it('a run with a wrong key takes no snapshots and records nothing', async () => {
    const before = Number((await su.query('select count(*)::int as n from epm.snapshot')).rows[0].n);
    await expect(runNightlySnapshots(deps(), { jobKey: 'w'.repeat(43) })).rejects.toMatchObject({ code: 'NX403' });
    expect(Number((await su.query('select count(*)::int as n from epm.snapshot')).rows[0].n)).toBe(before);
  });

  it('after rotation only the new key works, and an unchanged application is skipped by the next run', async () => {
    const r1 = await runNightlySnapshots(deps(), { jobKey: h.db.jobKey });
    expect(r1.find((r) => r.app_id === appId)?.status).toBe('taken');
    const newKey = await setJobKey(h.db.ownerUrl);
    await expect(runNightlySnapshots(deps(), { jobKey: h.db.jobKey })).rejects.toMatchObject({ code: 'NX403' });
    const r2 = await runNightlySnapshots(deps(), { jobKey: newKey });
    expect(r2.find((r) => r.app_id === appId)?.status).toBe('unchanged');
    h.db.jobKey = newKey;
  });

  it('FINDING: a stale "running" snapshot that is marked failed has its partial files removed from storage', async () => {
    // A run that died mid-export seven hours ago: the row says running, some files made it to storage.
    const id = (await su.query<{ id: string }>('select gen_random_uuid() as id')).rows[0]!.id;
    const tenant = (await su.query('select tenant_id from epm.application where app_id = $1', [appId])).rows[0].tenant_id;
    const prefix = `${tenant}/${appId}/snapshots/${id}`;
    await su.query(
      `insert into epm.snapshot (snapshot_id, tenant_id, app_id, app_name, kind, schema_ver, storage_prefix, status, created_at)
       values ($1, $2, $3, 'Night Plan', 'nightly', 2, $4, 'running', now() - interval '7 hours')`,
      [id, tenant, appId, prefix],
    );
    for (const f of ['metadata.json.gz', 'datasets.json.gz', 'facts-0001.ndjson.gz']) await h.blobs.put(`${prefix}/${f}`, new Uint8Array([1, 2, 3]), 'application/gzip');
    // Something changed, so the run also takes a fresh snapshot.
    expectOk(await admin.put(`${base}/plan-windows`, { scenario: 'Budget', version: 'Working', years: 'FY27', locked: true }));
    const r = await runNightlySnapshots(deps(), { jobKey: h.db.jobKey });
    expect(r.find((x) => x.app_id === appId)?.status).toBe('taken');
    expect((await su.query('select status, error from epm.snapshot where snapshot_id = $1', [id])).rows[0]).toEqual({ status: 'failed', error: 'did not finish' });
    expect(h.blobs.keys().filter((k) => k.startsWith(prefix))).toEqual([]);
  });
});
