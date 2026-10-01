import { jwtVerify, SignJWT } from 'jose';
import type { SessionContext } from '../db.js';
import { HttpError } from '../errors.js';

const ISSUER = 'nextwelve';
const AUDIENCE = 'nextwelve-api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionSigner {
  /** ttlSeconds overrides the usual lifetime (demo sessions last as long as their copy). */
  issue(ctx: SessionContext, ttlSeconds?: number): Promise<{ token: string; expiresIn: number }>;
  verify(token: string): Promise<SessionContext>;
}

/** Short-lived HS256 session tokens issued after a Google token is verified once. */
export function createSessionSigner(secret: Uint8Array, ttlSeconds: number): SessionSigner {
  return {
    async issue(ctx, ttl = ttlSeconds) {
      const life = Math.max(1, Math.floor(ttl));
      const claims: Record<string, unknown> = { tid: ctx.tenantId };
      if (ctx.demo) claims.demo = true;
      if (ctx.readOnly) {
        if (!ctx.linkId || !UUID.test(ctx.linkId)) throw new Error('a read-only session needs its device link');
        claims.ro = true;
        claims.lid = ctx.linkId;
      }
      const token = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(ctx.userId)
        .setIssuer(ISSUER)
        .setAudience(AUDIENCE)
        .setIssuedAt()
        .setExpirationTime(`${life}s`)
        .sign(secret);
      return { token, expiresIn: life };
    },
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, secret, { issuer: ISSUER, audience: AUDIENCE, algorithms: ['HS256'] });
        if (typeof payload.sub !== 'string' || typeof payload.tid !== 'string' || !UUID.test(payload.sub) || !UUID.test(payload.tid)) {
          throw new Error('malformed session');
        }
        const out: SessionContext = { userId: payload.sub, tenantId: payload.tid };
        if (payload.demo === true) out.demo = true;
        if (payload.ro !== undefined || payload.lid !== undefined) {
          if (payload.ro !== true || typeof payload.lid !== 'string' || !UUID.test(payload.lid)) throw new Error('malformed session');
          out.readOnly = true;
          out.linkId = payload.lid;
        }
        return out;
      } catch (err) {
        throw new HttpError(401, `invalid session: ${(err as Error).message}`);
      }
    },
  };
}

export async function sessionFromHeader(header: string | undefined, signer: SessionSigner): Promise<SessionContext> {
  const match = /^Bearer\s+(.+)$/i.exec(header ?? '');
  if (!match) throw new HttpError(401, 'missing bearer session token');
  return signer.verify(match[1]!);
}
