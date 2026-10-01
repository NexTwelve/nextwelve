import type { ExecutionContext } from 'hono';
import type { App } from './routes/context.js';
import { createApp } from './app.js';
import { createGoogleVerifier } from './auth/google.js';
import { createSessionSigner } from './auth/session.js';
import { runNightlySnapshots } from './backup/snapshots.js';
import { loadAuthConfig, loadDemoConfig } from './config.js';
import { sweepDemoTenants } from './demo.js';
import { hyperdriveDatabase } from './db.js';
import { type R2BucketLike, r2BlobStore } from './files/blobs.js';

/** Bindings declared in wrangler.jsonc (SESSION_SECRET is a secret). */
export interface Env {
  HYPERDRIVE: { connectionString: string };
  FILES: R2BucketLike;
  GOOGLE_CLIENT_IDS: string;
  SESSION_SECRET: string;
  SESSION_TTL_SECONDS?: string;
  /** Lets the scheduled job list applications across tenants (`pnpm db:job-key` prints one). */
  JOB_KEY?: string;
  /** Public demo: "true" turns it on (run `pnpm demo:template` once first). */
  DEMO_ENABLED?: string;
  DEMO_MAX_LIVE?: string;
  DEMO_PER_IP_HOUR?: string;
  DEMO_PER_IP_LIVE?: string;
  DEMO_HOURS?: string;
  /** Cloudflare Turnstile in front of "Try the demo" (optional; the secret is a secret). */
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
}

// Built once per isolate and reused across requests, so Google's signing keys stay cached.
let app: App | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!app) {
      const config = loadAuthConfig(env as unknown as Record<string, unknown>);
      app = createApp({
        db: hyperdriveDatabase(env.HYPERDRIVE.connectionString),
        blobs: r2BlobStore(env.FILES),
        signer: createSessionSigner(config.sessionSecret, config.sessionTtlSeconds),
        verifier: createGoogleVerifier({ audiences: config.googleClientIds }),
        // The browser signs in with the first client ID; the add-on's may follow it.
        publicConfig: { googleClientId: config.googleClientIds[0] ?? null },
        demo: loadDemoConfig(env as unknown as Record<string, unknown>),
      });
    }
    return app.fetch(request, env, ctx);
  },

  /**
   * Cron Triggers (wrangler.jsonc): every hour, expired demo copies are removed; once a night, a
   * snapshot of every application that changed, then retention.
   */
  async scheduled(controller: { cron?: string }, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.JOB_KEY) {
      console.error(JSON.stringify({ job: 'scheduled', error: 'JOB_KEY is not set; nothing was run' }));
      return;
    }
    const deps = { db: hyperdriveDatabase(env.HYPERDRIVE.connectionString), blobs: r2BlobStore(env.FILES) };
    ctx.waitUntil(
      sweepDemoTenants(deps, env.JOB_KEY).then(
        (ids) => { if (ids.length) console.log(JSON.stringify({ job: 'demo_sweep', removed: ids.length })); },
        (err) => console.error(JSON.stringify({ job: 'demo_sweep', error: String((err as Error).message ?? err) })),
      ),
    );
    if (controller.cron && controller.cron !== NIGHTLY) return;
    ctx.waitUntil(
      runNightlySnapshots(deps, { jobKey: env.JOB_KEY }).then(
        (results) => {
          const failed = results.filter((r) => r.status === 'failed');
          console.log(JSON.stringify({ job: 'nightly_snapshots', apps: results.length, failed: failed.length, results }));
        },
        (err) => console.error(JSON.stringify({ job: 'nightly_snapshots', error: String((err as Error).message ?? err) })),
      ),
    );
  },
};

/** The nightly cron expression in wrangler.jsonc (the other one is the hourly demo sweep). */
const NIGHTLY = '17 7 * * *';
