/**
 * Shared fixtures for the adversarial metadata-history / metadata-restore suites (not a test file).
 *
 * One harness (with query hooks, so races can be forced), one tenant, and as many small Plan
 * applications as a suite wants: each test that changes metadata gets its own application, so a
 * finding fixed later does not change what the next test starts from.
 */
import pg from 'pg';
import { Api, type ApiResponse, expectOk, type Harness, provisionTenant, seedPlanApp, signIn } from '../helpers.js';
import { type AbuseHarness, asUser, createAbuseHarness } from './abuse-helpers.js';

export type Dim = 'Scenario' | 'Version' | 'Years' | 'Period' | 'Entity' | 'Account' | 'Department' | 'Product';
export const POS: Record<Dim, number> = { Scenario: 1, Version: 2, Years: 3, Period: 4, Entity: 5, Account: 6, Department: 7, Product: 8 };
export const CELL: Record<Dim, string> = {
  Scenario: 'Budget', Version: 'Working', Years: 'FY27', Period: 'Jan', Entity: 'East', Account: 'Revenue', Department: 'Sales', Product: 'Widgets',
};

export interface TreeRow {
  member_id: number;
  name: string;
  parent: string | null;
  parent_id: number | null;
  sort_order: number;
  agg_op: string;
  alias: string | null;
  is_leaf: boolean;
  deployed: boolean;
}

export interface MetaApp {
  appId: string;
  base: string;
  restore(body: Record<string, unknown>, api?: Api): Promise<ApiResponse>;
  /** Every member of a dimension, in member_id order. */
  tree(dim: Dim | string): Promise<TreeRow[]>;
  member(dim: Dim | string, name: string): Promise<TreeRow | undefined>;
  /** Save members (not deployed). */
  put(dim: Dim | string, members: Record<string, unknown>[]): Promise<void>;
  del(dim: Dim | string, name: string): Promise<void>;
  deploy(): Promise<number>;
  coord(at?: Partial<Record<Dim, string>>): Promise<number[]>;
  /** Write cells through epm.apply_changes as the admin; returns the txn id. */
  write(cells: { at?: Partial<Record<Dim, string>>; v: number | string | null }[]): Promise<number | null>;
  /** The stored value (numeric text) of one cell, or null. */
  value(at?: Partial<Record<Dim, string>>): Promise<string | null>;
  /** A rolled-up value through the grid: Product on rows, Period on columns. */
  rollup(product: string, period?: string, over?: Partial<Record<Dim, string>>): Promise<number | null>;
  metadataRev(): Promise<number>;
  /** Closure rows that differ from the transitive closure of parent_id (0 = consistent). */
  closureMismatch(): Promise<number>;
  /** Facts on a coordinate that is not an existing deployed leaf of the cube's dimension. */
  orphanFacts(): Promise<number>;
}

export interface MetaEnv {
  h: AbuseHarness;
  su: pg.Client;
  admin: Api;
  tenantId: string;
  email: string;
  now(): Promise<string>;
  pause(ms?: number): Promise<void>;
  newApp(name: string): Promise<MetaApp>;
  /** Invite a user and give them a role in an application; returns their signed-in Api. */
  userWithRole(email: string, appId: string, role: string): Promise<Api>;
  close(): Promise<void>;
}

const TIME = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

export async function setupMeta(label: string): Promise<MetaEnv> {
  const h = await createAbuseHarness();
  const email = `admin@${label}.test`;
  const tenantId = await provisionTenant(h.db, `${label} Co`, null, email);
  const admin = await signIn(h as unknown as Harness, email);
  const su = new pg.Client({ connectionString: h.db.superUrl });
  await su.connect();

  const now = async () => (await su.query<{ t: string }>(`select to_char(clock_timestamp() at time zone 'UTC', ${TIME}) as t`)).rows[0]!.t;
  const pause = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

  async function newApp(name: string): Promise<MetaApp> {
    const appId = await seedPlanApp(admin, name);
    const base = `/v1/apps/${appId}`;
    const tree = async (dim: string) =>
      (await su.query<TreeRow>(
        `select m.member_id, m.name, p.name as parent, m.parent_id, m.sort_order, m.agg_op, m.alias, m.is_leaf,
                m.tree_ordinal is not null as deployed
           from epm.member m join epm.dimension d on d.dim_id = m.dim_id left join epm.member p on p.member_id = m.parent_id
          where d.app_id = $1 and lower(d.name) = lower($2) order by m.member_id`,
        [appId, dim],
      )).rows;
    const ids = async () => {
      const r = await su.query<{ dim: string; name: string; member_id: number }>(
        `select d.name as dim, m.name, m.member_id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1`,
        [appId],
      );
      return new Map(r.rows.map((x) => [`${x.dim}/${x.name}`, x.member_id]));
    };
    const cube = (await su.query<{ cube_id: number }>('select cube_id from epm.cube where app_id = $1', [appId])).rows[0]!.cube_id;
    const coord = async (at: Partial<Record<Dim, string>> = {}) => {
      const all = { ...CELL, ...at } as Record<Dim, string>;
      const m = await ids();
      const k = new Array<number>(16).fill(0);
      k[0] = cube;
      for (const [dim, pos] of Object.entries(POS) as [Dim, number][]) {
        const id = m.get(`${dim}/${all[dim]}`);
        if (id === undefined) throw new Error(`no member ${dim}/${all[dim]}`);
        k[pos] = id;
      }
      return k;
    };
    const app: MetaApp = {
      appId,
      base,
      restore: (body, api = admin) => api.post(`${base}/metadata/restore`, body),
      tree,
      member: async (dim, n) => (await tree(dim)).find((r) => r.name === n),
      async put(dim, members) { expectOk(await admin.put(`${base}/dimensions/${dim}/members`, { members })); },
      async del(dim, n) { expectOk(await admin.del(`${base}/dimensions/${dim}/members/${n}`)); },
      async deploy() { return expectOk(await admin.post(`${base}/deploy`)).metadata_rev as number; },
      coord,
      async write(cells) {
        const payload: { k: number[]; v: string | null }[] = [];
        for (const c of cells) payload.push({ k: await coord(c.at ?? {}), v: c.v === null ? null : String(c.v) });
        const r = await asUser(h.pool, tenantId, email, (c) =>
          c.query<{ r: { txn_id: number | null } }>('select epm.apply_changes($1::jsonb) as r', [JSON.stringify({ app_id: appId, source: 'api', cells: payload })]));
        return r.rows[0]!.r.txn_id;
      },
      async value(at = {}) {
        const k = await coord(at);
        const r = await su.query<{ v: string }>(
          `select value::text as v from epm.fact where app_id = $1 and array[cube_id, scenario_id, version_id, years_id, period_id,
             entity_id, account_id, department_id, c1, c2, c3, c4, c5, c6, c7, c8] = $2::int[]`,
          [appId, k],
        );
        return r.rows[0]?.v ?? null;
      },
      async rollup(product, period = 'Jan', over = {}) {
        const all = { ...CELL, ...over } as Record<Dim, string>;
        const pov = { Scenario: all.Scenario, Version: all.Version, Years: all.Years, Entity: all.Entity, Account: all.Account, Department: all.Department };
        const g = expectOk(await admin.post(`${base}/grid/read`, {
          cube: 'Plan', pov, rows: { dimension: 'Product', members: [product] }, columns: { dimension: 'Period', members: [period] },
        }));
        return g.values[0][0] as number | null;
      },
      async metadataRev() {
        return (await su.query<{ r: number }>('select metadata_rev as r from epm.application where app_id = $1', [appId])).rows[0]!.r;
      },
      async closureMismatch() {
        const r = await su.query<{ n: number }>(
          `with recursive cl(a, d, depth) as (
             select m.member_id, m.member_id, 0 from epm.member m join epm.dimension dm on dm.dim_id = m.dim_id where dm.app_id = $1
             union all
             select cl.a, c.member_id, cl.depth + 1 from cl join epm.member c on c.parent_id = cl.d
           ),
           ma as (select ancestor_id as a, descendant_id as d, depth::int as depth
                    from epm.member_ancestor x join epm.dimension dm on dm.dim_id = x.dim_id where dm.app_id = $1)
           select ((select count(*) from (select * from cl except select * from ma) x)
                 + (select count(*) from (select * from ma except select * from cl) y))::int as n`,
          [appId],
        );
        return r.rows[0]!.n;
      },
      async orphanFacts() {
        const r = await su.query<{ n: number }>(
          `select count(*)::int as n from epm.fact f
            where f.app_id = $1
              and exists (
                select 1 from epm.cube_dimension cd join epm.dimension dm on dm.dim_id = cd.dim_id
                 where cd.cube_id = f.cube_id
                   and not exists (
                     select 1 from epm.member m
                      where m.dim_id = dm.dim_id and m.is_leaf and m.tree_ordinal is not null
                        and m.member_id = (array[f.cube_id, f.scenario_id, f.version_id, f.years_id, f.period_id, f.entity_id,
                                                 f.account_id, f.department_id, f.c1, f.c2, f.c3, f.c4, f.c5, f.c6, f.c7, f.c8])
                                          [epm.coord_index(dm.dim_type, dm.slot)]))`,
          [appId],
        );
        return r.rows[0]!.n;
      },
    };
    return app;
  }

  async function userWithRole(userEmail: string, appId: string, role: string): Promise<Api> {
    const invited = await admin.post('/v1/users', { email: userEmail });
    if (invited.status !== 201 && invited.status !== 409) throw new Error(`invite failed: ${JSON.stringify(invited.body)}`);
    expectOk(await admin.post(`/v1/apps/${appId}/roles`, { email: userEmail, role }));
    return signIn(h as unknown as Harness, userEmail);
  }

  return {
    h, su, admin, tenantId, email, now, pause, newApp, userWithRole,
    async close() {
      await su.end().catch(() => undefined);
      await h.close();
    },
  };
}

/** A name -> DimReport map from a restore result. */
export function byDim(result: any): Record<string, any> {
  return Object.fromEntries((result?.members?.dimensions ?? []).map((d: any) => [d.dimension, d]));
}

/** A tree as comparable rows: name, parent name, sort order, aggregation, alias. */
export const shape = (rows: TreeRow[]) =>
  rows.map((r) => ({ id: r.member_id, name: r.name, parent: r.parent, sort_order: r.sort_order, agg_op: r.agg_op, alias: r.alias }))
    .sort((a, b) => a.id - b.id);

export { expectOk };
