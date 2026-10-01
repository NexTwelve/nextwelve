import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpError } from '../errors.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  /** Workspace domain; absent for personal Gmail accounts. */
  hd: string | null;
  name: string | null;
}

export type GoogleVerifier = (idToken: string) => Promise<GoogleIdentity>;

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

/**
 * Verify a Google ID token (from ScriptApp.getIdentityToken() in the add-on, or Google
 * sign-in in the console): signature against Google's published keys, issuer, audience
 * (our OAuth client IDs) and expiry.
 */
export function createGoogleVerifier(opts: { audiences: string[]; keys?: JWTVerifyGetKey }): GoogleVerifier {
  if (opts.audiences.length === 0) throw new Error('at least one Google OAuth client ID is required');
  const keys = opts.keys ?? createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return async (idToken: string) => {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, keys, {
        issuer: GOOGLE_ISSUERS,
        audience: opts.audiences,
        algorithms: ['RS256'],
      }));
    } catch (err) {
      throw new HttpError(401, `invalid Google ID token: ${(err as Error).message}`);
    }
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') {
      throw new HttpError(401, 'Google ID token has no sub or email; request the openid and email scopes');
    }
    return {
      sub: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified === true || payload.email_verified === 'true',
      hd: typeof payload.hd === 'string' ? payload.hd.toLowerCase() : null,
      name: typeof payload.name === 'string' ? payload.name : null,
    };
  };
}
