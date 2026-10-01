import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, createHarness, expectOk, planGrid, provisionTenant, seedPlanApp, signIn } from './helpers.js';

/**
 * Tenant isolation is enforced by Postgres, not just the API. These tests go straight to the
 * database as the API's login role (epm_app) and try to reach another tenant's rows.
 */
describe('row-level security and privileges', () => {
  let h: Harness;
  let tenantA: string;
  let tenantB: string;
  let tables: string[];

  beforeAll(async () => {
    h = await createHarness();
    tenantA = await provisionTenant(h.db, 'Tenant A', null, 'admin@a.test');
    tenantB = await provisionTenant(h.db, 'Tenant B', null, 'admin@b.test');
    // Put real rows in every kind of table for both tenants.
    for (const email of ['admin@a.test', 'admin@b.test']) {
      const admin = await signIn(h, email);
      const appId = await seedPlanApp(admin);
      const grid = expectOk(await admin.post(`/v1/apps/${appId}/grid/read`, planGrid()));
      const values = grid.values.map((row: (number | null)[], i: number) => row.map((v, j) => (grid.writable[i][j] ? 100 + i + j : v)));
      expectOk(await admin.post(`/v1/apps/${appId}/grid/submit`, { grid_session_id: grid.grid_session_id, values }));
      expectOk(await admin.put(`/v1/apps/${appId}/grants`, { grants: [{ principal: { user: email }, dimension: 'Entity', member: 'Total Company', access: 'write' }] }));
      expectOk(await admin.put(`/v1/apps/${appId}/plan-windows`, { scenario: 'Budget', version: 'Final', years: 'FY27', locked: true }));
      expectOk(await admin.post(`/v1/groups`, { name: 'Planners' }), 201);
      // Forms, files, datasets, import formats, mapping rules, runs and lines, snapshots.
      const b = `/v1/apps/${appId}`;
      expectOk(await admin.put(`${b}/forms/Revenue`, { cube: 'Plan', definition: {
        pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' },
        rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } } }));
      const f = expectOk(await admin.upload(b, 'map.csv', 'Code,Member\nR,Revenue\n', 'dataset'), 201);
      expectOk(await admin.put(`${b}/datasets/Codes`, { file_id: f.file_id }));
      expectOk(await admin.put(`${b}/import-formats/Loader`, { cube: 'Plan', definition: {
        dimensions: { Scenario: { value: 'Actual' }, Version: { value: 'Working' }, Years: { value: 'FY27' }, Period: { value: 'Feb' },
                      Entity: { value: 'East' }, Department: { value: 'Sales' }, Product: { value: 'Widgets' }, Account: { column: 'Code' } },
        amount: { column: 'Amount' } } }));
      expectOk(await admin.put(`${b}/import-formats/Loader/mappings`, { rules: [
        { dimension: 'Account', rule_type: 'dataset', source: 'Codes', target: 'Member', options: { key_column: 'Code' } }] }));
      const data = expectOk(await admin.upload(b, 'load.csv', 'Code,Amount\nR,5\n'), 201);
      expectOk(await admin.post(`${b}/import-formats/Loader/run`, { file_id: data.file_id }));
      expectOk(await admin.post(`${b}/snapshots`, {}), 201);
    }
    const res = await h.pool.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'epm' and c.relkind in ('r','p') and not c.relispartition
          and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id')
        order by 1`,
    );
    tables = res.rows.map((r) => r.relname);
  });

  afterAll(async () => h?.close());

  async function asTenant<T>(tenantId: string | null, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      if (tenantId) await c.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      return await fn(c);
    } finally {
      await c.query('rollback');
      c.release();
    }
  }

  it('covers every tenant table', () => {
    expect(tables).toEqual(expect.arrayContaining(['fact', 'cell_audit', 'change_txn', 'member', 'access_grant', 'grid_session']));
    expect(tables.length).toBeGreaterThanOrEqual(20);
  });

  it('enables and forces RLS with a tenant policy on every tenant table', async () => {
    const res = await h.pool.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(
      `select c.relname, c.relrowsecurity, c.relforcerowsecurity,
              (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'epm' and c.relname = any($1::text[])`,
      [tables],
    );
    for (const r of res.rows) {
      expect(r.relrowsecurity, r.relname).toBe(true);
      expect(r.policies, r.relname).toBeGreaterThan(0);
      // Only the two tables login must search before a tenant is known are not forced.
      expect(r.relforcerowsecurity, r.relname).toBe(!['tenant', 'app_user'].includes(r.relname));
    }
  });

  it('shows another tenant nothing, table by table', async () => {
    await asTenant(tenantA, async (c) => {
      for (const t of tables) {
        const other = await c.query<{ n: number }>(`select count(*)::int as n from epm.${t} where tenant_id = $1`, [tenantB]);
        expect(other.rows[0]!.n, t).toBe(0);
        const mine = await c.query<{ n: number }>(`select count(*)::int as n from epm.${t}`);
        const leaked = await c.query<{ n: number }>(`select count(*)::int as n from epm.${t} where tenant_id <> $1`, [tenantA]);
        expect(leaked.rows[0]!.n, t).toBe(0);
        expect(mine.rows[0]!.n, t).toBeGreaterThanOrEqual(0);
      }
      // Sanity: tenant A does see its own facts and audit rows.
      const facts = await c.query<{ n: number }>('select count(*)::int as n from epm.fact');
      expect(facts.rows[0]!.n).toBeGreaterThan(0);
    });
  });

  it('shows nothing at all without a tenant in the session', async () => {
    await asTenant(null, async (c) => {
      for (const t of tables) {
        const res = await c.query<{ n: number }>(`select count(*)::int as n from epm.${t}`);
        expect(res.rows[0]!.n, t).toBe(0);
      }
    });
  });

  it('rejects writes that name another tenant', async () => {
    await asTenant(tenantA, async (c) => {
      await c.query('savepoint s');
      await expect(c.query("insert into epm.application (tenant_id, name) values ($1, 'Sneaky')", [tenantB])).rejects.toMatchObject({
        code: '42501',
      });
      await c.query('rollback to savepoint s');
      const updated = await c.query('update epm.application set name = name || \'x\' where tenant_id = $1', [tenantB]);
      expect(updated.rowCount).toBe(0);
      const deleted = await c.query('delete from epm.member where tenant_id = $1', [tenantB]);
      expect(deleted.rowCount).toBe(0);
    });
  });

  it('gives the API role no direct write path to facts, audit, closure or resolved access', async () => {
    for (const t of ['fact', 'cell_audit', 'change_txn', 'member_ancestor', 'effective_access', 'metadata_change']) {
      for (const priv of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const res = await h.pool.query<{ ok: boolean }>('select has_table_privilege(current_user, $1, $2) as ok', [`epm.${t}`, priv]);
        expect(res.rows[0]!.ok, `${priv} on ${t}`).toBe(false);
      }
    }
    for (const t of ['security_event']) {
      for (const priv of ['UPDATE', 'DELETE']) {
        const res = await h.pool.query<{ ok: boolean }>('select has_table_privilege(current_user, $1, $2) as ok', [`epm.${t}`, priv]);
        expect(res.rows[0]!.ok, `${priv} on ${t}`).toBe(false);
      }
    }
  });

  it('blocks direct access to partitions and to owner-only functions', async () => {
    await expect(h.pool.query('select count(*) from epm.fact_p0')).rejects.toMatchObject({ code: '42501' });
    await expect(h.pool.query('select count(*) from epm.cell_audit_default')).rejects.toMatchObject({ code: '42501' });
    await expect(h.pool.query("select epm.provision_tenant('x', null, 'x@x.test')")).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps SECURITY DEFINER functions inside the session tenant', async () => {
    // Tenant A's admin calling apply_changes with tenant B's application id finds nothing.
    const owner = new pg.Client({ connectionString: h.db.superUrl });
    await owner.connect();
    const bApp = (await owner.query<{ app_id: string }>('select app_id from epm.application where tenant_id = $1', [tenantB])).rows[0]!.app_id;
    const aUser = (await owner.query<{ user_id: string }>("select user_id from epm.app_user where email = 'admin@a.test'")).rows[0]!.user_id;
    await owner.end();

    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantA, aUser]);
      await expect(
        c.query('select epm.apply_changes($1::jsonb)', [JSON.stringify({ app_id: bApp, source: 'api', cells: [] })]),
      ).rejects.toMatchObject({ code: 'NX404' });
    } finally {
      await c.query('rollback');
      c.release();
    }
  });
});
