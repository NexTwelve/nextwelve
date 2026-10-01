import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expectOk } from '../helpers.js';
import { buildTemplate, createDemoHarness, DEMO, type DemoHarness, startDemo, startOk, su } from './demo-helpers.js';

/**
 * What removing demo copies costs the database, and who pays for it: the purge runs inside every
 * demo start (up to three expired copies, under the one lock all starts share), in "Start over",
 * and in the hourly sweep.
 */
describe('adversarial demo: cost of purging copies', () => {
  let h: DemoHarness;

  beforeAll(async () => {
    h = await createDemoHarness({ ...DEMO, perIpHour: 1, maxLive: 20 });
    await buildTemplate(h);
    // Count tenant deletions in a way a rollback cannot undo (sequences are not transactional).
    await su(h, 'create sequence public.nx_tenant_deletes');
    await su(h, `create function public.nx_count_tenant_delete() returns trigger language plpgsql security definer as $$
                 begin perform nextval('public.nx_tenant_deletes'); return old; end $$`);
    await su(h, 'create trigger nx_count_tenant_delete after delete on epm.tenant for each row execute function public.nx_count_tenant_delete()');
  }, 40_000);
  afterAll(async () => h?.close());

  const deletes = async () => Number((await su(h, 'select case when is_called then last_value else 0 end as n from public.nx_tenant_deletes'))[0].n);

  it('FINDING: a start refused by the rate limit first purges up to three expired copies, then throws that work away', async () => {
    const ip = '198.51.100.70';
    expect((await startDemo(h, ip)).status).toBe(201);
    const expired: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = await startOk(h, `198.51.100.${71 + i}`);
      expectOk(await d.api.post(`/v1/apps/${d.appId}/snapshots`, {}), 201);
      expired.push(d.tenantId);
    }
    await su(h, "update epm.tenant set demo_expires_at = now() - interval '1 second' where tenant_id = any($1::uuid[])", [expired]);
    const before = await deletes();
    const refused = await startDemo(h, ip);
    expect(refused.status).toBe(429);
    // The expired copies are all still there (the refusal rolled their removal back)...
    expect((await su(h, 'select count(*)::int as n from epm.tenant where tenant_id = any($1::uuid[])', [expired]))[0].n).toBe(3);
    // ...and so are their files (before the fix the API deleted them on the strength of a rolled-back purge).
    const filesLeft = (await Promise.all(expired.map((t) => h.store.list(`${t}/`)))).flat().length;
    const snapRows = (await su(h, 'select count(*)::int as n from epm.snapshot where tenant_id = any($1::uuid[])', [expired]))[0].n;
    expect(snapRows).toBe(3);
    expect(filesLeft).toBeGreaterThan(0);
    // Should be: an anonymous request that is refused costs no purge work under the global start lock
    // (check the limits before tidying up, or tidy up in its own transaction).
    expect(await deletes()).toBe(before);
  });

  it('FINDING: a refused start hands the anonymous caller the tenant ids of other visitors\' copies', async () => {
    const ip = '198.51.100.75';
    expect((await startDemo(h, ip)).status).toBe(201);
    const other = await startOk(h, '198.51.100.76');
    await su(h, "update epm.tenant set demo_expires_at = now() - interval '1 second' where tenant_id = $1", [other.tenantId]);
    const refused = await startDemo(h, ip);
    expect(refused.status).toBe(429);
    // Should be: the error says only what the visitor needs (try later), nothing about other copies.
    expect(JSON.stringify(refused.body)).not.toContain(other.tenantId);
  });

  it('FINDING: removing a copy scans every tenant\'s rows in change_txn, metadata_change, member_ancestor and effective_access', async () => {
    const d = await startOk(h, '198.51.100.80');
    // Another (real) tenant's history, as a production database has: 100,000 rows in each table.
    const other = randomUUID();
    const app = randomUUID();
    await su(h, `insert into epm.change_txn (txn_id, tenant_id, app_id, source, cell_count, chain_seq, txn_hash, created_at)
                 select 1000000000 + g, $1, $2, 'api', 1, g, '\\x00', now() from generate_series(1, 100000) g`, [other, app]);
    await su(h, `insert into epm.metadata_change (tenant_id, app_id, metadata_rev, summary) select $1, $2, g, '{}' from generate_series(1, 100000) g`, [other, app]);
    await su(h, `insert into epm.member_ancestor (tenant_id, dim_id, ancestor_id, descendant_id, depth, sign, descendant_is_leaf)
                 select $1, 0, 100000000 + g, 100000000 + g, 0, 1, true from generate_series(1, 100000) g`, [other]);
    await su(h, `insert into epm.effective_access (tenant_id, app_id, user_id, dim_id, member_id, access)
                 select $1, $2, $1, 0, g, 'read' from generate_series(1, 100000) g`, [other, app]);
    await su(h, 'analyze epm.change_txn, epm.metadata_change, epm.member_ancestor, epm.effective_access');

    // The plans purge_tenant runs, as auto_explain reports them for nested statements.
    const c = new pg.Client({ connectionString: h.db.superUrl });
    await c.connect();
    const notices: string[] = [];
    c.on('notice', (n) => notices.push(String(n.message ?? '') + '\n' + String((n as { detail?: string }).detail ?? '')));
    try {
      await c.query("load 'auto_explain'");
      await c.query('set auto_explain.log_min_duration = 0');
      await c.query('set auto_explain.log_nested_statements = on');
      await c.query('set auto_explain.log_level = notice');
      await c.query("set client_min_messages = 'notice'");
      await c.query('begin');
      expect((await c.query('select epm.purge_tenant($1) as ok', [d.tenantId])).rows[0].ok).toBe(true);
      await c.query('rollback');
    } finally {
      await c.end();
    }
    const plans = notices.join('\n');
    expect(plans).toMatch(/delete from epm\.change_txn/);
    const scanned = ['change_txn', 'metadata_change', 'member_ancestor', 'effective_access'].filter((t) => new RegExp(`Seq Scan on ${t}\\b`).test(plans));
    // Should be: each delete finds the copy's rows through an index (tenant_id, or app_id/dim_id), so its
    // cost does not grow with every other tenant's data; today each is a full scan of the table.
    expect(scanned).toEqual([]);
  });
});
