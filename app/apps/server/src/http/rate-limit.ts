import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { RateLimitedError } from '@flux/core';
import { sessionCookieName, sessionCookieToken } from '../identity/session-cookie.js';
import { isRouted, type RoutedRequest } from './routed-path.js';

/**
 * One limit on how fast anyone may call the API (#838, CodeQL `js/missing-rate-limiting`). Sign-in, sign-up and the routes that send
 * mail or check a password already have limits of their own (Better Auth's, the encryption routes', the invites'); this is the floor
 * under every other route, which reaches PostgreSQL, the keyring or an outside service for whoever asks. It is a guard against a runaway
 * client or a flood, not a quota: a person using Flux never comes near it, and a whole company behind one address does not either.
 *
 * Fixed one-minute windows, counted in this API process (N processes allow N times as much, as for the live join limit):
 * - per credential: 1,200 requests. A browser measured 136 requests in a busy minute and about 32 idle on Home, so this is nine times the
 *   busiest person. A credential is its own only after the server has accepted it, and what is accepted is what the server checked:
 *   the session cookie Better Auth reads (read here the way it reads it: only its name, the first one of that name, trimmed and decoded),
 *   accepted by `requirePrincipal` with the token of the session that cookie resolved to, or the bearer of `/mcp`, accepted once the route
 *   answered it with anything but a 401. A made-up one is never accepted, and nothing else a request carries (another cookie, an
 *   `Authorization` header outside `/mcp`) can get a key accepted. An answer of 401 takes the budget away again: signing out does not (a
 *   signed-out session keeps its budget until its next request is answered 401, as does a revoked or an expired one), and from that
 *   request on it is back with the address. The one thing this does not bound is the number of credentials a person can obtain: each
 *   session is a sign-in (which has its own limits) and each `/mcp` token is one minted through an OAuth consent, and every one of them
 *   has a budget of its own;
 * - per address, for requests that carry no credential: 600;
 * - per address, credentials not accepted yet: 1,200 requests a minute, each request counted. A flood of made-up credentials from one
 *   place is this count and nothing more, yet people behind one address are not limited together: a person is charged to the address
 *   only for the few requests in flight before the first one is accepted (a page opening asks for about fifteen), and no address-wide
 *   request total exists, so 40 or 400 people behind one office address or one proxy are not in each other's way.
 * An address is an IPv4 address as it is and an IPv6 address by its /64, the smallest block a provider gives one customer, who then holds
 * 2^64 addresses (Better Auth's sign-in limit groups the same way; #1040).
 * Behind a reverse proxy the address is the client's only when FLUX_TRUSTED_PROXIES names the proxy (Fastify `trustProxy`); without it
 * every request comes from the proxy and everyone shares the two per-address budgets (docs/operations/reverse-proxy.md).
 * Memory is bounded: expired windows are dropped as the table grows and, past `maxKeys`, the oldest go first.
 *
 * Only API traffic counts (`/api/`, `/mcp`, `/health`, `/.well-known/`); the web app's own files do not. What is API traffic is decided from
 * what the router decided (the route that answers the request and its decoded path, `routed-path.ts`), never from the raw URL: the router
 * decodes `/%61pi` and `/%6dcp` into `/api` and `/mcp` (#1047). `FLUX_AUTH_RATE_LIMIT=false` switches this off along with the sign-in
 * limit (the test stacks do; a deployment never should).
 */
export const API_RATE_LIMIT = { credentialPerMinute: 1_200, anonymousPerMinute: 600, newCredentialsPerMinute: 1_200, windowMs: 60_000, maxKeys: 50_000 } as const;

export interface ApiRateLimitOptions {
  enabled: boolean;
  credentialPerMinute?: number;
  anonymousPerMinute?: number;
  newCredentialsPerMinute?: number;
  windowMs?: number;
  maxKeys?: number;
  /** The name of the session cookie Better Auth reads here (`sessionCookieName(https)`); the http name when not given. */
  sessionCookie?: string;
  now?: () => number;
}

const COUNTED = /^\/(?:api|mcp|health|\.well-known)(?:\/|$)/;
const MCP = /^\/mcp(?:\/|$)/;

/** What a route says when the server accepted the credential of the request: the session it resolved, or (`/mcp` only) the bearer. */
export type CredentialProof = { sessionToken: string } | { bearer: true };

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Say that the server has accepted this request's credential: from now on it has a budget of its own (#1022). A session cookie is accepted
     * with the token of the session the server resolved, and only if that is the token the request's cookie names; a bearer is accepted only
     * on `/mcp`. Anything else is ignored, so a key is never accepted for a credential other than the one that was checked.
     */
    acceptCredential?: ((proof: CredentialProof) => void) | null;
    /** Say that the server refused this request's credential (a 401): it loses a budget of its own. */
    refuseCredential?: (() => void) | null;
  }
}

export interface Credential { kind: 'session' | 'bearer'; key: string }

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex').slice(0, 32);
const sessionKey = (token: string) => hash(`c:${token}`);

/** The token of an `Authorization: <scheme> <token>` header, without a JWT's signature (its last characters carry bits that are ignored). */
function bearerToken(authorization: string): string | null {
  const token = /^\s*\w+\s+(\S+)\s*$/.exec(authorization)?.[1];
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  return dot > 0 ? token.slice(0, dot) : token;
}

/**
 * What identifies the caller's credential, hashed so the table never holds a session token; null for a request without one. The credential
 * depends on the route, because that is what the route reads: `/mcp` takes the bearer of the `Authorization` header and ignores cookies,
 * every other route takes the session cookie Better Auth reads and ignores the header.
 */
export function credentialOf(request: Pick<FastifyRequest, 'headers'> & RoutedRequest, sessionCookie: string = sessionCookieName(false)): Credential | null {
  if (isRouted(request, MCP)) {
    const authorization = request.headers.authorization;
    const token = typeof authorization === 'string' ? bearerToken(authorization) : null;
    return token ? { kind: 'bearer', key: hash(`a:${token}`) } : null;
  }
  const token = sessionCookieToken(request.headers.cookie, sessionCookie);
  return token ? { kind: 'session', key: sessionKey(token) } : null;
}

/** The IPv6 address as eight 16-bit groups; null when it is not one. Zone ids and an IPv4 tail (`::ffff:192.0.2.1`) are understood. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split('%', 1)[0]!.toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, -tail[0].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (fill < 0 || (halves.length === 1 && left.length !== 8)) return null;
  const groups = [...left, ...Array<string>(fill).fill('0'), ...right].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * What the per-address counts call one client: an IPv4 address as it is, an IPv4-mapped IPv6 address as the IPv4 one, any other IPv6 address
 * by its /64 (#1040). Whoever holds a /64 holds 2^64 addresses, so counting each separately would be no limit at all.
 */
export function addressKey(address: string): string {
  if (!isIPv6(address)) return address;
  const groups = ipv6Groups(address);
  if (!groups) return address;
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(':')}::/64`;
}

export function useApiRateLimit(app: FastifyInstance, options: ApiRateLimitOptions) {
  if (!options.enabled) return;
  const credentialLimit = options.credentialPerMinute ?? API_RATE_LIMIT.credentialPerMinute;
  const anonymousLimit = options.anonymousPerMinute ?? API_RATE_LIMIT.anonymousPerMinute;
  const newCredentialLimit = options.newCredentialsPerMinute ?? API_RATE_LIMIT.newCredentialsPerMinute;
  const windowMs = options.windowMs ?? API_RATE_LIMIT.windowMs;
  const maxKeys = options.maxKeys ?? API_RATE_LIMIT.maxKeys;
  const sessionCookie = options.sessionCookie ?? sessionCookieName(false);
  const now = options.now ?? Date.now;
  if (![credentialLimit, anonymousLimit, newCredentialLimit, maxKeys].every((value) => Number.isInteger(value) && value >= 1) || !(windowMs > 0)) {
    throw new Error('Invalid API rate limit');
  }
  // Insertion order is age order: a key whose window ended is re-inserted when it starts again.
  const windows = new Map<string, { start: number; count: number }>();
  // The credentials the server has accepted, oldest first, bounded like the windows. Only an accepted credential has a window of its own.
  const accepted = new Set<string>();
  // The key each request carries, for the 401 that takes its budget away.
  const keys = new WeakMap<object, string>();
  app.decorateRequest('acceptCredential', null);
  app.decorateRequest('refuseCredential', null);

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
    if (!isRouted(request, COUNTED)) return;
    const at = now();
    const credential = credentialOf(request, sessionCookie);
    const address = addressKey(request.ip);
    let wait: number;
    if (!credential) wait = take(`anon:${address}`, anonymousLimit, at);
    else {
      const key = `c:${credential.key}`;
      keys.set(request, key);
      request.refuseCredential = () => { accepted.delete(key); };
      // Until the server has accepted a credential, every request with it is charged to the address: a made-up cookie is never free, and a
      // thousand of them are no more than one address's budget.
      if (accepted.has(key)) wait = take(key, credentialLimit, at);
      else {
        wait = take(`new:${address}`, newCredentialLimit, at);
        request.acceptCredential = (proof) => {
          const checked = credential.kind === 'session' ? 'sessionToken' in proof && sessionKey(proof.sessionToken) === credential.key : 'bearer' in proof;
          if (!checked || accepted.has(key)) return;
          if (accepted.size >= maxKeys) accepted.delete(accepted.values().next().value!);
          accepted.add(key);
        };
      }
    }
    if (wait > 0) {
      reply.header('retry-after', String(wait));
      throw new RateLimitedError(wait, 'Too many requests. Try again shortly.', 'RATE_LIMITED');
    }
  });
  // A 401 for a credential ends its budget of its own: the session was signed out, revoked or has expired, or the token is no longer good.
  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.statusCode === 401) {
      const key = keys.get(request);
      if (key) accepted.delete(key);
    }
    return payload;
  });
}
