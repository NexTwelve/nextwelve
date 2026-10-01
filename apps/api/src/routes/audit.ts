import { z } from 'zod';
import { maybeOne, withSession } from '../db.js';
import { HttpError } from '../errors.js';
import { COORD_LENGTH, leafIds, loadAccess, loadCube, requireApp, resolveMembers } from '../model.js';
import { type App, type Deps, readJson, sessionOf } from './context.js';

const HistoryBody = z.object({
  cube: z.string().min(1),
  cell: z.record(z.string(), z.string()),
  limit: z.number().int().min(1).max(1000).default(200),
});
const UndoBody = z.object({ force: z.boolean().default(false) });

export function auditRoutes(app: App, deps: Deps) {
  // Who changed a cell, when, from what to what. A parent cell returns changes to its leaves.
  app.post('/v1/apps/:appId/history', async (hc) => {
    const s = sessionOf(hc);
    const body = HistoryBody.parse(await readJson(hc));
    return hc.json(await withSession(deps.db, s, async (c) => {
      const ctx = await requireApp(c, hc.req.param('appId'), 'viewer');
      const cube = await loadCube(c, ctx.appId, body.cube);
      const given = new Map(Object.entries(body.cell).map(([k, v]) => [k.toLowerCase(), v]));
      const access = ctx.isAdmin
        ? null
        : await loadAccess(c, ctx.appId, s.userId, cube.dims.filter((d) => d.secured).map((d) => d.dimId));

      const params: unknown[] = [ctx.appId, cube.cubeId];
      const filters: string[] = [];
      const k = new Array<number>(COORD_LENGTH).fill(0);
      k[0] = cube.cubeId;
      let allLeaves = true;
      for (const dim of cube.dims) {
        const name = given.get(dim.name.toLowerCase());
        if (!name) throw new HttpError(422, `cell is missing dimension ${dim.name}`);
        const [member] = await resolveMembers(c, dim, [name]);
        const readable = (id: number) => !access || !dim.secured || access.get(dim.dimId)!.has(id);
        if (!readable(member!.id)) throw new HttpError(403, `no read access to ${dim.name} ${member!.name}`);
        k[dim.pos] = member!.id;
        if (!member!.isLeaf) allLeaves = false;
        const leaves = (await leafIds(c, member!.id)).filter(readable);
        params.push(leaves);
        filters.push(`a.coords[${dim.pos + 1}] = any($${params.length}::int[])`);
      }

      // A leaf cell is one index lookup by cell_key; a total filters coordinates by leaf sets.
      let where: string;
      if (allLeaves) {
        params.length = 1;
        params.push(k);
        where = 'a.cell_key = epm.cell_key($2::int[])';
      } else {
        where = `a.coords[1] = $2::int and ${filters.join(' and ')}`;
      }
      params.push(body.limit);
      const res = await c.query<{
        txn_id: number; coords: number[]; old_value: number | null; new_value: number | null; changed_at: string;
        source: string; source_ref: string | null; comment: string | null; user_email: string | null; surface: string | null;
      }>(
        `select a.txn_id, a.coords, a.old_value, a.new_value,
                to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as changed_at, t.source, t.source_ref, t.comment,
                u.email as user_email, t.client->>'surface' as surface
           from epm.cell_audit a
           join epm.change_txn t on t.txn_id = a.txn_id
           left join epm.app_user u on u.user_id = t.user_id
          where a.app_id = $1 and ${where}
          order by t.chain_seq desc, a.cell_key
          limit $${params.length}`,
        params,
      );

      // Translate coordinates back to member names.
      const ids = [...new Set(res.rows.flatMap((r) => r.coords.slice(1)))].filter((x) => x !== 0);
      const names = new Map<number, string>();
      if (ids.length) {
        const m = await c.query<{ member_id: number; name: string }>(
          'select member_id, name from epm.member where member_id = any($1::int[])',
          [ids],
        );
        for (const r of m.rows) names.set(r.member_id, r.name);
      }
      return {
        cell: body.cell,
        aggregate: !allLeaves,
        changes: res.rows.map((r) => ({
          txn_id: r.txn_id,
          changed_at: r.changed_at,
          user: r.user_email,
          source: r.source,
          surface: r.surface,
          source_ref: r.source_ref,
          comment: r.comment,
          old_value: r.old_value,
          new_value: r.new_value,
          cell: Object.fromEntries(cube.dims.map((d) => [d.name, names.get(r.coords[d.pos]!) ?? null])),
        })),
      };
    }));
  });

  app.get('/v1/apps/:appId/txns', async (hc) => {
    const s = sessionOf(hc);
    const limit = Math.min(Math.max(Number(hc.req.query('limit') ?? 50) || 50, 1), 500);
    return hc.json(await withSession(deps.db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'viewer');
      const res = await c.query(
        `select t.txn_id, t.chain_seq, t.source, t.source_ref, t.comment, t.cell_count,
                to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at, u.email as user
           from epm.change_txn t left join epm.app_user u on u.user_id = t.user_id
          where t.app_id = $1 order by t.chain_seq desc limit $2`,
        [hc.req.param('appId'), limit],
      );
      return { txns: res.rows };
    }));
  });

  app.post('/v1/apps/:appId/txns/:txnId/undo', async (hc) => {
    const s = sessionOf(hc);
    const body = UndoBody.parse(await readJson(hc));
    const txnId = Number(hc.req.param('txnId'));
    if (!Number.isSafeInteger(txnId)) throw new HttpError(404, 'transaction not found');
    return hc.json(await withSession(deps.db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'planner');
      const t = await maybeOne(c, 'select 1 from epm.change_txn where txn_id = $1 and app_id = $2', [txnId, hc.req.param('appId')]);
      if (!t) throw new HttpError(404, 'transaction not found');
      const res = await c.query<{ result: unknown }>('select epm.undo_txn($1, $2) as result', [txnId, body.force]);
      return res.rows[0]!.result;
    }));
  });

  app.post('/v1/apps/:appId/audit/verify', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(deps.db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      const res = await c.query<{ result: unknown }>('select epm.verify_chain($1) as result', [hc.req.param('appId')]);
      return res.rows[0]!.result;
    }));
  });
}
