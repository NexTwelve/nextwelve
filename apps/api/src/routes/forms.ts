import { withSession } from '../db.js';
import { FormBody, loadForm, OpenBody, openForm, saveForm } from '../forms.js';
import { lockForEdit, requireApp } from '../model.js';
import { type App, type Deps, readJson, sessionOf } from './context.js';

export function formRoutes(app: App, deps: Deps) {
  app.get('/v1/apps/:appId/forms', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(deps.db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'viewer');
        const res = await c.query(
          `select f.name, f.folder, f.description, cu.name as cube,
                  coalesce((f.definition->>'read_only')::boolean, false) as read_only, f.version, f.updated_at
             from epm.form f join epm.cube cu on cu.cube_id = f.cube_id
            where f.app_id = $1 order by f.folder nulls first, f.name`,
          [hc.req.param('appId')],
        );
        return { forms: res.rows };
      }),
    );
  });

  app.get('/v1/apps/:appId/forms/:name', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(deps.db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'viewer');
        return loadForm(c, hc.req.param('appId'), hc.req.param('name'));
      }),
    );
  });

  // Create or replace a form (power users and admins).
  app.put('/v1/apps/:appId/forms/:name', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(deps.db, s, async (c) => {
        const appId = hc.req.param('appId');
        await requireApp(c, appId, 'power_user');
        const body = FormBody.parse(await readJson(hc));
        await lockForEdit(c, appId);
        return saveForm(c, s, appId, hc.req.param('name'), body);
      }),
    );
  });

  app.delete('/v1/apps/:appId/forms/:name', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(deps.db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'power_user');
        await lockForEdit(c, hc.req.param('appId'));
        const form = await loadForm(c, hc.req.param('appId'), hc.req.param('name'));
        await c.query('delete from epm.form where form_id = $1', [form.form_id]);
        return { deleted: form.name };
      }),
    );
  });

  // Open a form for data entry: pick page members, get the grid and a grid_session_id for submit.
  app.post('/v1/apps/:appId/forms/:name/open', async (hc) => {
    const s = sessionOf(hc);
    const body = OpenBody.parse(await readJson(hc));
    return hc.json(
      await withSession(deps.db, s, async (c) => {
        const ctx = await requireApp(c, hc.req.param('appId'), 'viewer');
        const form = await loadForm(c, ctx.appId, hc.req.param('name'));
        return openForm(c, ctx, s, form, body.page);
      }),
    );
  });
}
