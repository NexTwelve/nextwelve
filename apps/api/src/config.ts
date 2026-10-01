export interface AuthConfig {
  googleClientIds: string[];
  sessionSecret: Uint8Array;
  sessionTtlSeconds: number;
}

/** Read auth settings from Worker bindings or process.env. */
export function loadAuthConfig(env: Record<string, unknown>): AuthConfig {
  const str = (k: string) => (typeof env[k] === 'string' ? (env[k] as string) : undefined);
  const missing = ['GOOGLE_CLIENT_IDS', 'SESSION_SECRET'].filter((k) => !str(k));
  if (missing.length) throw new Error(`missing configuration: ${missing.join(', ')}`);
  const secret = str('SESSION_SECRET')!;
  if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return {
    googleClientIds: str('GOOGLE_CLIENT_IDS')!.split(',').map((s) => s.trim()).filter(Boolean),
    sessionSecret: new TextEncoder().encode(secret),
    sessionTtlSeconds: Number(str('SESSION_TTL_SECONDS') ?? 900),
  };
}

/** Public demo settings (off unless DEMO_ENABLED is "true"). */
export function loadDemoConfig(env: Record<string, unknown>): import('./demo.js').DemoConfig {
  const str = (k: string) => (typeof env[k] === 'string' && (env[k] as string).trim() !== '' ? (env[k] as string).trim() : undefined);
  const num = (k: string, d: number, min: number, max: number) => {
    const n = Number(str(k) ?? d);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : d;
  };
  return {
    enabled: str('DEMO_ENABLED') === 'true',
    maxLive: num('DEMO_MAX_LIVE', 200, 1, 10_000),
    perIpHour: num('DEMO_PER_IP_HOUR', 5, 1, 1000),
    perIpLive: num('DEMO_PER_IP_LIVE', 10, 1, 10_000),
    hours: num('DEMO_HOURS', 24, 1, 168),
    ipSalt: str('SESSION_SECRET') ?? 'nextwelve',
    turnstileSiteKey: str('TURNSTILE_SITE_KEY'),
    turnstileSecret: str('TURNSTILE_SECRET'),
  };
}
