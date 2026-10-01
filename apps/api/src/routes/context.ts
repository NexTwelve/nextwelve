import type { Context, Hono } from 'hono';
import type { GoogleVerifier } from '../auth/google.js';
import type { SessionSigner } from '../auth/session.js';
import type { Database, SessionContext } from '../db.js';
import type { BlobStore } from '../files/blobs.js';
import { HttpError } from '../errors.js';

export interface Deps {
  db: Database;
  signer: SessionSigner;
  verifier: GoogleVerifier;
  blobs: BlobStore;
}

export type AppEnv = { Variables: { session: SessionContext } };
export type App = Hono<AppEnv>;
export type Ctx = Context<AppEnv>;

export function sessionOf(c: Ctx): SessionContext {
  const s = c.get('session');
  if (!s) throw new HttpError(401, 'not signed in');
  return s;
}

/** Parse a JSON body; an empty body is {}. */
export async function readJson(c: Ctx): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

/** Client details recorded on each change transaction. */
export function clientInfo(c: Ctx, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    ip: c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    user_agent: c.req.header('user-agent') ?? null,
    ...(extra ?? {}),
  };
}
