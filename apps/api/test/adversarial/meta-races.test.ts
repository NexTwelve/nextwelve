import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ApiResponse } from '../helpers.js';
import { byDim, expectOk, type MetaEnv, setupMeta } from './meta-helpers.js';

/**
 * A metadata restore racing other work. The restore locks the application row FOR UPDATE; member
 * and definition edits take FOR SHARE and deploys FOR UPDATE, so they wait. Cell writes
 * (apply_changes) take no lock on the application. The interleavings are forced with query hooks
 * on the restore's own statements (each runs twice: the preview, then the real run).
 */
describe('adversarial: metadata restore races', () => {
  let env: MetaEnv;

  /** Run fn just before the n-th statement starting with prefix (1 = the preview, 2 = the real run). */
  function before(prefix: string, n: number, fn: () => Promise<void>) {
    let seen = 0;
    env.h.queryHooks.push(async (sql) => {
      if (!sql.trimStart().startsWith(prefix)) return;
      seen++;
      if (seen === n) await fn();
    });
  }
  async function waitForLockWait(like: string) {
    for (let i = 0; i < 250; i++) {
      const r = await env.su.query(
        `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like $1`, [like]);
      if (r.rowCount) return;
      await env.pause(20);
    }
    throw new Error(`nothing waited on a lock running ${like}`);
  }
  const mark = async () => {
    await env.pause();
    const t = await env.now();
    await env.pause();
    return t;
  };

  beforeAll(async () => {
    env = await setupMeta('mrace');
  });
  beforeEach(() => {
    env.h.queryHooks.length = 0;
    env.h.unexpected.length = 0;
  });
  afterAll(async () => env?.close());

  it('a member edit sent while a restore runs waits for it, then lands (saved, not deployed) on the restored tree', async () => {
    const a = await env.newApp('Race Edit');
    const t = await mark();
    await a.del('Product', 'Gadgets');
    await a.deploy();
    let edit: Promise<ApiResponse> | null = null;
    before('select epm.deploy_metadata', 2, async () => {
      edit = env.admin.put(`${a.base}/dimensions/Product/members`, { members: [{ name: 'Late', parent: 'All Products' }] });
      await waitForLockWait('%for share%');
    });
    const r = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false }));
    expect(byDim(r).Product.recreated).toEqual(['Gadgets']);
    expect(edit).not.toBeNull();
    expectOk(await edit!);
    expect(await a.member('Product', 'Gadgets')).toMatchObject({ deployed: true });
    expect(await a.member('Product', 'Late')).toMatchObject({ deployed: false, parent: 'All Products' });
    expect(env.h.unexpected).toEqual([]);
  });

  it('a deploy sent while a restore runs waits for it, then deploys on top; the closure stays consistent', async () => {
    const a = await env.newApp('Race Deploy');
    const t = await mark();
    await a.del('Product', 'Gadgets');
    await a.deploy();
    let dep: Promise<ApiResponse> | null = null;
    before('select epm.deploy_metadata', 2, async () => {
      dep = env.admin.post(`${a.base}/deploy`);
      await waitForLockWait('%deploy_metadata($1) as result%');
    });
    const r = expectOk(await a.restore({ at: t, dimensions: ['Product'], definitions: false }));
    const d = expectOk(await dep!);
    expect(d.metadata_rev).toBe(r.members.metadata_rev + 1);
    expect(await a.member('Product', 'Gadgets')).toMatchObject({ deployed: true });
    expect(await a.closureMismatch()).toBe(0);
  });

  it('two restores to the same moment at once: no 500, and the tree ends as it was then', async () => {
    const a = await env.newApp('Race Twice');
    const t = await mark();
    await a.del('Product', 'Gadgets');
    await a.put('Product', [{ name: 'Gizmos', parent: 'All Products' }]);
    await a.deploy();
    const rs = await Promise.all([1, 2].map(() => a.restore({ at: t, dimensions: ['Product'], definitions: false })));
    expect(rs.map((x) => x.status).filter((s) => s !== 200 && s !== 409)).toEqual([]);
    expect(env.h.unexpected).toEqual([]);
    expect((await a.tree('Product')).map((m) => m.name).sort()).toEqual(['All Products', 'Gadgets', 'Widgets']);
    expect(await a.closureMismatch()).toBe(0);
  });

  it('a plan window set on a member the restore is about to remove waits (its key-share lock on the application row) and then fails cleanly', async () => {
    const a = await env.newApp('Race Window');
    const t = await mark();
    await a.put('Version', [{ name: 'V2' }]);
    await a.deploy();
    let win: Promise<ApiResponse> | null = null;
    before('delete from epm.member where member_id = any', 2, async () => {
      win = env.admin.put(`${a.base}/plan-windows`, { scenario: 'Budget', version: 'V2', years: 'FY27', locked: true });
      await waitForLockWait('%insert into epm.plan_window%');
    });
    const r = expectOk(await a.restore({ at: t, dimensions: ['Version'], definitions: false }));
    expect(byDim(r).Version.removed).toEqual(['V2']);
    const w = await win!;
    expect(w.status).toBe(422);
    expect(env.h.unexpected).toEqual([]);
    expect(await a.member('Version', 'V2')).toBeUndefined();
    expect((await env.su.query('select 1 from epm.plan_window where app_id = $1', [a.appId])).rowCount).toBe(0);
  });

  it('FINDING: a cell written to a new member after the restore deleted it (before the restore commits) is orphaned: the write succeeds, the member is gone', async () => {
    const a = await env.newApp('Race Orphan After');
    const t = await mark();
    await a.put('Product', [{ name: 'Gizmos', parent: 'All Products' }]);
    await a.deploy();
    let w: Promise<unknown> | null = null;
    before('select epm.deploy_metadata', 2, async () => {
      // A planner's write while the restore (which has already deleted Gizmos) is still running. Today it is
      // accepted at once: apply_changes still sees Gizmos (the delete is not committed) and waits on no lock.
      w = a.write([{ at: { Product: 'Gizmos' }, v: 42 }]).catch((e: unknown) => e);
      await Promise.race([w, env.pause(1000)]);
    });
    const r = await a.restore({ at: t, dimensions: ['Product'], definitions: false });
    expect([200, 409]).toContain(r.status);
    await w;
    // Either the write waits and is then refused, or the member it went to survives: never data on a member that is gone.
    expect(await a.orphanFacts()).toBe(0);
  });

  it('FINDING: a cell written to a new member between the restore\'s "holds no data" check and its delete is orphaned', async () => {
    const a = await env.newApp('Race Orphan Before');
    const t = await mark();
    await a.put('Product', [{ name: 'Gizmos', parent: 'All Products' }]);
    await a.deploy();
    let w: Promise<unknown> | null = null;
    before('delete from epm.member where member_id = any', 2, async () => {
      w = a.write([{ at: { Product: 'Gizmos' }, v: 42 }]).catch((e: unknown) => e);
      await Promise.race([w, env.pause(1000)]);
    });
    const r = await a.restore({ at: t, dimensions: ['Product'], definitions: false });
    expect([200, 409]).toContain(r.status);
    await w;
    expect(await a.orphanFacts()).toBe(0);
  });
});
