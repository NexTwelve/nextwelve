import { randomBytes, randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

type KeyLike = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
import pg from 'pg';
import { bootstrapRoles, createDatabase, migrate, setJobKey } from '../../../packages/db/src/index.js';
import { createApp } from '../src/app.js';
import type { DemoConfig } from '../src/demo.js';
import { createGoogleVerifier } from '../src/auth/google.js';
import { createSessionSigner } from '../src/auth/session.js';
import { poolDatabase } from '../src/db.js';
import { memoryBlobStore } from '../src/files/blobs.js';
import type { App } from '../src/routes/context.js';

export const SUPER_URL = process.env.NX_TEST_SUPERUSER_URL ?? 'postgres://postgres@localhost:54329/postgres';
export const TEST_CLIENT_ID = 'test-client.apps.googleusercontent.com';

function urlFor(base: string, user: string, db: string): string {
  const u = new URL(base);
  u.username = user;
  u.password = '';
  u.pathname = `/${db}`;
  return u.toString();
}

export interface TestDb {
  name: string;
  /** The nightly job's key (epm.snapshot_targets). */
  jobKey: string;
  appUrl: string;
  ownerUrl: string;
  superUrl: string;
  drop(): Promise<void>;
}

/** A fresh database with roles bootstrapped and all migrations applied as epm_owner. */
export async function createTestDb(): Promise<TestDb> {
  const name = `nx_t_${randomBytes(6).toString('hex')}`;
  await bootstrapRoles(SUPER_URL);
  await createDatabase(SUPER_URL, name);
  const ownerUrl = urlFor(SUPER_URL, 'epm_owner', name);
  await migrate(ownerUrl);
  const jobKey = await setJobKey(ownerUrl);
  return {
    name,
    jobKey,
    appUrl: urlFor(SUPER_URL, 'epm_app', name),
    ownerUrl,
    superUrl: urlFor(SUPER_URL, 'postgres', name),
    async drop() {
      const c = new pg.Client({ connectionString: SUPER_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

/** Stand-in for Google: our own RSA key, served through a local JWKS. */
export class FakeGoogle {
  private constructor(private readonly key: KeyLike, readonly jwk: JWK) {}

  static async create(): Promise<FakeGoogle> {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    return new FakeGoogle(privateKey, jwk);
  }

  keys() {
    return createLocalJWKSet({ keys: [this.jwk] });
  }

  async token(claims: { sub: string; email: string; hd?: string; email_verified?: boolean; aud?: string; iss?: string; expiresIn?: string }) {
    const payload: Record<string, unknown> = { email: claims.email, email_verified: claims.email_verified ?? true };
    if (claims.hd) payload.hd = claims.hd;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setSubject(claims.sub)
      .setIssuer(claims.iss ?? 'https://accounts.google.com')
      .setAudience(claims.aud ?? TEST_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(claims.expiresIn ?? '1h')
      .sign(this.key);
  }
}

export interface Harness {
  db: TestDb;
  pool: pg.Pool;
  app: App;
  google: FakeGoogle;
  blobs: ReturnType<typeof memoryBlobStore>;
  close(): Promise<void>;
}

export async function createHarness(extra: { demo?: DemoConfig } = {}): Promise<Harness> {
  const db = await createTestDb();
  const pool = new pg.Pool({ connectionString: db.appUrl, max: 8 });
  const google = await FakeGoogle.create();
  const blobs = memoryBlobStore();
  const app = createApp({
    db: poolDatabase(pool),
    blobs,
    signer: createSessionSigner(randomBytes(32), 900),
    verifier: createGoogleVerifier({ audiences: [TEST_CLIENT_ID], keys: google.keys() }),
    demo: extra.demo,
  });
  return {
    db,
    pool,
    app,
    google,
    blobs,
    async close() {
      await pool.end();
      await db.drop();
    },
  };
}

/** Provision a tenant as the owner role (as the real provisioning script does). */
export async function provisionTenant(db: TestDb, name: string, domain: string | null, adminEmail: string): Promise<string> {
  const c = new pg.Client({ connectionString: db.ownerUrl });
  await c.connect();
  try {
    const res = await c.query<{ id: string }>('select epm.provision_tenant($1, $2, $3) as id', [name, domain, adminEmail]);
    return res.rows[0]!.id;
  } finally {
    await c.end();
  }
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export class Api {
  constructor(private readonly app: App, public token: string | null = null) {}

  async call<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (payload !== undefined) headers['content-type'] = 'application/json';
    const res = await this.app.request(encodeURI(url), {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  }
  /** Raw file upload, as the browser or a script would send it. */
  async upload<T = any>(appBase: string, name: string, data: Uint8Array | string, purpose: 'import' | 'dataset' = 'import'): Promise<ApiResponse<T>> {
    const res = await this.app.request(`${appBase}/files?name=${encodeURIComponent(name)}&purpose=${purpose}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/octet-stream' },
      body: typeof data === 'string' ? new TextEncoder().encode(data) : data,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  }
  /** Any request with a raw body; the response comes back as bytes (and JSON when it is JSON). */
  async raw(method: 'GET' | 'POST', url: string, body?: Uint8Array | string | FormData, contentType?: string): Promise<{ status: number; bytes: Uint8Array; headers: Headers; json: any }> {
    const headers: Record<string, string> = {};
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (contentType) headers['content-type'] = contentType;
    const res = await this.app.request(encodeURI(url), {
      method,
      headers,
      body: typeof body === 'string' ? new TextEncoder().encode(body) : body,
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const isJson = (res.headers.get('content-type') ?? '').includes('json');
    return { status: res.status, bytes, headers: res.headers, json: isJson && bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : undefined };
  }
  get<T = any>(url: string) { return this.call<T>('GET', url); }
  post<T = any>(url: string, body?: unknown) { return this.call<T>('POST', url, body ?? {}); }
  put<T = any>(url: string, body: unknown) { return this.call<T>('PUT', url, body); }
  patch<T = any>(url: string, body: unknown) { return this.call<T>('PATCH', url, body); }
  del<T = any>(url: string) { return this.call<T>('DELETE', url); }
}

/** Sign in through POST /v1/auth/session with a fake Google token. */
export async function signIn(h: Harness, email: string, opts: { sub?: string; hd?: string } = {}): Promise<Api> {
  const idToken = await h.google.token({ sub: opts.sub ?? `sub-${email}`, email, hd: opts.hd });
  const api = new Api(h.app);
  const res = await api.post('/v1/auth/session', { id_token: idToken });
  if (res.status !== 200) throw new Error(`sign-in failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  api.token = res.body.session_token;
  return api;
}

export function expectOk<T>(res: ApiResponse<T>, status = 200): T {
  if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * A small planning application:
 *   Scenario: Actual, Budget          Version: Working, Final       Years: FY27
 *   Period:   YearTotal > Q1 > Jan, Feb, Mar ; Q2 > Apr, May, Jun
 *   Entity:   Total Company > East, West          (secured)
 *   Account:  Net Income > Gross Margin > Revenue (+), COGS (-) ; Opex (-)
 *   Department: All Departments > Sales, Operations   (first-class, optional per cube)
 *   Product:  custom slot 1: All Products > Widgets, Gadgets
 * Cube "Plan" uses all eight dimensions.
 */
export async function seedPlanApp(admin: Api, name = 'FY27 Plan'): Promise<string> {
  const app = expectOk(await admin.post('/v1/apps', { name }), 201) as { app_id: string };
  const base = `/v1/apps/${app.app_id}`;
  const dims: [string, string, boolean][] = [
    ['Scenario', 'scenario', false], ['Version', 'version', false], ['Years', 'years', false],
    ['Period', 'period', false], ['Entity', 'entity', true], ['Account', 'account', false],
    ['Department', 'department', false], ['Product', 'custom', false],
  ];
  for (const [n, type, secured] of dims) expectOk(await admin.post(`${base}/dimensions`, { name: n, type, secured }), 201);
  const members: Record<string, unknown[]> = {
    Scenario: [{ name: 'Actual' }, { name: 'Budget' }],
    Version: [{ name: 'Working' }, { name: 'Final' }],
    Years: [{ name: 'FY27' }],
    Period: [
      { name: 'YearTotal' }, { name: 'Q1', parent: 'YearTotal' }, { name: 'Q2', parent: 'YearTotal' },
      { name: 'Jan', parent: 'Q1' }, { name: 'Feb', parent: 'Q1' }, { name: 'Mar', parent: 'Q1' },
      { name: 'Apr', parent: 'Q2' }, { name: 'May', parent: 'Q2' }, { name: 'Jun', parent: 'Q2' },
    ],
    Entity: [{ name: 'Total Company' }, { name: 'East', parent: 'Total Company' }, { name: 'West', parent: 'Total Company' }],
    Account: [
      { name: 'Net Income' },
      { name: 'Gross Margin', parent: 'Net Income' },
      { name: 'Revenue', parent: 'Gross Margin', account_type: 'revenue' },
      { name: 'COGS', parent: 'Gross Margin', agg_op: '-', account_type: 'expense' },
      { name: 'Opex', parent: 'Net Income', agg_op: '-', account_type: 'expense' },
    ],
    Department: [{ name: 'All Departments' }, { name: 'Sales', parent: 'All Departments' }, { name: 'Operations', parent: 'All Departments' }],
    Product: [{ name: 'All Products' }, { name: 'Widgets', parent: 'All Products' }, { name: 'Gadgets', parent: 'All Products' }],
  };
  for (const [dim, list] of Object.entries(members)) {
    expectOk(await admin.put(`${base}/dimensions/${dim}/members`, { members: list }));
  }
  expectOk(await admin.post(`${base}/cubes`, { name: 'Plan', dimensions: dims.map((d) => d[0]) }), 201);
  expectOk(await admin.post(`${base}/deploy`));
  return app.app_id;
}

/** POV for the Plan cube with Account on rows and Period on columns. */
export const PLAN_POV = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' };

export function planGrid(pov: Record<string, string> = PLAN_POV, accounts = ['@idescendants(Net Income)'], periods = ['Jan', 'Feb', 'Mar', 'Q1']) {
  return { cube: 'Plan', pov, rows: { dimension: 'Account', members: accounts }, columns: { dimension: 'Period', members: periods } };
}

export { randomUUID };

/** One query as the database superuser (no row-level security), for checking what was stored. */
export async function superQuery<T = any>(h: Harness, sql: string, params: unknown[] = []): Promise<T[]> {
  const su = new pg.Client({ connectionString: h.db.superUrl });
  await su.connect();
  try {
    return (await su.query(sql, params)).rows as T[];
  } finally {
    await su.end();
  }
}
