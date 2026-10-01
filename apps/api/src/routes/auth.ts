import { z } from 'zod';
import { maybeOne, withoutSession, withSession } from '../db.js';
import { demoInfo } from '../demo.js';
import { HttpError } from '../errors.js';
import { type App, type Deps, readJson, sessionOf } from './context.js';

const SessionBody = z.object({ id_token: z.string().min(20) });

export function authRoutes(app: App, deps: Deps) {
  // Exchange a Google ID token for a short-lived NexTwelve session token (public route).
  app.post('/v1/auth/session', async (c) => {
    const body = SessionBody.parse(await readJson(c));
    const id = await deps.verifier(body.id_token);
    const row = await withoutSession(deps.db, (q) =>
      maybeOne<{ user_id: string; tenant_id: string; status: string }>(
        q,
        'select user_id, tenant_id, status from epm.resolve_login($1, $2, $3, $4)',
        [id.sub, id.email, id.hd, id.emailVerified],
      ),
    );
    if (!row) throw new HttpError(403, 'this Google account has not been invited to NexTwelve');
    if (row.status !== 'active') throw new HttpError(403, 'this user is disabled');
    const s = await deps.signer.issue({ userId: row.user_id, tenantId: row.tenant_id });
    return c.json({
      session_token: s.token,
      expires_in: s.expiresIn,
      user_id: row.user_id,
      tenant_id: row.tenant_id,
      email: id.email,
    });
  });

  app.get('/v1/me', async (c) => {
    const s = sessionOf(c);
    return c.json(
      await withSession(deps.db, s, async (q) => {
        const me = await maybeOne<{ user_id: string; email: string; display_name: string | null; tenant: string }>(
          q,
          `select u.user_id, u.email, u.display_name, t.name as tenant
             from epm.app_user u join epm.tenant t on t.tenant_id = u.tenant_id
            where u.user_id = $1`,
          [s.userId],
        );
        const roles = await q.query<{ app_id: string | null; app: string | null; role: string }>(
          `select r.app_id, a.name as app, r.role
             from epm.user_role r left join epm.application a on a.app_id = r.app_id
            where r.user_id = $1 order by a.name nulls first`,
          [s.userId],
        );
        return { ...me, roles: roles.rows, demo: me ? await demoInfo(q, s, me.email) : null, read_only: !!s.readOnly };
      }),
    );
  });
}
