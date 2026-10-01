import { withSession } from '../db.js';
import { GridSpec, readGrid } from '../grid/read.js';
import { SubmitBody, submitGrid } from '../grid/submit.js';
import { requireApp } from '../model.js';
import { type App, clientInfo, type Deps, readJson, sessionOf } from './context.js';

export function gridRoutes(app: App, deps: Deps) {
  app.post('/v1/apps/:appId/grid/read', async (c) => {
    const s = sessionOf(c);
    const spec = GridSpec.parse(await readJson(c));
    return c.json(
      await withSession(deps.db, s, async (q) => {
        const ctx = await requireApp(q, c.req.param('appId'), 'viewer');
        return readGrid(q, ctx, s, spec);
      }),
    );
  });

  app.post('/v1/apps/:appId/grid/submit', async (c) => {
    const s = sessionOf(c);
    const body = SubmitBody.parse(await readJson(c));
    return c.json(
      await withSession(deps.db, s, async (q) => {
        const ctx = await requireApp(q, c.req.param('appId'), 'planner');
        return submitGrid(q, ctx, s, { ...body, client: clientInfo(c, body.client) });
      }),
    );
  });
}
