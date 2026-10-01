import { z } from 'zod';
import { type Client, maybeOne, one, requireRole, withSession } from '../db.js';
import { HttpError } from '../errors.js';
import { FIXED_DIMS, OPTIONAL_DIMS, type DimInfo, loadDimension, loadDimensions, lockForEdit, requireApp } from '../model.js';
import { type App, type Deps, readJson, sessionOf } from './context.js';

const Email = z.email().transform((e) => e.toLowerCase());
const Name = z.string().trim().min(1).max(200);

async function securityEvent(c: Client, tenantId: string, userId: string, appId: string | null, type: string, detail: unknown) {
  await c.query(
    'insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, $4, $5)',
    [tenantId, appId, userId, type, detail],
  );
}

async function userByEmail(c: Client, email: string): Promise<{ user_id: string; status: string }> {
  return one(c, 'select user_id, status from epm.app_user where lower(email) = lower($1)', [email], `no user with email ${email}`);
}

async function rebuildAllApps(c: Client) {
  const apps = await c.query<{ app_id: string }>('select app_id from epm.application');
  for (const a of apps.rows) await c.query('select epm.rebuild_effective_access($1)', [a.app_id]);
}

async function memberIdByName(c: Client, dim: DimInfo, name: string): Promise<{ member_id: number; is_leaf: boolean }> {
  return one(
    c,
    'select member_id, is_leaf from epm.member where dim_id = $1 and lower(name) = lower($2)',
    [dim.dimId, name],
    `${dim.name} has no member named ${name}`,
  );
}

// ---------------------------------------------------------------------------
// Users, groups, applications (tenant level)
// ---------------------------------------------------------------------------
const InviteBody = z.object({ email: Email, display_name: z.string().max(200).optional() });
const UserPatch = z.object({ status: z.enum(['active', 'disabled']) });
const AppBody = z.object({ name: Name });
const GroupBody = z.object({ name: Name });
const GroupMembersBody = z.object({ emails: z.array(Email) });

// ---------------------------------------------------------------------------
// Application metadata
// ---------------------------------------------------------------------------
const RoleBody = z.object({ email: Email, role: z.enum(['app_admin', 'power_user', 'planner', 'viewer']) });
const DimensionBody = z.object({
  name: Name,
  type: z.enum([...FIXED_DIMS, ...OPTIONAL_DIMS, 'custom']),
  slot: z.number().int().min(1).max(8).optional(),
  secured: z.boolean().default(false),
});
const DimensionPatch = z.object({ secured: z.boolean() });
const MemberInput = z.object({
  name: Name,
  parent: z.string().trim().min(1).nullable().optional(),
  alias: z.string().max(200).nullable().optional(),
  agg_op: z.enum(['+', '-', '~']).optional(),
  sort_order: z.number().int().optional(),
  account_type: z.enum(['revenue', 'expense', 'asset', 'liability', 'equity', 'saved_assumption']).nullable().optional(),
  time_balance: z.enum(['flow', 'first', 'last', 'average']).nullable().optional(),
  formula: z.string().max(4000).nullable().optional(),
});
const MembersBody = z.object({ members: z.array(MemberInput).min(1).max(20_000) });
const CubeBody = z.object({ name: Name, dimensions: z.array(Name).min(6) });
const GrantInput = z.object({
  principal: z.union([z.object({ user: Email }), z.object({ group: Name })]),
  dimension: Name,
  member: Name,
  scope: z.enum(['member', 'children', 'ichildren', 'descendants', 'idescendants']).default('idescendants'),
  access: z.enum(['none', 'read', 'write']),
});
const GrantsBody = z.object({ replace: z.boolean().default(false), grants: z.array(GrantInput) });
const PlanWindowBody = z.object({
  scenario: Name,
  version: Name,
  years: Name,
  locked: z.boolean().default(false),
  start_period: Name.nullable().optional(),
  end_period: Name.nullable().optional(),
});

export function adminRoutes(app: App, deps: Deps) {
  const { db } = deps;

  // --- Users -----------------------------------------------------------------
  app.get('/v1/users', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireRole(c, null, 'service_admin');
      const res = await c.query(
        'select user_id, email, display_name, status, created_at, last_login_at from epm.app_user order by email',
      );
      return { users: res.rows };
    }));
  });

  app.post('/v1/users', async (hc) => {
    const s = sessionOf(hc);
    const body = InviteBody.parse(await readJson(hc));
    const user = await withSession(db, s, async (c) => {
      await requireRole(c, null, 'service_admin');
      const row = await one<{ user_id: string }>(
        c,
        `insert into epm.app_user (tenant_id, email, display_name, status) values ($1, $2, $3, 'invited')
         returning user_id, email, status`,
        [s.tenantId, body.email, body.display_name ?? null],
      );
      await securityEvent(c, s.tenantId, s.userId, null, 'user_invited', { email: body.email });
      return row;
    });
    return hc.json(user, 201);
  });

  app.patch('/v1/users/:email', async (hc) => {
    const s = sessionOf(hc);
    const body = UserPatch.parse(await readJson(hc));
    return hc.json(await withSession(db, s, async (c) => {
      await requireRole(c, null, 'service_admin');
      const u = await userByEmail(c, hc.req.param('email'));
      if (u.user_id === s.userId && body.status === 'disabled') throw new HttpError(422, 'you cannot disable yourself');
      const row = await one(
        c,
        `update epm.app_user
            set status = case when $2 = 'disabled' then 'disabled'
                              when google_sub is null then 'invited' else 'active' end
          where user_id = $1 returning user_id, email, status`,
        [u.user_id, body.status],
      );
      await securityEvent(c, s.tenantId, s.userId, null, `user_${body.status}`, { email: hc.req.param('email') });
      await rebuildAllApps(c);
      return row;
    }));
  });

  // --- Groups ----------------------------------------------------------------
  app.post('/v1/groups', async (hc) => {
    const s = sessionOf(hc);
    const body = GroupBody.parse(await readJson(hc));
    const row = await withSession(db, s, async (c) => {
      await requireRole(c, null, 'service_admin');
      return one(c, 'insert into epm.principal_group (tenant_id, name) values ($1, $2) returning group_id, name', [
        s.tenantId,
        body.name,
      ]);
    });
    return hc.json(row, 201);
  });

  app.put('/v1/groups/:name/members', async (hc) => {
    const s = sessionOf(hc);
    const body = GroupMembersBody.parse(await readJson(hc));
    return hc.json(await withSession(db, s, async (c) => {
      await requireRole(c, null, 'service_admin');
      const g = await one<{ group_id: string }>(
        c,
        'select group_id from epm.principal_group where lower(name) = lower($1)',
        [hc.req.param('name')],
        `no group named ${hc.req.param('name')}`,
      );
      await c.query('delete from epm.group_member where group_id = $1', [g.group_id]);
      for (const email of body.emails) {
        const u = await userByEmail(c, email);
        await c.query('insert into epm.group_member (tenant_id, group_id, user_id) values ($1, $2, $3)', [
          s.tenantId,
          g.group_id,
          u.user_id,
        ]);
      }
      await securityEvent(c, s.tenantId, s.userId, null, 'group_membership_set', { group: hc.req.param('name'), emails: body.emails });
      await rebuildAllApps(c);
      return { group: hc.req.param('name'), members: body.emails.length };
    }));
  });

  // --- Applications ----------------------------------------------------------
  app.get('/v1/apps', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      const res = await c.query(
        `select a.app_id, a.name, a.metadata_rev, a.state, epm.user_app_role(a.app_id) as role
           from epm.application a
          where epm.user_app_role(a.app_id) is not null
          order by a.name`,
      );
      return { apps: res.rows };
    }));
  });

  app.post('/v1/apps', async (hc) => {
    const s = sessionOf(hc);
    const body = AppBody.parse(await readJson(hc));
    const row = await withSession(db, s, async (c) => {
      await requireRole(c, null, 'service_admin');
      return one(c, 'insert into epm.application (tenant_id, name) values ($1, $2) returning app_id, name, metadata_rev', [
        s.tenantId,
        body.name,
      ]);
    });
    return hc.json(row, 201);
  });

  app.post('/v1/apps/:appId/roles', async (hc) => {
    const s = sessionOf(hc);
    const body = RoleBody.parse(await readJson(hc));
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      const u = await userByEmail(c, body.email);
      await c.query('delete from epm.user_role where user_id = $1 and app_id = $2', [u.user_id, hc.req.param('appId')]);
      await c.query('insert into epm.user_role (tenant_id, user_id, app_id, role) values ($1, $2, $3, $4)', [
        s.tenantId,
        u.user_id,
        hc.req.param('appId'),
        body.role,
      ]);
      await securityEvent(c, s.tenantId, s.userId, hc.req.param('appId'), 'role_granted', body);
      return { email: body.email, role: body.role };
    }));
  });

  app.delete('/v1/apps/:appId/roles/:email', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      const u = await userByEmail(c, hc.req.param('email'));
      await c.query('delete from epm.user_role where user_id = $1 and app_id = $2', [u.user_id, hc.req.param('appId')]);
      await securityEvent(c, s.tenantId, s.userId, hc.req.param('appId'), 'role_revoked', { email: hc.req.param('email') });
      return { email: hc.req.param('email'), role: null };
    }));
  });

  // --- Dimensions and members --------------------------------------------------
  app.get('/v1/apps/:appId/dimensions', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'viewer');
      const dims = await loadDimensions(c, hc.req.param('appId'));
      const cubes = await c.query<{ name: string; dimensions: string[] }>(
        `select cu.name, array_agg(d.name order by d.dim_id) as dimensions
           from epm.cube cu join epm.cube_dimension cd on cd.cube_id = cu.cube_id join epm.dimension d on d.dim_id = cd.dim_id
          where cu.app_id = $1 group by cu.cube_id, cu.name order by cu.name`,
        [hc.req.param('appId')],
      );
      return {
        dimensions: dims.map((d) => ({ name: d.name, type: d.type, slot: d.slot, secured: d.secured })),
        cubes: cubes.rows,
      };
    }));
  });

  app.post('/v1/apps/:appId/dimensions', async (hc) => {
    const s = sessionOf(hc);
    const body = DimensionBody.parse(await readJson(hc));
    const row = await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      let slot: number | null = null;
      if (body.type === 'custom') {
        const used = new Set((await loadDimensions(c, hc.req.param('appId'))).map((d) => d.slot).filter((x) => x !== null));
        slot = body.slot ?? [1, 2, 3, 4, 5, 6, 7, 8].find((n) => !used.has(n)) ?? null;
        if (slot === null) throw new HttpError(422, 'all 8 custom dimension slots are in use');
      } else if (body.slot !== undefined) {
        throw new HttpError(422, 'only custom dimensions take a slot');
      }
      return one(
        c,
        `insert into epm.dimension (tenant_id, app_id, name, dim_type, slot, secured)
         values ($1, $2, $3, $4, $5, $6) returning dim_id, name, dim_type as type, slot, secured`,
        [s.tenantId, hc.req.param('appId'), body.name, body.type, slot, body.secured],
      );
    });
    return hc.json(row, 201);
  });

  app.patch('/v1/apps/:appId/dimensions/:dim', async (hc) => {
    const s = sessionOf(hc);
    const body = DimensionPatch.parse(await readJson(hc));
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      const dim = await loadDimension(c, hc.req.param('appId'), hc.req.param('dim'));
      await c.query('update epm.dimension set secured = $2 where dim_id = $1', [dim.dimId, body.secured]);
      await securityEvent(c, s.tenantId, s.userId, hc.req.param('appId'), 'dimension_secured_changed', {
        dimension: dim.name,
        secured: body.secured,
      });
      return { name: dim.name, secured: body.secured };
    }));
  });

  app.get('/v1/apps/:appId/dimensions/:dim/members', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      const ctx = await requireApp(c, hc.req.param('appId'), 'viewer');
      const dim = await loadDimension(c, hc.req.param('appId'), hc.req.param('dim'));
      const filter = dim.secured && !ctx.isAdmin;
      const res = await c.query(
        `select m.name, p.name as parent, m.alias, m.agg_op, m.sort_order, m.is_leaf, m.account_type, m.time_balance,
                m.formula, m.tree_ordinal is not null as deployed
           from epm.member m left join epm.member p on p.member_id = m.parent_id
          where m.dim_id = $1
            and (not $2 or exists (select 1 from epm.effective_access ea
                                    where ea.app_id = $3 and ea.user_id = $4 and ea.member_id = m.member_id))
          order by m.tree_ordinal nulls last, m.member_id`,
        [dim.dimId, filter, hc.req.param('appId'), s.userId],
      );
      return { dimension: dim.name, members: res.rows };
    }));
  });

  // Upsert members by name; parents resolve within the dimension after all names exist.
  app.put('/v1/apps/:appId/dimensions/:dim/members', async (hc) => {
    const s = sessionOf(hc);
    const body = MembersBody.parse(await readJson(hc));
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      await lockForEdit(c, hc.req.param('appId'));
      const dim = await loadDimension(c, hc.req.param('appId'), hc.req.param('dim'));
      let inserted = 0;
      let updated = 0;
      for (const [n, m] of body.members.entries()) {
        const existing = await maybeOne<{ member_id: number }>(
          c,
          'select member_id from epm.member where dim_id = $1 and lower(name) = lower($2)',
          [dim.dimId, m.name],
        );
        if (!existing) {
          await c.query(
            `insert into epm.member (tenant_id, dim_id, name, alias, agg_op, sort_order, account_type, time_balance, formula)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [s.tenantId, dim.dimId, m.name, m.alias ?? null, m.agg_op ?? '+', m.sort_order ?? (n + 1) * 10,
             m.account_type ?? null, m.time_balance ?? null, m.formula ?? null],
          );
          inserted++;
        } else {
          await c.query(
            `update epm.member set
               alias        = case when $2 then $3 else alias end,
               agg_op       = coalesce($4, agg_op),
               sort_order   = coalesce($5, sort_order),
               account_type = case when $6 then $7 else account_type end,
               time_balance = case when $8 then $9 else time_balance end,
               formula      = case when $10 then $11 else formula end
             where member_id = $1`,
            [existing.member_id, m.alias !== undefined, m.alias ?? null, m.agg_op ?? null, m.sort_order ?? null,
             m.account_type !== undefined, m.account_type ?? null, m.time_balance !== undefined, m.time_balance ?? null,
             m.formula !== undefined, m.formula ?? null],
          );
          updated++;
        }
      }
      for (const m of body.members) {
        if (m.parent === undefined) continue;
        const parentId = m.parent === null ? null : (await memberIdByName(c, dim, m.parent)).member_id;
        await c.query('update epm.member set parent_id = $3 where dim_id = $1 and lower(name) = lower($2)', [
          dim.dimId,
          m.name,
          parentId,
        ]);
      }
      return { dimension: dim.name, inserted, updated, deploy_required: true };
    }));
  });

  app.delete(
    '/v1/apps/:appId/dimensions/:dim/members/:name',
    async (hc) => {
      const s = sessionOf(hc);
      return hc.json(await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'app_admin');
        await lockForEdit(c, hc.req.param('appId'));
        const dim = await loadDimension(c, hc.req.param('appId'), hc.req.param('dim'));
        const m = await memberIdByName(c, dim, hc.req.param('name'));
        const kids = await maybeOne(c, 'select 1 from epm.member where parent_id = $1 limit 1', [m.member_id]);
        if (kids) throw new HttpError(422, `${hc.req.param('name')} has children; move or delete them first`);
        const data = await maybeOne(c, `select 1 from epm.fact where app_id = $1 and ${dim.column} = $2 limit 1`, [
          hc.req.param('appId'),
          m.member_id,
        ]);
        if (data) throw new HttpError(422, `${hc.req.param('name')} holds data and cannot be deleted`);
        await c.query('delete from epm.member where member_id = $1', [m.member_id]);
        return { dimension: dim.name, deleted: hc.req.param('name'), deploy_required: true };
      }));
    },
  );

  app.post('/v1/apps/:appId/cubes', async (hc) => {
    const s = sessionOf(hc);
    const body = CubeBody.parse(await readJson(hc));
    const row = await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      const all = await loadDimensions(c, hc.req.param('appId'));
      const chosen = body.dimensions.map((n) => {
        const d = all.find((x) => x.name.toLowerCase() === n.toLowerCase());
        if (!d) throw new HttpError(422, `dimension ${n} not found`);
        return d;
      });
      const missing = FIXED_DIMS.filter((t) => !chosen.some((d) => d.type === t));
      if (missing.length) throw new HttpError(422, `a cube needs the ${missing.join(', ')} dimension(s)`);
      const cube = await one<{ cube_id: number; name: string }>(
        c,
        'insert into epm.cube (tenant_id, app_id, name) values ($1, $2, $3) returning cube_id, name',
        [s.tenantId, hc.req.param('appId'), body.name],
      );
      for (const d of new Set(chosen)) {
        await c.query('insert into epm.cube_dimension (tenant_id, cube_id, dim_id) values ($1, $2, $3)', [
          s.tenantId,
          cube.cube_id,
          d.dimId,
        ]);
      }
      return { name: cube.name, dimensions: chosen.map((d) => d.name) };
    });
    return hc.json(row, 201);
  });

  app.post('/v1/apps/:appId/deploy', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      const res = await c.query<{ result: unknown }>('select epm.deploy_metadata($1) as result', [hc.req.param('appId')]);
      return res.rows[0]!.result;
    }));
  });

  // --- Member-level security -------------------------------------------------------
  app.get('/v1/apps/:appId/grants', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      const res = await c.query(
        `select g.principal_type, coalesce(u.email, pg.name) as principal, d.name as dimension, m.name as member, g.scope, g.access
           from epm.access_grant g
           join epm.member m on m.member_id = g.member_id
           join epm.dimension d on d.dim_id = m.dim_id
           left join epm.app_user u on g.principal_type = 'user' and u.user_id = g.principal
           left join epm.principal_group pg on g.principal_type = 'group' and pg.group_id = g.principal
          where g.app_id = $1
          order by d.name, m.name, principal`,
        [hc.req.param('appId')],
      );
      return { grants: res.rows };
    }));
  });

  app.put('/v1/apps/:appId/grants', async (hc) => {
    const s = sessionOf(hc);
    const body = GrantsBody.parse(await readJson(hc));
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      if (body.replace) await c.query('delete from epm.access_grant where app_id = $1', [hc.req.param('appId')]);
      for (const g of body.grants) {
        const dim = await loadDimension(c, hc.req.param('appId'), g.dimension);
        if (!dim.secured) throw new HttpError(422, `dimension ${dim.name} is not secured; grants on it have no effect`);
        const member = await memberIdByName(c, dim, g.member);
        let principalType: 'user' | 'group';
        let principal: string;
        if ('user' in g.principal) {
          principalType = 'user';
          principal = (await userByEmail(c, g.principal.user)).user_id;
        } else {
          principalType = 'group';
          principal = (
            await one<{ group_id: string }>(
              c,
              'select group_id from epm.principal_group where lower(name) = lower($1)',
              [g.principal.group],
              `no group named ${g.principal.group}`,
            )
          ).group_id;
        }
        await c.query(
          `insert into epm.access_grant (tenant_id, app_id, principal_type, principal, member_id, scope, access)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict (app_id, principal_type, principal, member_id, scope) do update set access = excluded.access`,
          [s.tenantId, hc.req.param('appId'), principalType, principal, member.member_id, g.scope, g.access],
        );
      }
      const rebuilt = await c.query<{ rows: number }>('select epm.rebuild_effective_access($1) as rows', [hc.req.param('appId')]);
      await securityEvent(c, s.tenantId, s.userId, hc.req.param('appId'), 'grants_changed', {
        replace: body.replace,
        count: body.grants.length,
      });
      return { grants: body.grants.length, effective_rows: rebuilt.rows[0]!.rows };
    }));
  });

  app.put('/v1/apps/:appId/plan-windows', async (hc) => {
    const s = sessionOf(hc);
    const body = PlanWindowBody.parse(await readJson(hc));
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      const dims = await loadDimensions(c, hc.req.param('appId'));
      const byType = (t: string) => {
        const d = dims.find((x) => x.type === t);
        if (!d) throw new HttpError(422, `application has no ${t} dimension`);
        return d;
      };
      const scenario = await memberIdByName(c, byType('scenario'), body.scenario);
      const version = await memberIdByName(c, byType('version'), body.version);
      const years = await memberIdByName(c, byType('years'), body.years);
      const period = byType('period');
      const start = body.start_period ? await memberIdByName(c, period, body.start_period) : null;
      const end = body.end_period ? await memberIdByName(c, period, body.end_period) : null;
      if ((start && !start.is_leaf) || (end && !end.is_leaf)) throw new HttpError(422, 'window start and end must be leaf periods');
      await c.query(
        `insert into epm.plan_window (tenant_id, app_id, scenario_id, version_id, years_id, start_period_id, end_period_id, locked)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (app_id, scenario_id, version_id, years_id)
         do update set start_period_id = excluded.start_period_id, end_period_id = excluded.end_period_id, locked = excluded.locked`,
        [s.tenantId, hc.req.param('appId'), scenario.member_id, version.member_id, years.member_id,
         start?.member_id ?? null, end?.member_id ?? null, body.locked],
      );
      await securityEvent(c, s.tenantId, s.userId, hc.req.param('appId'), 'plan_window_set', body);
      return body;
    }));
  });
}
