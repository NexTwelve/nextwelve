import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Api, type Harness, createHarness, expectOk, PLAN_POV, planGrid, provisionTenant, seedPlanApp, signIn } from './helpers.js';

// Grid layout from planGrid(): rows Net Income, Gross Margin, Revenue, COGS, Opex; columns Jan, Feb, Mar, Q1.
const R = { NI: 0, GM: 1, REV: 2, COGS: 3, OPEX: 4 };
const C = { JAN: 0, FEB: 1, MAR: 2, Q1: 3 };

function withEdits(grid: any, edits: [number, number, number | string | null][]) {
  const values = grid.values.map((row: unknown[]) => [...row]);
  for (const [i, j, v] of edits) values[i][j] = v;
  return values;
}

describe('grid read, submit, audit and undo', () => {
  let h: Harness;
  let admin: Api;
  let ann: Api;
  let ben: Api;
  let appId: string;
  let base: string;

  beforeAll(async () => {
    h = await createHarness();
    await provisionTenant(h.db, 'Demo', null, 'admin@demo.test');
    admin = await signIn(h, 'admin@demo.test');
    appId = await seedPlanApp(admin);
    base = `/v1/apps/${appId}`;
    for (const email of ['ann@demo.test', 'ben@demo.test']) {
      expectOk(await admin.post('/v1/users', { email }), 201);
      expectOk(await admin.post(`${base}/roles`, { email, role: 'planner' }));
    }
    expectOk(
      await admin.put(`${base}/grants`, {
        grants: [
          { principal: { user: 'ann@demo.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' },
          { principal: { user: 'ben@demo.test' }, dimension: 'Entity', member: 'East', scope: 'member', access: 'write' },
        ],
      }),
    );
    ann = await signIn(h, 'ann@demo.test');
    ben = await signIn(h, 'ben@demo.test');
  });
  afterAll(async () => h?.close());

  it('returns an empty grid with writable leaf cells only', async () => {
    const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    expect(g.rows.members.map((m: any) => m.name)).toEqual(['Net Income', 'Gross Margin', 'Revenue', 'COGS', 'Opex']);
    expect(g.columns.members.map((m: any) => m.name)).toEqual(['Jan', 'Feb', 'Mar', 'Q1']);
    expect(g.values.flat().every((v: unknown) => v === null)).toBe(true);
    expect(g.writable).toEqual([
      [false, false, false, false],
      [false, false, false, false],
      [true, true, true, false],
      [true, true, true, false],
      [true, true, true, false],
    ]);
  });

  it('writes changed cells, then rolls them up with signs', async () => {
    const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    const res = expectOk(
      await ann.post(`${base}/grid/submit`, {
        grid_session_id: g.grid_session_id,
        comment: 'first pass',
        values: withEdits(g, [[R.REV, C.JAN, 1000], [R.REV, C.FEB, '1,100'], [R.COGS, C.JAN, 400], [R.OPEX, C.JAN, 100]]),
      }),
    );
    expect(res).toMatchObject({ cell_count: 4, ignored_readonly: 0 });
    expect(res.txn_id).toBeTypeOf('number');

    const after = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    expect(after.values[R.GM][C.JAN]).toBe(600); // 1000 - 400
    expect(after.values[R.NI][C.JAN]).toBe(500); // 600 - 100
    expect(after.values[R.REV][C.Q1]).toBe(2100);
    expect(after.values[R.NI][C.Q1]).toBe(1600);
  });

  it('logs nothing when nothing changed and ignores typing into parent cells', async () => {
    const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    const res = expectOk(
      await ann.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: withEdits(g, [[R.GM, C.JAN, 99999]]) }),
    );
    expect(res).toEqual({ txn_id: null, cell_count: 0, ignored_readonly: 1 });
  });

  it('rejects non-numeric input in writable cells', async () => {
    const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    const res = await ann.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: withEdits(g, [[R.REV, C.MAR, 'lots']]) });
    expect(res.status).toBe(422);
    expect(res.body.details.invalid).toEqual([{ row_index: R.REV, column_index: C.MAR }]);
  });

  it('detects a conflict between two planners and allows an explicit override', async () => {
    const gA = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    const gB = expectOk(await ben.post(`${base}/grid/read`, planGrid()));
    expectOk(await ann.post(`${base}/grid/submit`, { grid_session_id: gA.grid_session_id, values: withEdits(gA, [[R.REV, C.JAN, 1500]]) }));

    const clash = await ben.post(`${base}/grid/submit`, {
      grid_session_id: gB.grid_session_id,
      values: withEdits(gB, [[R.REV, C.JAN, 1600], [R.REV, C.MAR, 50]]),
    });
    expect(clash.status).toBe(409);
    expect(clash.body.details.conflicts).toEqual([{ row_index: R.REV, column_index: C.JAN, your_value: 1600, current_value: 1500 }]);
    // All-or-nothing: Ben's Mar edit was not saved either.
    const check = expectOk(await ben.post(`${base}/grid/read`, planGrid()));
    expect(check.values[R.REV][C.JAN]).toBe(1500);
    expect(check.values[R.REV][C.MAR]).toBeNull();

    const forced = expectOk(
      await ben.post(`${base}/grid/submit`, {
        grid_session_id: gB.grid_session_id,
        override: true,
        values: withEdits(gB, [[R.REV, C.JAN, 1600], [R.REV, C.MAR, 50]]),
      }),
    );
    expect(forced.cell_count).toBe(2);
  });

  it('keeps the grid session current so a planner can submit twice without refreshing', async () => {
    const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    expectOk(await ann.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: withEdits(g, [[R.OPEX, C.FEB, 120]]) }));
    const second = expectOk(
      await ann.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: withEdits(g, [[R.OPEX, C.FEB, 130]]) }),
    );
    expect(second.cell_count).toBe(1);
  });

  it('clears a cell by deleting its fact and logging a null new value', async () => {
    const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    expectOk(await ann.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: withEdits(g, [[R.OPEX, C.FEB, '']]) }));
    const after = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    expect(after.values[R.OPEX][C.FEB]).toBeNull();
    const hist = expectOk(
      await ann.post(`${base}/history`, { cube: 'Plan', cell: { ...PLAN_POV, Account: 'Opex', Period: 'Feb' } }),
    );
    expect(hist.changes.map((c: any) => [c.old_value, c.new_value])).toEqual([[130, null], [120, 130], [null, 120]]);
  });

  it('shows parent totals across entities but no writable cells there', async () => {
    const g = expectOk(await admin.post(`${base}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'West' })));
    const w = withEdits(g, [[R.REV, C.JAN, 250]]);
    expectOk(await admin.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: w }));
    // Ann holds only East, so the total is refused to her; an admin sees East + West.
    expect((await ann.post(`${base}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'Total Company' }))).status).toBe(403);
    const total = expectOk(await admin.post(`${base}/grid/read`, planGrid({ ...PLAN_POV, Entity: 'Total Company' })));
    expect(total.values[R.REV][C.JAN]).toBe(1850); // East 1600 + West 250
    expect(total.writable.flat().some(Boolean)).toBe(false);
  });

  it('returns cell history with who, when, old and new, for a leaf and for a total', async () => {
    const leaf = expectOk(
      await ann.post(`${base}/history`, { cube: 'Plan', cell: { ...PLAN_POV, Account: 'Revenue', Period: 'Jan' } }),
    );
    expect(leaf.aggregate).toBe(false);
    expect(leaf.changes.map((c: any) => [c.user, c.old_value, c.new_value])).toEqual([
      ['ben@demo.test', 1500, 1600],
      ['ann@demo.test', 1000, 1500],
      ['ann@demo.test', null, 1000],
    ]);
    expect(leaf.changes[2]).toMatchObject({ source: 'grid_submit', comment: 'first pass' });

    const total = expectOk(
      await admin.post(`${base}/history`, { cube: 'Plan', cell: { ...PLAN_POV, Entity: 'Total Company', Account: 'Gross Margin', Period: 'Q1' } }),
    );
    expect(total.aggregate).toBe(true);
    const accounts = new Set(total.changes.map((c: any) => c.cell.Account));
    expect(accounts).toEqual(new Set(['Revenue', 'COGS']));
    expect(total.changes.some((c: any) => c.cell.Entity === 'West')).toBe(true);
  });

  it('undoes a transaction, refuses when later changes exist, and allows a forced undo', async () => {
    const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    const t1 = expectOk(
      await ann.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: withEdits(g, [[R.COGS, C.MAR, 70], [R.OPEX, C.MAR, 30]]) }),
    );
    const undo = expectOk(await ann.post(`${base}/txns/${t1.txn_id}/undo`, {}));
    expect(undo.cell_count).toBe(2);
    let now = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    expect(now.values[R.COGS][C.MAR]).toBeNull();

    const t2 = expectOk(
      await ann.post(`${base}/grid/submit`, { grid_session_id: now.grid_session_id, values: withEdits(now, [[R.COGS, C.MAR, 80]]) }),
    );
    now = expectOk(await ben.post(`${base}/grid/read`, planGrid()));
    expectOk(await ben.post(`${base}/grid/submit`, { grid_session_id: now.grid_session_id, values: withEdits(now, [[R.COGS, C.MAR, 90]]) }));

    // Ben can't undo Ann's transaction at all; Ann is blocked by Ben's later change.
    expect((await ben.post(`${base}/txns/${t2.txn_id}/undo`, {})).status).toBe(403);
    const blocked = await ann.post(`${base}/txns/${t2.txn_id}/undo`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.details).toHaveLength(1);
    const forced = expectOk(await ann.post(`${base}/txns/${t2.txn_id}/undo`, { force: true }));
    expect(forced.cell_count).toBe(1);
    now = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    expect(now.values[R.COGS][C.MAR]).toBeNull();

    const txns = expectOk(await ann.get(`${base}/txns?limit=3`));
    expect(txns.txns[0]).toMatchObject({ source: 'undo', user: 'ann@demo.test', comment: `forced undo of txn ${t2.txn_id}` });
  });

  it('refuses a stale grid after dimensions are redeployed', async () => {
    const g = expectOk(await ann.post(`${base}/grid/read`, planGrid()));
    expectOk(await admin.put(`${base}/dimensions/Account/members`, { members: [{ name: 'Other Income', parent: 'Net Income' }] }));
    expectOk(await admin.post(`${base}/deploy`));
    const res = await ann.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: withEdits(g, [[R.REV, C.MAR, 1]]) });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/refresh/);
  });

  it('verifies the hash chain, and detects a tampered audit row', async () => {
    const ok = expectOk(await admin.post(`${base}/audit/verify`));
    expect(ok.ok).toBe(true);
    expect(ok.checked).toBeGreaterThan(8);
    expect((await ann.post(`${base}/audit/verify`)).status).toBe(403);

    // Someone with database superuser rights edits history directly.
    const su = new pg.Client({ connectionString: h.db.superUrl });
    await su.connect();
    await su.query(
      `update epm.cell_audit set new_value = 1 where txn_id = (select min(txn_id) from epm.change_txn where app_id = $1)`,
      [appId],
    );
    await su.end();
    const broken = expectOk(await admin.post(`${base}/audit/verify`));
    expect(broken).toMatchObject({ ok: false, broken_at: 1, reason: 'content' });
  });

  it('keeps another tenant out of this application entirely', async () => {
    await provisionTenant(h.db, 'Other Co', null, 'admin@other.test');
    const other = await signIn(h, 'admin@other.test');
    expect((await other.post(`${base}/grid/read`, planGrid())).status).toBe(404);
    expect((await other.get(`${base}/txns`)).status).toBe(404);
    expect((await other.post(`${base}/history`, { cube: 'Plan', cell: {} })).status).toBe(404);
    expect((await other.put(`${base}/dimensions/Account/members`, { members: [{ name: 'X' }] })).status).toBe(404);
  });

  it('does not let a viewer submit', async () => {
    expectOk(await admin.post('/v1/users', { email: 'vic@demo.test' }), 201);
    expectOk(await admin.post(`${base}/roles`, { email: 'vic@demo.test', role: 'viewer' }));
    expectOk(await admin.put(`${base}/grants`, { grants: [{ principal: { user: 'vic@demo.test' }, dimension: 'Entity', member: 'Total Company', access: 'write' }] }));
    const vic = await signIn(h, 'vic@demo.test');
    const g = expectOk(await vic.post(`${base}/grid/read`, planGrid({ ...PLAN_POV })));
    expect(g.writable.flat().some(Boolean)).toBe(false);
    expect((await vic.post(`${base}/grid/submit`, { grid_session_id: g.grid_session_id, values: g.values })).status).toBe(403);
  });
});
