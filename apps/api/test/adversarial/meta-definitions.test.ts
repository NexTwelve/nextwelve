import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rewriteSnapshot } from './fix-helpers.js';
import { expectOk, type MetaEnv, setupMeta } from './meta-helpers.js';

const POV = { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East', Department: 'Sales', Product: 'Widgets' };
const form = (months: string[], account = 'Revenue') => ({
  cube: 'Plan', definition: { pov: POV, rows: { dimension: 'Account', members: [account] }, columns: { dimension: 'Period', members: months } },
});
const report = (months: string[]) => ({
  cube: 'Plan', definition: { pov: { ...POV }, rows: [{ dimension: 'Account', members: ['Revenue'] }], columns: { dimension: 'Period', members: months } },
});

/**
 * Form and report definitions through history and metadata restore: deleted and recreated under
 * the same name, invalid saved definitions, a cube that is gone, snapshots from before reports
 * were kept, and putting single versions back.
 */
describe('adversarial: definition history and restore', () => {
  let env: MetaEnv;
  /** One statement as the database superuser, inside the tenant's context (as maintenance SQL would run). */
  const asTenant = async (sql: string, params: unknown[]) => {
    await env.su.query('begin');
    try {
      await env.su.query("select set_config('app.tenant_id', $1, true)", [env.tenantId]);
      await env.su.query(sql, params);
      await env.su.query('commit');
    } catch (e) {
      await env.su.query('rollback');
      throw e;
    }
  };
  const mark = async () => {
    await env.pause();
    const t = await env.now();
    await env.pause();
    return t;
  };

  beforeAll(async () => {
    env = await setupMeta('mdef');
  });
  afterAll(async () => env?.close());

  it('deleted then recreated under the same name: each moment restores the right content; the original id comes back once the name is free', async () => {
    const a = await env.newApp('Defs Recreated');
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, form(['Jan'])));
    const id1 = (await env.su.query<{ id: string }>(`select form_id as id from epm.form where app_id = $1`, [a.appId])).rows[0]!.id;
    const t1 = await mark();
    expectOk(await env.admin.del(`${a.base}/forms/Entry`));
    const t2 = await mark();
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, form(['Feb'])));
    const id2 = (await env.su.query<{ id: string }>(`select form_id as id from epm.form where app_id = $1`, [a.appId])).rows[0]!.id;
    expect(id2).not.toBe(id1);
    const hist = expectOk(await env.admin.get(`${a.base}/forms/Entry/history`)).history;
    expect(hist.map((x: any) => [x.artifact_id === id1 ? 'id1' : 'id2', x.version, x.deleted, x.current])).toEqual([
      ['id2', 1, false, true], ['id1', 2, true, false], ['id1', 1, false, false],
    ]);

    // Between the deletion and the new one: the new one is "created since".
    const between = expectOk(await a.restore({ at: t2, members: false, dry_run: true }));
    expect(between.definitions.kept_new).toEqual([{ type: 'form', name: 'Entry' }]);
    expectOk(await a.restore({ at: t2, members: false, remove_new_definitions: true }));
    expect((await env.admin.get(`${a.base}/forms/Entry`)).status).toBe(404);
    // Back to t1: the name is free, so the old form returns under its own id with its history continued.
    const back = expectOk(await a.restore({ at: t1, members: false }));
    expect(back.definitions.created).toEqual([{ type: 'form', name: 'Entry' }]);
    const f = expectOk(await env.admin.get(`${a.base}/forms/Entry`));
    expect(f.form_id).toBe(id1);
    expect(f.definition.columns).toEqual([{ dimension: 'Period', members: ['Jan'] }]);
    const h2 = expectOk(await env.admin.get(`${a.base}/forms/Entry/history`)).history;
    expect(h2[0]).toMatchObject({ artifact_id: id1, version: 3, deleted: false, current: true });
  });

  it('an invalid saved definition in history is reported, not restored; the current definition stays', async () => {
    const a = await env.newApp('Defs Invalid');
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, form(['Jan'])));
    await asTenant(`update epm.form set definition = '{"rows": 5}' where app_id = $1`, [a.appId]);
    const t = await mark();
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, form(['Feb'])));
    const r = expectOk(await a.restore({ at: t, members: false }));
    expect(r.definitions.invalid).toEqual([{ type: 'form', name: 'Entry', message: expect.stringMatching(/not valid/) }]);
    expect(r.changes).toBe(0);
    expect(expectOk(await env.admin.get(`${a.base}/forms/Entry`)).definition.columns).toEqual([{ dimension: 'Period', members: ['Feb'] }]);
    // Nor through the history route.
    const v = expectOk(await env.admin.get(`${a.base}/forms/Entry/history`)).history.find((x: any) => x.version === 2);
    expect((await env.admin.post(`${a.base}/forms/Entry/history/restore`, { artifact_id: v.artifact_id, version: 2 })).status).toBe(422);
  });

  it('a definition whose cube is gone is reported, not restored', async () => {
    const a = await env.newApp('Defs Cube Gone');
    expectOk(await env.admin.post(`${a.base}/cubes`, { name: 'Ops', dimensions: ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account'] }), 201);
    expectOk(await env.admin.put(`${a.base}/forms/OpsForm`, {
      cube: 'Ops', definition: { pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } },
    }));
    const t = await mark();
    await asTenant(`delete from epm.cube where app_id = $1 and name = 'Ops'`, [a.appId]);
    const hist = expectOk(await env.admin.get(`${a.base}/forms/OpsForm/history`)).history;
    expect(hist[0]).toMatchObject({ deleted: true, cube: null });
    const r = expectOk(await a.restore({ at: t, members: false }));
    expect(r.definitions.invalid).toEqual([{ type: 'form', name: 'OpsForm', message: expect.stringMatching(/cube no longer exists/) }]);
    expect((await env.admin.post(`${a.base}/forms/OpsForm/history/restore`, { artifact_id: hist[1].artifact_id, version: 1 })).status).toBe(422);
  });

  it('a snapshot from before reports were kept (format 2) leaves reports alone and still restores forms', async () => {
    const a = await env.newApp('Defs Format 2');
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, form(['Jan'])));
    expectOk(await env.admin.put(`${a.base}/reports/Margin`, report(['Q1'])));
    const snap = expectOk(await env.admin.post(`${a.base}/snapshots`, {}), 201);
    await rewriteSnapshot(env.h.store, env.su, snap.snapshot_id, {
      schemaVer: 2,
      meta: ({ reports: _r, ...m }) => ({ ...m, forms: m.forms.map(({ id: _id, ...f }: any) => f) }),
    });
    expectOk(await env.admin.del(`${a.base}/forms/Entry`));
    expectOk(await env.admin.put(`${a.base}/reports/Margin`, report(['Q2'])));

    const r = expectOk(await a.restore({ snapshot_id: snap.snapshot_id, members: false, remove_new_definitions: true }));
    expect(r.definitions.created).toEqual([{ type: 'form', name: 'Entry' }]);
    expect(r.definitions.removed).toEqual([]);
    expect(r.definitions.notes.join(' ')).toMatch(/no reports/);
    expect(expectOk(await env.admin.get(`${a.base}/reports/Margin`)).definition.columns).toEqual([{ dimension: 'Period', members: ['Q2'] }]);
  });

  it('a format 3 snapshot brings a deleted report and form back under their original ids', async () => {
    const a = await env.newApp('Defs Format 3');
    expectOk(await env.admin.put(`${a.base}/forms/Entry`, form(['Jan'])));
    expectOk(await env.admin.put(`${a.base}/reports/Margin`, report(['Q1'])));
    const formId = expectOk(await env.admin.get(`${a.base}/forms/Entry`)).form_id;
    const reportId = expectOk(await env.admin.get(`${a.base}/reports/Margin`)).report_id;
    const snap = expectOk(await env.admin.post(`${a.base}/snapshots`, {}), 201);
    expectOk(await env.admin.del(`${a.base}/forms/Entry`));
    expectOk(await env.admin.del(`${a.base}/reports/Margin`));
    expectOk(await a.restore({ snapshot_id: snap.snapshot_id, members: false }));
    expect(expectOk(await env.admin.get(`${a.base}/forms/Entry`)).form_id).toBe(formId);
    expect(expectOk(await env.admin.get(`${a.base}/reports/Margin`)).report_id).toBe(reportId);
  });

  it('putting a version back: a deleted report returns under its id; a version that no longer fits the metadata is refused', async () => {
    const a = await env.newApp('Defs Version');
    expectOk(await env.admin.put(`${a.base}/reports/Margin`, report(['Q1'])));
    expectOk(await env.admin.put(`${a.base}/reports/Margin`, report(['Q1', 'Q2'])));
    const id = expectOk(await env.admin.get(`${a.base}/reports/Margin`)).report_id;
    expectOk(await env.admin.del(`${a.base}/reports/Margin`));
    const back = expectOk(await env.admin.post(`${a.base}/reports/Margin/history/restore`, { artifact_id: id, version: 1 }));
    expect(back).toMatchObject({ name: 'Margin', version: 4, created: true });
    const r = expectOk(await env.admin.get(`${a.base}/reports/Margin`));
    expect(r.report_id).toBe(id);
    expect(r.definition.columns).toEqual([{ dimension: 'Period', members: ['Q1'] }]);
    expect((await env.admin.post(`${a.base}/reports/Margin/history/restore`, { artifact_id: id, version: 3 })).status).toBe(422); // the deletion

    // A form on a member deleted since.
    expectOk(await env.admin.put(`${a.base}/forms/Gadget Entry`, { ...form(['Jan']), definition: { ...form(['Jan']).definition, pov: { ...POV, Product: 'Gadgets' } } }));
    const fid = expectOk(await env.admin.get(`${a.base}/forms/Gadget Entry`)).form_id;
    expectOk(await env.admin.put(`${a.base}/forms/Gadget Entry`, form(['Feb'])));
    await a.del('Product', 'Gadgets');
    await a.deploy();
    expect((await env.admin.post(`${a.base}/forms/Gadget Entry/history/restore`, { artifact_id: fid, version: 1 })).status).toBe(422);
  });

  it('the nightly digest (app_fingerprint) notices a report saved, changed or deleted', async () => {
    const a = await env.newApp('Defs Digest');
    const fp = async () => (await env.su.query<{ f: string }>('select epm.app_fingerprint($1) as f', [a.appId])).rows[0]!.f;
    const f0 = await fp();
    expectOk(await env.admin.put(`${a.base}/reports/Margin`, report(['Q1'])));
    const f1 = await fp();
    expectOk(await env.admin.put(`${a.base}/reports/Margin`, report(['Q2'])));
    const f2 = await fp();
    expectOk(await env.admin.del(`${a.base}/reports/Margin`));
    expect(new Set([f0, f1, f2]).size).toBe(3);
    expect(await fp()).toBe(f0);
  });

  it('FINDING: a form deleted outside a tenant context (a cascade from maintenance SQL) leaves no history, so no restore can bring it back', async () => {
    const a = await env.newApp('Defs No Tenant');
    expectOk(await env.admin.post(`${a.base}/cubes`, { name: 'Ops', dimensions: ['Scenario', 'Version', 'Years', 'Period', 'Entity', 'Account'] }), 201);
    expectOk(await env.admin.put(`${a.base}/forms/OpsForm`, {
      cube: 'Ops', definition: { pov: { Scenario: 'Budget', Version: 'Working', Years: 'FY27', Entity: 'East' }, rows: { dimension: 'Account', members: ['Revenue'] }, columns: { dimension: 'Period', members: ['Jan'] } },
    }));
    // An UPDATE without a tenant context is refused by the history trigger (row-level security on artifact_version) ...
    await expect(env.su.query(`update epm.form set description = 'x' where app_id = $1`, [a.appId])).rejects.toThrow(/row-level security|tenant in the session/);
    // ... but a DELETE goes through: the trigger's "does the application still exist" check sees no application
    // under forced row-level security, takes it for an application being dropped, and logs nothing.
    const deleted = await env.su.query(`delete from epm.cube where app_id = $1 and name = 'Ops'`, [a.appId]).then(() => true, () => false);
    if (deleted) {
      const rows = await env.su.query(`select 1 from epm.artifact_version where app_id = $1 and name = 'OpsForm' and deleted`, [a.appId]);
      expect(rows.rowCount).toBe(1);
    }
  });
});
