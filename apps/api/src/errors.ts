export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    /** The Postgres SQLSTATE it came from, when it came from one (e.g. NXRTY: run it again). */
    public readonly code?: string,
  ) {
    super(message);
  }
}

const PG_STATUS: Record<string, number> = {
  NX401: 401, // no active session user
  NX403: 403, // forbidden
  NX404: 404, // not found
  NX409: 409, // conflict
  NX422: 422, // invalid request
  NX423: 423, // application locked
  NX429: 429, // too many requests (demo starts)
  NX503: 503, // busy (the demo is at capacity)
  NXRTY: 409, // the data moved under a restore; safe to run it again
  '40P01': 409, // deadlock detected: the transaction was rolled back
  '40001': 409, // serialization failure
  '42501': 403, // insufficient privilege / row-level security
  '23505': 409, // unique violation
  '23503': 422, // foreign key violation
  '23514': 422, // check violation
  '22003': 422, // numeric out of range
  '22P02': 422, // invalid text representation
  '22001': 422, // string too long
  '22007': 422, // invalid datetime format
  '22008': 422, // datetime field out of range
  '22009': 422, // invalid time zone displacement
  '22021': 422, // invalid byte sequence (e.g. a NUL character)
  '22P05': 422, // untranslatable character (\u0000 in JSON)
};

interface PgLikeError {
  code?: string;
  message: string;
  detail?: string;
}

/** Translate a Postgres error into an HttpError when it is one we raise on purpose. */
export function fromPgError(err: unknown): HttpError | null {
  const e = err as PgLikeError;
  if (!e || typeof e.code !== 'string') return null;
  const status = PG_STATUS[e.code];
  if (!status) return null;
  let details: unknown;
  if (e.detail) {
    try {
      details = JSON.parse(e.detail);
    } catch {
      details = e.detail;
    }
  }
  return new HttpError(status, e.message, details, e.code);
}
