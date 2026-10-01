import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { GoogleVerifier } from './auth/google.js';
import { sessionFromHeader, type SessionSigner } from './auth/session.js';
import type { Database } from './db.js';
import type { BlobStore } from './files/blobs.js';
import { fromPgError, HttpError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { auditRoutes } from './routes/audit.js';
import { backupRoutes } from './routes/backup.js';
import { authRoutes } from './routes/auth.js';
import { dataRoutes } from './routes/data.js';
import { definitionRoutes } from './routes/definitions.js';
import { formRoutes } from './routes/forms.js';
import { DEMO_MAX_UPLOAD, type DemoConfig, demoGuard, demoRoutes } from './demo.js';
import { deviceRoutes, readOnlyGuard } from './devices.js';
import type { App, AppEnv, Deps } from './routes/context.js';
import { gridRoutes } from './routes/grid.js';

export interface AppOptions {
  db: Database;
  signer: SessionSigner;
  verifier: GoogleVerifier;
  /** File bytes: R2 on Workers, memory or disk in Node. */
  blobs: BlobStore;
  /** Called with unexpected errors (500s). */
  onUnexpectedError?: (err: unknown) => void;
  /** Public settings the browser UI needs before sign-in. */
  publicConfig?: { googleClientId: string | null };
  /** Public demo sandboxes (off unless given and enabled). */
  demo?: DemoConfig;
}

const PUBLIC_PATHS = new Set(['/healthz', '/v1/auth/session', '/v1/config', '/v1/demo', '/v1/devices/claim', '/v1/devices/claim/poll']);

const demoBodyLimit = bodyLimit({
  maxSize: DEMO_MAX_UPLOAD,
  onError: (c) => c.json({ error: 'too_large', message: 'uploads in the demo are limited to 1 MB' }, 413),
});

/** The whole API as a Hono app: runs on Workers (worker.ts) and in Node (tests, scripts). */
export function createApp(opts: AppOptions): App {
  const app = new Hono<AppEnv>();
  const deps: Deps = { db: opts.db, signer: opts.signer, verifier: opts.verifier, blobs: opts.blobs };

  // Public routes that take a small body: refuse anything bigger before reading it all.
  const small = bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ error: 'too_large', message: 'request body is too large' }, 413),
  });
  app.use('/v1/demo/session', small);
  app.use('/v1/devices/claim', small);
  app.use('/v1/devices/claim/poll', small);
  app.use(
    '*',
    bodyLimit({
      maxSize: 26 * 1024 * 1024,
      onError: (c) => c.json({ error: 'too_large', message: 'request body is larger than 25 MB' }, 413),
    }),
  );

  app.use('/v1/*', async (c, next) => {
    // Starting a demo is public (it looks at a demo session itself, to end it); ending one is not.
    const isPublic = PUBLIC_PATHS.has(c.req.path) || (c.req.path === '/v1/demo/session' && c.req.method === 'POST');
    if (!isPublic) {
      const s = await sessionFromHeader(c.req.header('authorization'), deps.signer);
      demoGuard(c, s, opts.demo);
      readOnlyGuard(c, s);
      c.set('session', s);
      // A demo session's body is limited as it arrives, whether or not it says how long it is.
      if (s.demo) return demoBodyLimit(c, next);
    }
    await next();
  });

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      return c.json({ error: 'invalid_request', message: 'request body is invalid', details: err.issues }, 422);
    }
    const http = err instanceof HttpError ? err : fromPgError(err);
    if (http) {
      return c.json(
        { error: statusName(http.status), message: http.message, details: http.details },
        http.status as ContentfulStatusCode,
      );
    }
    opts.onUnexpectedError?.(err);
    console.error(err);
    return c.json({ error: 'internal', message: 'internal error' }, 500);
  });

  app.notFound((c) => c.json({ error: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` }, 404));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/v1/config', (c) => c.json({
    google_client_id: opts.publicConfig?.googleClientId ?? null,
    demo: { enabled: !!opts.demo?.enabled, turnstile_site_key: opts.demo?.enabled ? (opts.demo.turnstileSiteKey ?? null) : null },
  }));
  authRoutes(app, deps);
  adminRoutes(app, deps);
  gridRoutes(app, deps);
  formRoutes(app, deps);
  definitionRoutes(app, deps);
  dataRoutes(app, deps);
  auditRoutes(app, deps);
  backupRoutes(app, deps);
  demoRoutes(app, deps, opts.demo);
  deviceRoutes(app, deps);
  return app;
}

function statusName(status: number): string {
  return (
    {
      400: 'bad_request', 401: 'unauthenticated', 403: 'forbidden', 404: 'not_found', 409: 'conflict',
      410: 'gone', 413: 'too_large', 422: 'invalid_request', 423: 'locked', 429: 'too_many_requests', 503: 'unavailable',
    }[status] ?? 'error'
  );
}
