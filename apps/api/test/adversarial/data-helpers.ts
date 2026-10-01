/**
 * Shared fixtures for the adversarial backup/restore data tests (not a test file itself).
 *
 * Writes go straight through epm.apply_changes / epm.undo_txn with the session set (fast and exact:
 * values are passed as strings so numeric(24,6) values are never squeezed through a JS double),
 * and reads of ground truth go straight to epm.fact as the superuser with value::text.
 */
import pg from 'pg';
import { Api, type Harness, createHarness, expectOk, provisionTenant, seedPlanApp, signIn } from '../helpers.js';

export type Val = string | number | null;
export interface Cell { k: number[]; v: Val }

/** Deterministic PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    chance: (p: number) => next() < p,
  };
}

export const DIM_POS: Record<string, number> = {
  Scenario: 1, Version: 2, Years: 3, Period: 4, Entity: 5, Account: 6, Department: 7, Product: 8,
};

export interface Env {
  h: Harness;
  admin: Api;
  tenantId: string;
  userId: string;
  appId: string;
  base: string;
  su: pg.Client;
  cubeId: number;
  ids: Map<string, number>;
  id(dim: string, name: string): number;
  refreshIds(): Promise<void>;
  coord(o?: Partial<Record<keyof typeof DIM_POS, string>>): number[];
  write(cells: Cell[], source?: string): Promise<{ txn_id: number | null; chain_seq: number | null }>;
  undo(txnId: number, force?: boolean): Promise<{ txn_id: number | null; chain_seq: number | null }>;
  head(): Promise<number>;
  /** key (coords joined, version replaced by '*' when ignoreVersion) -> value::text */
  facts(where: { scenario?: string; version?: string; cube?: number }, ignoreVersion?: boolean): Promise<Map<string, string>>;
  allFacts(): Promise<Map<string, string>>;
  close(): Promise<void>;
}

export const DEFAULT_CELL = {
  Scenario: 'Budget', Version: 'Working', Years: 'FY27', Period: 'Jan', Entity: 'East', Account: 'Revenue',
  Department: 'Sales', Product: 'Widgets',
};

export async function setupEnv(label: string, appName = 'FY27 Plan'): Promise<Env> {
  const h = await createHarness();
  const email = `admin@${label}.test`;
  const tenantId = await provisionTenant(h.db, `${label} Co`, null, email);
  const admin = await signIn(h, email);
  const appId = await seedPlanApp(admin, appName);
  const su = new pg.Client({ connectionString: h.db.superUrl });
  await su.connect();
  const userId = (await su.query<{ user_id: string }>('select user_id from epm.app_user where email = $1', [email])).rows[0]!.user_id;
  const cubeId = (await su.query<{ cube_id: number }>('select cube_id from epm.cube where app_id = $1', [appId])).rows[0]!.cube_id;
  const ids = new Map<string, number>();
  const refreshIds = async () => {
    ids.clear();
    const r = await su.query<{ dim: string; name: string; member_id: number }>(
      `select d.name as dim, m.name, m.member_id from epm.member m join epm.dimension d on d.dim_id = m.dim_id where d.app_id = $1`,
      [appId],
    );
    for (const x of r.rows) ids.set(`${x.dim}/${x.name}`, x.member_id);
  };
  await refreshIds();
  const id = (dim: string, name: string) => {
    const v = ids.get(`${dim}/${name}`);
    if (v === undefined) throw new Error(`no member ${dim}/${name}`);
    return v;
  };
  const coord = (o: Partial<Record<keyof typeof DIM_POS, string>> = {}) => {
    const all = { ...DEFAULT_CELL, ...o } as Record<string, string>;
    const k = new Array<number>(16).fill(0);
    k[0] = cubeId;
    for (const [dim, pos] of Object.entries(DIM_POS)) k[pos] = id(dim, all[dim]!);
    return k;
  };
  const session = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    const c = await h.pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true)", [tenantId, userId]);
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (err) {
      await c.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      c.release();
    }
  };
  const seqOf = async (txn: number | null) => {
    if (txn === null) return null;
    const r = await su.query<{ s: string }>('select chain_seq::text as s from epm.change_txn where txn_id = $1', [txn]);
    return r.rows[0] ? Number(r.rows[0].s) : null;
  };
  const write = async (cells: Cell[], source = 'api') => {
    const r = await session((c) =>
      c.query<{ r: { txn_id: number | null } }>('select epm.apply_changes($1::jsonb) as r', [
        JSON.stringify({ app_id: appId, source, cells: cells.map((x) => ({ k: x.k, v: x.v === null ? null : String(x.v) })) }),
      ]),
    );
    const txn = r.rows[0]!.r.txn_id;
    return { txn_id: txn, chain_seq: await seqOf(txn) };
  };
  const undo = async (txnId: number, force = false) => {
    const r = await session((c) => c.query<{ r: { txn_id: number | null } }>('select epm.undo_txn($1, $2) as r', [txnId, force]));
    const txn = r.rows[0]!.r.txn_id;
    return { txn_id: txn, chain_seq: await seqOf(txn) };
  };
  const head = async () =>
    Number((await su.query<{ s: string }>('select coalesce(max(chain_seq), 0)::text as s from epm.change_txn where app_id = $1', [appId])).rows[0]!.s);
  const facts = async (where: { scenario?: string; version?: string; cube?: number }, ignoreVersion = false) => {
    const params: unknown[] = [appId];
    const conds = ['app_id = $1'];
    if (where.cube !== undefined) { params.push(where.cube); conds.push(`cube_id = $${params.length}`); }
    if (where.scenario) { params.push(id('Scenario', where.scenario)); conds.push(`scenario_id = $${params.length}`); }
    if (where.version) { params.push(id('Version', where.version)); conds.push(`version_id = $${params.length}`); }
    const r = await su.query<{ k: number[]; v: string }>(
      `select array[cube_id, scenario_id, version_id, years_id, period_id, entity_id, account_id, department_id,
                    c1, c2, c3, c4, c5, c6, c7, c8] as k, value::text as v
         from epm.fact where ${conds.join(' and ')}`,
      params,
    );
    const m = new Map<string, string>();
    for (const row of r.rows) {
      const k = [...row.k].map(String);
      if (ignoreVersion) k[2] = '*';
      m.set(k.join(','), row.v);
    }
    return m;
  };
  const allFacts = () => facts({});
  return {
    h, admin, tenantId, userId, appId, base: `/v1/apps/${appId}`, su, cubeId, ids, id, refreshIds, coord, write, undo, head, facts, allFacts,
    async close() {
      await su.end().catch(() => undefined);
      await h.close();
    },
  };
}

/** Sorted entries, for readable toEqual diffs. */
export const sorted = (m: Map<string, string>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** numeric(24,6) text of a value, the way Postgres prints it. */
export function num6(v: string | number): string {
  const s = String(v);
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const out = `${i}.${(f + '000000').slice(0, 6)}`;
  return neg && out !== '0.000000' ? `-${out}` : out;
}

export { expectOk };
