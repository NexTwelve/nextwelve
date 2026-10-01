import { z } from 'zod';
import { DatasetBody, publishDatasetVersion, resolveDataset } from '../datasets.js';
import { DEMO_MAX_STORED, DEMO_MAX_UPLOAD } from '../demo.js';
import { maybeOne, withSession } from '../db.js';
import { HttpError } from '../errors.js';
import { sha256Hex } from '../files/hash.js';
import { ImportFormatBody, loadFormat, MappingsBody, RunBody, runImport, validateFormat } from '../imports.js';
import { COORD_LENGTH, loadCube, requireApp, resolveMembers } from '../model.js';
import { type App, type Deps, readJson, sessionOf } from './context.js';

const MAX_UPLOAD = 25 * 1024 * 1024;
/** Mapping rules per import format (as many as one request may set). */
const MAX_MAPPING_RULES = 50_000;
const DrillBody = z.object({ cube: z.string(), cell: z.record(z.string(), z.string()), limit: z.number().int().min(1).max(1000).default(200) });

export function dataRoutes(app: App, deps: Deps) {
  const { db, blobs } = deps;

  // --- Files -------------------------------------------------------------------
  // Raw upload: POST /v1/apps/:appId/files?name=gl_july.csv&purpose=import  (body = file bytes)
  app.post('/v1/apps/:appId/files', async (hc) => {
    const s = sessionOf(hc);
    const name = (hc.req.query('name') ?? '').trim();
    const purpose = hc.req.query('purpose') ?? 'import';
    if (!name || name.length > 255 || /[\\/]/.test(name)) throw new HttpError(422, 'give the file name in ?name= (no slashes)');
    if (!['import', 'dataset'].includes(purpose)) throw new HttpError(422, 'purpose must be import or dataset');
    const data = new Uint8Array(await hc.req.arrayBuffer());
    if (data.byteLength === 0) throw new HttpError(422, 'the upload is empty');
    if (data.byteLength > MAX_UPLOAD) throw new HttpError(413, 'files are limited to 25 MB');
    if (s.demo && data.byteLength > DEMO_MAX_UPLOAD) throw new HttpError(413, 'uploads in the demo are limited to 1 MB');
    const contentType = hc.req.header('content-type') ?? 'application/octet-stream';
    const sha = await sha256Hex(data);
    // The file goes to storage before its row; if the row is never committed (the copy or the
    // application went away meanwhile), the file is removed again.
    let stored: string | null = null;
    try {
      const row = await withSession(db, s, async (c) => {
        const ctx = await requireApp(c, hc.req.param('appId'), 'power_user');
        if (s.demo) {
          // One upload at a time per copy, so the total holds under concurrent requests.
          await c.query("select pg_advisory_xact_lock(hashtextextended('nextwelve.demo-files:' || $1, 0))", [s.tenantId]);
          const used = await maybeOne<{ n: string }>(c, 'select coalesce(sum(byte_size), 0)::text as n from epm.stored_file');
          if (Number(used?.n ?? 0) + data.byteLength > DEMO_MAX_STORED) {
            throw new HttpError(413, `a demo copy keeps at most ${DEMO_MAX_STORED / (1024 * 1024)} MB of uploaded files; start over for a fresh copy`);
          }
        }
        const fileId = crypto.randomUUID();
        const key = `${s.tenantId}/${ctx.appId}/files/${fileId}/${name}`;
        stored = key;
        await blobs.put(key, data, contentType);
        return maybeOne(
          c,
          `insert into epm.stored_file (file_id, tenant_id, app_id, name, content_type, byte_size, sha256, storage_key, purpose, uploaded_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning file_id, name, byte_size, sha256, purpose, uploaded_at`,
          [fileId, s.tenantId, ctx.appId, name, contentType, data.byteLength, sha, key, purpose, s.userId],
        );
      });
      return hc.json(row, 201);
    } catch (err) {
      if (stored) await blobs.delete([stored]).catch(() => undefined);
      throw err;
    }
  });

  app.get('/v1/apps/:appId/files', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'power_user');
        const res = await c.query(
          `select f.file_id, f.name, f.byte_size, f.purpose, f.uploaded_at, u.email as uploaded_by
             from epm.stored_file f left join epm.app_user u on u.user_id = f.uploaded_by
            where f.app_id = $1 order by f.uploaded_at desc limit 200`,
          [hc.req.param('appId')],
        );
        return { files: res.rows };
      }),
    );
  });

  // --- Datasets ------------------------------------------------------------------
  app.put('/v1/apps/:appId/datasets/:name', async (hc) => {
    const s = sessionOf(hc);
    const body = DatasetBody.parse(await readJson(hc));
    return hc.json(
      await withSession(db, s, async (c) => {
        const ctx = await requireApp(c, hc.req.param('appId'), 'power_user');
        return publishDatasetVersion(c, blobs, ctx.appId, s, hc.req.param('name'), body);
      }),
    );
  });

  app.get('/v1/apps/:appId/datasets', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'viewer');
        const res = await c.query(
          `select d.name, d.description, d.current_version, v.sheets, v.uploaded_at
             from epm.dataset d left join epm.dataset_version v on v.dataset_id = d.dataset_id and v.version = d.current_version
            where d.app_id = $1 order by d.name`,
          [hc.req.param('appId')],
        );
        return { datasets: res.rows };
      }),
    );
  });

  app.get('/v1/apps/:appId/datasets/:name', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'viewer');
        const ref = await resolveDataset(c, hc.req.param('appId'), hc.req.param('name'));
        const versions = await c.query(
          `select v.version, v.uploaded_at, u.email as uploaded_by, f.name as file
             from epm.dataset_version v
             left join epm.app_user u on u.user_id = v.uploaded_by
             left join epm.stored_file f on f.file_id = v.file_id
            where v.dataset_id = $1 order by v.version desc`,
          [ref.dataset_id],
        );
        return { name: ref.name, current_version: ref.version, sheets: ref.sheets, versions: versions.rows };
      }),
    );
  });

  // Rows of one sheet: ?sheet=&version=&limit=&offset= plus optional column filters ?where.Column=value
  app.get('/v1/apps/:appId/datasets/:name/rows', async (hc) => {
    const s = sessionOf(hc);
    const q = hc.req.query();
    const limit = Math.min(Math.max(Number(q.limit ?? 100) || 100, 1), 5000);
    const offset = Math.max(Number(q.offset ?? 0) || 0, 0);
    const where = Object.fromEntries(Object.entries(q).filter(([k]) => k.startsWith('where.')).map(([k, v]) => [k.slice(6), v]));
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'viewer');
        const ref = await resolveDataset(c, hc.req.param('appId'), hc.req.param('name'), q.version ? Number(q.version) : undefined);
        const sheet = q.sheet ? ref.sheets.find((x) => x.name.toLowerCase() === q.sheet!.toLowerCase()) : ref.sheets[0];
        if (!sheet) throw new HttpError(422, `no sheet ${q.sheet}`);
        const res = await c.query<{ row_no: number; data: unknown }>(
          `select row_no, data from epm.dataset_row
            where dataset_id = $1 and version = $2 and sheet = $3 and data @> $4::jsonb
            order by row_no limit $5 offset $6`,
          [ref.dataset_id, ref.version, sheet.name, JSON.stringify(where), limit, offset],
        );
        return { dataset: ref.name, version: ref.version, sheet: sheet.name, columns: sheet.columns, total: sheet.rows, rows: res.rows };
      }),
    );
  });

  // --- Import formats and mappings ---------------------------------------------------
  app.get('/v1/apps/:appId/import-formats', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'power_user');
        const res = await c.query(
          `select f.name, cu.name as cube, f.version, f.updated_at,
                  (select count(*)::int from epm.mapping_rule r where r.format_id = f.format_id) as mapping_rules
             from epm.import_format f join epm.cube cu on cu.cube_id = f.cube_id
            where f.app_id = $1 order by f.name`,
          [hc.req.param('appId')],
        );
        return { formats: res.rows };
      }),
    );
  });

  app.get('/v1/apps/:appId/import-formats/:name', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'power_user');
        return loadFormat(c, hc.req.param('appId'), hc.req.param('name'));
      }),
    );
  });

  app.put('/v1/apps/:appId/import-formats/:name', async (hc) => {
    const s = sessionOf(hc);
    const body = ImportFormatBody.parse(await readJson(hc));
    return hc.json(
      await withSession(db, s, async (c) => {
        const ctx = await requireApp(c, hc.req.param('appId'), 'app_admin');
        const cube = await validateFormat(c, ctx.appId, body);
        return maybeOne(
          c,
          `insert into epm.import_format (tenant_id, app_id, cube_id, name, definition, updated_by)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (app_id, lower(name)) do update
              set cube_id = excluded.cube_id, definition = excluded.definition, updated_by = excluded.updated_by,
                  updated_at = now(), version = epm.import_format.version + 1
           returning name, version`,
          [s.tenantId, ctx.appId, cube.cubeId, hc.req.param('name'), body.definition, s.userId],
        );
      }),
    );
  });

  app.get('/v1/apps/:appId/import-formats/:name/mappings', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'power_user');
        const f = await loadFormat(c, hc.req.param('appId'), hc.req.param('name'));
        const res = await c.query(
          `select dimension, rule_type, source, target, options, priority, description
             from epm.mapping_rule where format_id = $1
            order by dimension, array_position(array['explicit','dataset','between','in','like'], rule_type), priority, rule_id`,
          [f.format_id],
        );
        return { format: f.name, rules: res.rows };
      }),
    );
  });

  app.put('/v1/apps/:appId/import-formats/:name/mappings', async (hc) => {
    const s = sessionOf(hc);
    const body = MappingsBody.parse(await readJson(hc));
    return hc.json(
      await withSession(db, s, async (c) => {
        const ctx = await requireApp(c, hc.req.param('appId'), 'app_admin');
        const f = await loadFormat(c, ctx.appId, hc.req.param('name'));
        const cube = await loadCube(c, ctx.appId, f.cube);
        for (const r of body.rules) {
          if (!cube.dims.some((d) => d.name.toLowerCase() === r.dimension.toLowerCase())) {
            throw new HttpError(422, `dimension ${r.dimension} is not in cube ${cube.name}`);
          }
          if (r.rule_type === 'between' && !r.source.includes('..')) throw new HttpError(422, `between rules need low..high, got "${r.source}"`);
          if (r.rule_type === 'dataset') {
            if (!r.options?.key_column) throw new HttpError(422, 'dataset rules need options.key_column');
            await resolveDataset(c, ctx.appId, r.source);
          }
        }
        if (body.replace) await c.query('delete from epm.mapping_rule where format_id = $1', [f.format_id]);
        else if (body.rules.length) {
          // Appending: the format as a whole keeps to the limit one request may set.
          await c.query('select 1 from epm.import_format where format_id = $1 for update', [f.format_id]);
          const have = await maybeOne<{ n: number }>(c, 'select count(*)::int as n from epm.mapping_rule where format_id = $1', [f.format_id]);
          if ((have?.n ?? 0) + body.rules.length > MAX_MAPPING_RULES) {
            throw new HttpError(422, `a format holds at most ${MAX_MAPPING_RULES.toLocaleString('en-US')} mapping rules; it has ${have?.n ?? 0}`);
          }
        }
        if (body.rules.length) {
          await c.query(
            `insert into epm.mapping_rule (tenant_id, app_id, format_id, dimension, rule_type, source, target, options, priority, description)
             select $1, $2, $3, r->>'dimension', r->>'rule_type', r->>'source', r->>'target', r->'options',
                    coalesce((r->>'priority')::int, 0), r->>'description'
               from jsonb_array_elements($4::jsonb) r`,
            [s.tenantId, ctx.appId, f.format_id, JSON.stringify(body.rules)],
          );
        }
        return { format: f.name, rules: body.rules.length, replaced: body.replace };
      }),
    );
  });

  // --- Runs ----------------------------------------------------------------------------
  app.post('/v1/apps/:appId/import-formats/:name/run', async (hc) => {
    const s = sessionOf(hc);
    const body = RunBody.parse(await readJson(hc));
    return hc.json(
      await withSession(db, s, async (c) => {
        const ctx = await requireApp(c, hc.req.param('appId'), 'power_user');
        const f = await loadFormat(c, ctx.appId, hc.req.param('name'));
        return runImport(c, blobs, ctx, s, f, body);
      }),
    );
  });

  app.get('/v1/apps/:appId/imports', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'power_user');
        const res = await c.query(
          `select r.run_id, fmt.name as format, f.name as file, r.source_dataset, r.mode, r.dry_run, r.status,
                  r.lines_read, r.lines_mapped, r.lines_skipped, r.lines_rejected, r.cells, r.txn_id, r.created_at,
                  u.email as created_by
             from epm.import_run r
             left join epm.import_format fmt on fmt.format_id = r.format_id
             left join epm.stored_file f on f.file_id = r.file_id
             left join epm.app_user u on u.user_id = r.created_by
            where r.app_id = $1 order by r.created_at desc limit 100`,
          [hc.req.param('appId')],
        );
        return { runs: res.rows };
      }),
    );
  });

  app.get('/v1/apps/:appId/imports/:runId/lines', async (hc) => {
    const s = sessionOf(hc);
    const errorsOnly = hc.req.query('errors') === 'true';
    return hc.json(
      await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'power_user');
        const res = await c.query(
          `select l.line_no, l.source, l.amount, l.coords is not null as mapped, l.error
             from epm.import_line l join epm.import_run r on r.run_id = l.run_id
            where r.app_id = $1 and l.run_id = $2 and (not $3 or l.error is not null)
            order by l.line_no limit 5000`,
          [hc.req.param('appId'), hc.req.param('runId'), errorsOnly],
        );
        return { lines: res.rows };
      }),
    );
  });

  // Drill-back: the file rows that loaded into a leaf cell.
  app.post('/v1/apps/:appId/drill', async (hc) => {
    const s = sessionOf(hc);
    const body = DrillBody.parse(await readJson(hc));
    return hc.json(
      await withSession(db, s, async (c) => {
        const ctx = await requireApp(c, hc.req.param('appId'), 'viewer');
        const cube = await loadCube(c, ctx.appId, body.cube);
        const given = new Map(Object.entries(body.cell).map(([k, v]) => [k.toLowerCase(), v]));
        const k = new Array<number>(COORD_LENGTH).fill(0);
        k[0] = cube.cubeId;
        for (const dim of cube.dims) {
          const name = given.get(dim.name.toLowerCase());
          if (!name) throw new HttpError(422, `cell is missing dimension ${dim.name}`);
          const [m] = await resolveMembers(c, dim, [name]);
          if (!m!.isLeaf) throw new HttpError(422, `drill-back needs a leaf cell; ${dim.name} ${m!.name} is a parent`);
          k[dim.pos] = m!.id;
        }
        // Member-level read access applies as for the grid.
        if (!ctx.isAdmin) {
          const denied = await maybeOne(
            c,
            `select 1 from epm.dimension d join epm.cube_dimension cd on cd.dim_id = d.dim_id
              where cd.cube_id = $1 and d.secured
                and not exists (select 1 from epm.effective_access ea
                                 where ea.app_id = $2 and ea.user_id = $3 and ea.dim_id = d.dim_id
                                   and ea.member_id = ($4::int[])[epm.coord_index(d.dim_type, d.slot)])`,
            [cube.cubeId, ctx.appId, s.userId, k],
          );
          if (denied) throw new HttpError(403, 'no read access to this cell');
        }
        const res = await c.query(
          `select l.line_no, l.source, l.amount, r.run_id, r.mode, r.created_at, f.name as file, fmt.name as format,
                  r.source_dataset
             from epm.import_line l
             join epm.import_run r on r.run_id = l.run_id and r.status = 'loaded'
             left join epm.stored_file f on f.file_id = r.file_id
             left join epm.import_format fmt on fmt.format_id = r.format_id
            where l.coords = $2::int[] and r.app_id = $1
            order by r.created_at desc, l.line_no limit $3`,
          [ctx.appId, k, body.limit],
        );
        return { cell: body.cell, lines: res.rows };
      }),
    );
  });
}
