import { z } from 'zod';
import { withSession } from '../db.js';
import { definitionsXlsx, definitionsZip, definitionTables, importDefinitions, type ImportFile, type Kind, loadDefinitions, readImportFiles } from '../definitions.js';
import { DEMO_MAX_UPLOAD } from '../demo.js';
import { HttpError } from '../errors.js';
import { definitionHistory, restoreDefinitionVersion } from '../history.js';
import { lockForEdit, requireApp } from '../model.js';
import { loadReport, ReportBody, reportCsv, reportSheet, RunBody, runReport, saveReport } from '../reports.js';
import { strToU8 } from 'fflate';
import { writeXlsx } from '../files/xlsx.js';
import { type App, type Deps, readJson, sessionOf } from './context.js';

const KIND_OF: Record<string, Kind> = { forms: 'form', reports: 'report' };
const HistoryRestoreBody = z.object({ artifact_id: z.uuid(), version: z.number().int().positive() });

/** Content-Disposition with a plain ASCII fallback and the UTF-8 name. */
function attachment(name: string): string {
  const ascii = name.replace(/[^\w.-]+/g, '_');
  // RFC 8187: encodeURIComponent leaves ' ( ) * ! as they are; strict parsers want them encoded.
  const encoded = encodeURIComponent(name).replace(/['()*!]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export function definitionRoutes(app: App, deps: Deps) {
  const { db } = deps;

  // --- Reports ---------------------------------------------------------------------
  app.get('/v1/apps/:appId/reports', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'viewer');
      const res = await c.query(
        `select r.name, r.folder, r.description, cu.name as cube, r.version, r.updated_at
           from epm.report r join epm.cube cu on cu.cube_id = r.cube_id
          where r.app_id = $1 order by r.folder nulls first, r.name`,
        [hc.req.param('appId')],
      );
      return { reports: res.rows };
    }));
  });

  app.get('/v1/apps/:appId/reports/:name', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'viewer');
      return loadReport(c, hc.req.param('appId'), hc.req.param('name'));
    }));
  });

  app.put('/v1/apps/:appId/reports/:name', async (hc) => {
    const s = sessionOf(hc);
    const name = hc.req.param('name');
    return hc.json(await withSession(db, s, async (c) => {
      const appId = hc.req.param('appId');
      await requireApp(c, appId, 'power_user');
      const body = ReportBody.parse(await readJson(hc));
      await lockForEdit(c, appId);
      return saveReport(c, s, appId, name, body);
    }));
  });

  app.delete('/v1/apps/:appId/reports/:name', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      const appId = hc.req.param('appId');
      await requireApp(c, appId, 'power_user');
      await lockForEdit(c, appId);
      const r = await loadReport(c, appId, hc.req.param('name'));
      await c.query('delete from epm.report where report_id = $1', [r.report_id]);
      return { deleted: r.name };
    }));
  });

  // Run a report: JSON by default; ?format=xlsx or ?format=csv for a file. A file is built before
  // its download is logged, in the same transaction, so a file that fails is not logged.
  app.post('/v1/apps/:appId/reports/:name/run', async (hc) => {
    const s = sessionOf(hc);
    const format = hc.req.query('format') ?? 'json';
    if (!['json', 'xlsx', 'csv'].includes(format)) throw new HttpError(422, 'format must be json, xlsx or csv');
    const out = await withSession(db, s, async (c) => {
      const ctx = await requireApp(c, hc.req.param('appId'), 'viewer');
      const body = RunBody.parse(await readJson(hc));
      const report = await loadReport(c, ctx.appId, hc.req.param('name'));
      const r = await runReport(c, ctx, s, report, body.page);
      if (format === 'json') return { r, file: null };
      const file = format === 'csv' ? strToU8(reportCsv(r)) : writeXlsx([reportSheet(r)]);
      await c.query(
        `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'report_exported', $4)`,
        [s.tenantId, ctx.appId, s.userId, { report: report.name, format, pov: r.pov }],
      );
      return { r, file };
    });
    if (!out.file) return hc.json(out.r);
    const stamp = new Date().toISOString().slice(0, 10);
    return hc.body(out.file as Uint8Array<ArrayBuffer>, 200, {
      'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': attachment(`${out.r.report.name} ${stamp}.${format}`),
    });
  });

  // --- Definitions export and import ---------------------------------------------------
  // GET ?format=xlsx|csv (csv = a zip of definitions.csv and layout.csv) &type=form|report &name=a&name=b
  app.get('/v1/apps/:appId/definitions/export', async (hc) => {
    const s = sessionOf(hc);
    const format = hc.req.query('format') ?? 'xlsx';
    if (!['xlsx', 'csv'].includes(format)) throw new HttpError(422, 'format must be xlsx or csv');
    const type = hc.req.query('type');
    if (type !== undefined && !['form', 'report'].includes(type)) throw new HttpError(422, 'type must be form or report');
    const names = hc.req.queries('name');
    const tables = await withSession(db, s, async (c) => {
      const ctx = await requireApp(c, hc.req.param('appId'), 'power_user');
      const defs = await loadDefinitions(c, ctx.appId, type ? [type as Kind] : undefined, names?.length ? names : undefined);
      const t = await definitionTables(c, ctx.appId, defs);
      await c.query(
        `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'definitions_exported', $4)`,
        [s.tenantId, ctx.appId, s.userId, { format, count: defs.length }],
      );
      return { ...t, appName: ctx.name };
    });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') {
      return hc.body(definitionsZip(tables) as Uint8Array<ArrayBuffer>, 200, {
        'content-type': 'application/zip',
        'content-disposition': attachment(`${tables.appName} definitions ${stamp}.zip`),
      });
    }
    return hc.body(definitionsXlsx(tables) as Uint8Array<ArrayBuffer>, 200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': attachment(`${tables.appName} definitions ${stamp}.xlsx`),
    });
  });

  // POST ?name=defs.xlsx&dry_run=true with the file as the body, or multipart with up to four files.
  app.post('/v1/apps/:appId/definitions/import', async (hc) => {
    const s = sessionOf(hc);
    const dryRun = ['1', 'true', 'yes'].includes((hc.req.query('dry_run') ?? '').toLowerCase());
    const result = await withSession(db, s, async (c) => {
      // The role first: nothing about the upload is looked at for someone who may not import.
      const ctx = await requireApp(c, hc.req.param('appId'), 'power_user');
      const files: ImportFile[] = [];
      const type = hc.req.header('content-type') ?? '';
      if (type.startsWith('multipart/form-data')) {
        const form = await hc.req.formData();
        for (const value of form.values()) {
          if (typeof value === 'string') continue;
          files.push({ name: value.name, data: new Uint8Array(await value.arrayBuffer()) });
        }
      } else {
        const name = (hc.req.query('name') ?? '').trim();
        if (!name) throw new HttpError(422, 'give the file name in ?name= (e.g. definitions.xlsx)');
        files.push({ name, data: new Uint8Array(await hc.req.arrayBuffer()) });
      }
      if (files.some((f) => f.data.byteLength === 0)) throw new HttpError(422, 'the upload is empty');
      if (s.demo && files.reduce((n, f) => n + f.data.byteLength, 0) > DEMO_MAX_UPLOAD) throw new HttpError(413, 'uploads in the demo are limited to 1 MB');
      return importDefinitions(c, s, ctx, readImportFiles(files), dryRun);
    });
    if (result.errors.length && !dryRun) {
      throw new HttpError(422, `the file has ${result.errors.length}${result.errors.length >= 200 ? '+' : ''} problem(s); nothing was imported`, result);
    }
    return hc.json(result);
  });

  // --- Definition history (forms and reports) ---------------------------------------
  for (const [path, kind] of Object.entries(KIND_OF)) {
    app.get(`/v1/apps/:appId/${path}/:name/history`, async (hc) => {
      const s = sessionOf(hc);
      return hc.json(await withSession(db, s, async (c) => {
        await requireApp(c, hc.req.param('appId'), 'power_user');
        return { history: await definitionHistory(c, hc.req.param('appId'), kind, hc.req.param('name')) };
      }));
    });

    app.post(`/v1/apps/:appId/${path}/:name/history/restore`, async (hc) => {
      const s = sessionOf(hc);
      return hc.json(await withSession(db, s, async (c) => {
        const appId = hc.req.param('appId');
        await requireApp(c, appId, 'power_user');
        const body = HistoryRestoreBody.parse(await readJson(hc));
        return restoreDefinitionVersion(c, s, appId, kind, hc.req.param('name'), body.artifact_id, body.version);
      }));
    });
  }
}
