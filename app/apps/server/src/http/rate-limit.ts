import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RateLimitedError } from '@flux/core';
import { SESSION_COOKIE_PATTERN } from '../identity/session-cookie.js';

/**
 * One limit on how fast anyone may call the API (#838, CodeQL `js/missing-rate-limiting`). Sign-in, sign-up and the routes that send
 * mail or check a password already have limits of their own (Better Auth's, the encryption routes', the invites'); this is the floor
 * under every other route, which reaches PostgreSQL, the keyring or an outside service for whoever asks. It is a guard against a runaway
 * client or a flood, not a quota: a person using Flux never comes near it, and a whole company behind one address does not either.
 *
 * Fixed one-minute windows, counted in this API process (N processes allow N times as much, as for the live join limit):
 * - per credential (the session cookie, or an Authorization header, hashed): 1,200 requests. A browser measured 136 requests in a busy
 *   minute and about 32 idle on Home, so this is nine times the busiest person;
 * - per address, for requests that carry no credential: 600;
 * - per address, new credentials: 600 a minute. A flood of made-up credentials from one place cannot dodge the count above (each made-up
 *   credential would be a fresh window), yet people behind one address are not limited together: each of them is one credential, and no
 *   address-wide request total exists, so 40 or 400 people behind one office address or one proxy are not in each other's way.
 * Behind a reverse proxy the address is the client's only when FLUX_TRUSTED_PROXIES names the proxy (Fastify `trustProxy`); without it
 * every request comes from the proxy and everyone shares the two per-address budgets (docs/operations/reverse-proxy.md).
 * Memory is bounded: expired windows are dropped as the table grows and, past `maxKeys`, the oldest go first.
 *
 * Only API traffic counts (`/api/`, `/mcp`, `/health`, `/.well-known/`); the web app's own files do not. `FLUX_AUTH_RATE_LIMIT=false`
 * switches this off along with the sign-in limit (the test stacks do; a deployment never should).
 */
export const API_RATE_LIMIT = { credentialPerMinute: 1_200, anonymousPerMinute: 600, newCredentialsPerMinute: 600, windowMs: 60_000, maxKeys: 50_000 } as const;

export interface ApiRateLimitOptions {
  enabled: boolean;
  credentialPerMinute?: number;
  anonymousPerMinute?: number;
  newCredentialsPerMinute?: number;
  windowMs?: number;
  maxKeys?: number;
  now?: () => number;
}

const COUNTED = /^\/(?:api|mcp|health|\.well-known)(?:\/|$)/;

/** What identifies the caller's credential, hashed so the table never holds a session token; null for a request without one. */
export function credentialKey(request: Pick<FastifyRequest, 'headers'>): string | null {
  const authorization = request.headers.authorization;
  const cookie = typeof request.headers.cookie === 'string' ? SESSION_COOKIE_PATTERN.exec(request.headers.cookie) : null;
  const raw = typeof authorization === 'string' && authorization ? `a:${authorization}` : cookie ? `c:${cookie[2]}` : null;
  return raw ? createHash('sha256').update(raw).digest('hex').slice(0, 32) : null;
}

export function useApiRateLimit(app: FastifyInstance, options: ApiRateLimitOptions) {
  if (!options.enabled) return;
  const credentialLimit = options.credentialPerMinute ?? API_RATE_LIMIT.credentialPerMinute;
  const anonymousLimit = options.anonymousPerMinute ?? API_RATE_LIMIT.anonymousPerMinute;
  const newCredentialLimit = options.newCredentialsPerMinute ?? API_RATE_LIMIT.newCredentialsPerMinute;
  const windowMs = options.windowMs ?? API_RATE_LIMIT.windowMs;
  const maxKeys = options.maxKeys ?? API_RATE_LIMIT.maxKeys;
  const now = options.now ?? Date.now;
  if (![credentialLimit, anonymousLimit, newCredentialLimit, maxKeys].every((value) => Number.isInteger(value) && value >= 1) || !(windowMs > 0)) {
    throw new Error('Invalid API rate limit');
  }
  // Insertion order is age order: a key whose window ended is re-inserted when it starts again.
  const windows = new Map<string, { start: number; count: number }>();

  const prune = (at: number) => {
    for (const [key, window] of windows) if (window.start + windowMs <= at) windows.delete(key);
    while (windows.size >= maxKeys) windows.delete(windows.keys().next().value!);
  };
  /** Counts one request under `key`; the seconds until its window ends when the limit is passed, else 0. */
  const take = (key: string, limit: number, at: number): number => {
    let window = windows.get(key);
    if (!window || window.start + windowMs <= at) {
      windows.delete(key);
      if (windows.size >= maxKeys) prune(at);
      window = { start: at, count: 0 };
      windows.set(key, window);
    }
    window.count += 1;
    return window.count > limit ? Math.max(1, Math.ceil((window.start + windowMs - at) / 1000)) : 0;
  };

  app.addHook('onRequest', async (request, reply) => {
    if (!COUNTED.test(request.url.split('?', 1)[0]!)) return;
    const at = now();
    const credential = credentialKey(request);
    let wait = 0;
    if (!credential) wait = take(`anon:${request.ip}`, anonymousLimit, at);
    else {
      const key = `c:${credential}`;
      const known = windows.get(key);
      // A credential this address starts a window for is charged to the address first, so made-up credentials are never free.
      if (!known || known.start + windowMs <= at) wait = take(`new:${request.ip}`, newCredentialLimit, at);
      if (wait === 0) wait = take(key, credentialLimit, at);
    }
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      throw new RateLimitedError(wait, 'Too many requests. Try again shortly.', 'RATE_LIMITED');
    }
  });
}
