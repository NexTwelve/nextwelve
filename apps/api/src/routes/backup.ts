import { MetadataRestoreBody, restoreMetadata } from '../backup/metadata.js';
import { PointInTimeBody, restorePointInTime } from '../backup/pointInTime.js';
import {
  CreateSnapshotBody,
  createSnapshot,
  listSnapshots,
  loadSnapshot,
  readSnapshotFile,
  RestoreBody,
  restoreInPlace,
  restoreToNewApp,
} from '../backup/snapshots.js';
import { retrying, withSession } from '../db.js';
import { HttpError } from '../errors.js';
import { requireApp } from '../model.js';
import { type App, type Deps, readJson, sessionOf } from './context.js';

export function backupRoutes(app: App, deps: Deps) {
  const { db, blobs } = deps;

  // --- Point-in-time restore of a slice ---------------------------------------------
  // Retried when a concurrent writer moved the slice while it was being restored (NXRTY).
  app.post('/v1/apps/:appId/restore', async (hc) => {
    const s = sessionOf(hc);
    const body = PointInTimeBody.parse(await readJson(hc));
    return hc.json(await retrying(() => withSession(db, s, async (c) => {
      const ctx = await requireApp(c, hc.req.param('appId'), 'app_admin');
      return restorePointInTime(c, ctx, body);
    })));
  });

  // --- Metadata (members, forms, reports) to a point in time or a snapshot ------------
  app.post('/v1/apps/:appId/metadata/restore', async (hc) => {
    const s = sessionOf(hc);
    const body = MetadataRestoreBody.parse(await readJson(hc));
    return hc.json(await restoreMetadata({ db, blobs }, s, hc.req.param('appId'), body));
  });

  // Deploys and definition changes, newest first: the moments a metadata restore can go back to.
  app.get('/v1/apps/:appId/metadata/history', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      const ctx = await requireApp(c, hc.req.param('appId'), 'app_admin');
      const app = await c.query<{ history_from: string }>(
        `select to_char(history_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as history_from from epm.application where app_id = $1`,
        [ctx.appId],
      );
      const deploys = await c.query(
        `select r.metadata_rev, to_char(r.deployed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as deployed_at, u.email as deployed_by
           from epm.metadata_rev r left join epm.app_user u on u.user_id = r.user_id
          where r.app_id = $1 order by r.metadata_rev desc limit 200`,
        [ctx.appId],
      );
      const definitions = await c.query(
        `select v.kind as type, v.name, v.version, v.deleted, u.email as changed_by,
                to_char(v.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as changed_at
           from epm.artifact_version v left join epm.app_user u on u.user_id = v.changed_by
          where v.app_id = $1 order by v.changed_at desc limit 200`,
        [ctx.appId],
      );
      return { history_from: app.rows[0]!.history_from, deploys: deploys.rows, definitions: definitions.rows };
    }));
  });

  // --- Snapshots -----------------------------------------------------------------
  app.get('/v1/apps/:appId/snapshots', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      return { snapshots: await listSnapshots(c, hc.req.param('appId')) };
    }));
  });

  app.post('/v1/apps/:appId/snapshots', async (hc) => {
    const s = sessionOf(hc);
    const body = CreateSnapshotBody.parse(await readJson(hc));
    const snap = await createSnapshot({ db, blobs }, s, hc.req.param('appId'), { kind: 'manual', scope: body.scope, comment: body.comment });
    return hc.json(snap, 201);
  });

  app.get('/v1/apps/:appId/snapshots/:snapshotId', async (hc) => {
    const s = sessionOf(hc);
    return hc.json(await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      return loadSnapshot(c, hc.req.param('appId'), hc.req.param('snapshotId'));
    }));
  });

  // Portability: an admin can take a snapshot's files away. A download is logged once the file
  // has been found and checked; manifest.json is the copy kept in the database.
  app.get('/v1/apps/:appId/snapshots/:snapshotId/files/:file', async (hc) => {
    const s = sessionOf(hc);
    const file = hc.req.param('file');
    const snap = await withSession(db, s, async (c) => {
      await requireApp(c, hc.req.param('appId'), 'app_admin');
      return loadSnapshot(c, hc.req.param('appId'), hc.req.param('snapshotId'));
    });
    if (snap.status !== 'complete') throw new HttpError(422, `snapshot is ${snap.status}`);
    if (file !== 'manifest.json' && !snap.manifest?.files.some((f) => f.name === file)) throw new HttpError(404, 'snapshot has no such file');
    const bytes = await readSnapshotFile(blobs, snap, file);
    await withSession(db, s, (c) =>
      c.query(
        `insert into epm.security_event (tenant_id, app_id, user_id, event_type, detail) values ($1, $2, $3, 'snapshot_downloaded', $4)`,
        [s.tenantId, snap.app_id, s.userId, { snapshot_id: snap.snapshot_id, file }],
      ),
    );
    return hc.body(bytes as Uint8Array<ArrayBuffer>, 200, {
      'content-type': file.endsWith('.json') ? 'application/json' : 'application/gzip',
      'content-disposition': `attachment; filename="${snap.app_name.replace(/[^\w.-]+/g, '_')}-${snap.snapshot_id.slice(0, 8)}-${file}"`,
    });
  });

  app.post('/v1/apps/:appId/snapshots/:snapshotId/restore', async (hc) => {
    const s = sessionOf(hc);
    const body = RestoreBody.parse(await readJson(hc));
    const appId = hc.req.param('appId');
    const snapshotId = hc.req.param('snapshotId');
    if (body.target === 'new_app') {
      if (s.demo) throw new HttpError(403, 'creating applications is not available in the demo');
      return hc.json(await restoreToNewApp({ db, blobs }, s, appId, snapshotId, { name: body.name, access: body.access }), 201);
    }
    return hc.json(await restoreInPlace({ db, blobs }, s, appId, snapshotId, body));
  });
}
