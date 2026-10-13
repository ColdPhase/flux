import { createPublicKey, verify, type JsonWebKey as NodeJwk } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { idpLogoutRepository } from '@flux/db';
import type { Database } from '@flux/core';
import type { OidcConfig } from './config.js';
import type { IdpStanding } from './standing.js';

/**
 * OpenID Connect Back-Channel Logout 1.0 receiver (F-024 S3, #314). The provider posts a signed logout
 * token to `/api/v1/identity/oidc/<providerId>/backchannel-logout`; the token is the only credential. This
 * route is outside the Better Auth bridge on purpose. Every answer is 200 or 400 (404 for another provider's
 * path) with `Cache-Control: no-store` (§2.8).
 */
export const BACKCHANNEL_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const TOLERANCE_S = 60;
const MAX_TOKEN_LENGTH = 16_384;

type Fetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
type Jwk = NodeJwk & { kid?: string; alg?: string; use?: string };
export interface LogoutClaims { sub?: string; sid?: string; jti: string; exp: number; revokeOffline: boolean }
export type LogoutVerdict = { ok: true; claims: LogoutClaims } | { ok: false; reason: string };

const SIGNING: Record<string, { hash: string; kty: string; padding?: 'pss'; dsa?: 'ieee-p1363' }> = {
  RS256: { hash: 'sha256', kty: 'RSA' }, RS384: { hash: 'sha384', kty: 'RSA' }, RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', padding: 'pss' },
  ES256: { hash: 'sha256', kty: 'EC', dsa: 'ieee-p1363' }, ES384: { hash: 'sha384', kty: 'EC', dsa: 'ieee-p1363' },
};

const decode = (part: string): unknown => { try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return null; } };
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The provider's signing keys, read lazily and refreshed when a token names a key we do not have (at most every 30 s). */
export function createJwks(oidc: Pick<OidcConfig, 'issuer'>, fetcher: Fetch = fetch as unknown as Fetch, now: () => number = Date.now) {
  let keys: Jwk[] = [];
  let loadedAt = 0;
  async function load() {
    const discovery = await fetcher(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
    const document = discovery.ok ? await discovery.json() as Record<string, unknown> : null;
    if (typeof document?.jwks_uri !== 'string') throw new Error('no jwks_uri');
    const response = await fetcher(document.jwks_uri, { signal: AbortSignal.timeout(5000) });
    const set = response.ok ? await response.json() as { keys?: Jwk[] } : null;
    keys = Array.isArray(set?.keys) ? set.keys : [];
    loadedAt = now();
  }
  return async (kid: string | undefined, kty: string): Promise<Jwk | null> => {
    const find = () => keys.filter((key) => key.kty === kty && (key.use === undefined || key.use === 'sig'))
      .find((key) => kid === undefined ? keys.length === 1 : key.kid === kid) ?? null;
    if (!loadedAt) await load();
    let found = find();
    if (!found && now() - loadedAt > 30_000) { await load(); found = find(); }
    return found;
  };
}

/** §2.6: signature (alg none refused), `iss`, `aud`, `iat`, `exp`, the logout event, `sub` or `sid`, no `nonce`, a `jti`. */
export async function verifyLogoutToken(oidc: Pick<OidcConfig, 'issuer' | 'clientId'>, token: string,
  jwks: (kid: string | undefined, kty: string) => Promise<Jwk | null>, nowSeconds = Math.floor(Date.now() / 1000)): Promise<LogoutVerdict> {
  const bad = (reason: string): LogoutVerdict => ({ ok: false, reason });
  if (!token || token.length > MAX_TOKEN_LENGTH) return bad('logout_token is missing or too long');
  const parts = token.split('.');
  if (parts.length !== 3) return bad('logout_token is not a signed JWT');
  const header = decode(parts[0]!);
  const claims = decode(parts[1]!);
  if (!isObject(header) || !isObject(claims)) return bad('logout_token is malformed');
  const algorithm = typeof header.alg === 'string' ? SIGNING[header.alg] : undefined;
  if (!algorithm) return bad('unsupported signing algorithm');
  let key: Jwk | null;
  try { key = await jwks(typeof header.kid === 'string' ? header.kid : undefined, algorithm.kty); } catch { return bad('the provider keys could not be read'); }
  if (!key) return bad('no matching signing key');
  let valid = false;
  try {
    valid = verify(algorithm.hash, Buffer.from(`${parts[0]}.${parts[1]}`), {
      key: createPublicKey({ key, format: 'jwk' }),
      ...(algorithm.padding ? { padding: 6 /* RSA_PKCS1_PSS_PADDING */ } : {}), ...(algorithm.dsa ? { dsaEncoding: algorithm.dsa } : {}),
    }, Buffer.from(parts[2]!, 'base64url'));
  } catch { valid = false; }
  if (!valid) return bad('invalid signature');
  if (claims.iss !== oidc.issuer) return bad('wrong issuer');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(oidc.clientId)) return bad('wrong audience');
  if (typeof claims.iat !== 'number' || claims.iat > nowSeconds + TOLERANCE_S) return bad('iat is missing or in the future');
  if (typeof claims.exp !== 'number' || claims.exp < nowSeconds - TOLERANCE_S) return bad('the logout token has expired');
  if ('nonce' in claims) return bad('a logout token must not carry a nonce');
  const events = claims.events;
  if (!isObject(events) || !isObject(events[BACKCHANNEL_EVENT])) return bad('missing back-channel logout event');
  const sub = typeof claims.sub === 'string' && claims.sub ? claims.sub : undefined;
  const sid = typeof claims.sid === 'string' && claims.sid && claims.sid.length <= 512 ? claims.sid : undefined;
  if (!sub && !sid) return bad('a logout token needs sub or sid');
  if (typeof claims.jti !== 'string' || !claims.jti || claims.jti.length > 512) return bad('missing jti');
  return { ok: true, claims: { sub, sid, jti: claims.jti, exp: claims.exp, revokeOffline: events.revoke_offline_access === true } };
}

export interface BackchannelOptions {
  db: Database;
  oidc: OidcConfig;
  standing: IdpStanding | null;
  jwks?: ReturnType<typeof createJwks>;
  now?: () => Date;
  log: { info(object: object, message: string): void; warn(object: object, message: string): void };
}

export function registerBackchannelLogout(app: FastifyInstance, { db, oidc, standing, jwks = createJwks(oidc), now = () => new Date(), log }: BackchannelOptions) {
  const rows = idpLogoutRepository(db);
  app.post<{ Params: { providerId: string } }>('/api/v1/identity/oidc/:providerId/backchannel-logout', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.params.providerId !== oidc.providerId) return reply.code(404).send({ error: 'invalid_request', error_description: 'Unknown provider' });
    const body = typeof request.body === 'string' ? new URLSearchParams(request.body) : null;
    const verdict = await verifyLogoutToken(oidc, body?.get('logout_token') ?? '', jwks, Math.floor(now().getTime() / 1000));
    if (!verdict.ok) {
      log.warn({ reason: verdict.reason }, 'Refused a back-channel logout token');
      return reply.code(400).send({ error: 'invalid_request', error_description: verdict.reason });
    }
    const { claims } = verdict;
    const at = now();
    if (!await rows.consumeJti(oidc.providerId, claims.jti, new Date((claims.exp + 60) * 1000), at)) {
      log.warn({}, 'Refused a replayed back-channel logout token');
      return reply.code(400).send({ error: 'invalid_request', error_description: 'The logout token was already used' });
    }
    // sid: the browser sessions created from that provider session. Only sub: all of that identity's sessions.
    const subjectUsers = claims.sub ? await rows.usersBySubject(oidc.providerId, claims.sub) : [];
    let users: string[];
    if (claims.sid) users = await rows.endSessionsBySid(oidc.providerId, claims.sid);
    else { users = subjectUsers; await rows.endSessionsOf(users); }
    // A sid Flux does not know ends nothing, and still answers 200 (§2.8): the session may have ended already.
    const affected = [...new Set([...users, ...(claims.sid ? subjectUsers : [])])];
    if (claims.revokeOffline && affected.length) {
      await rows.revokeMcpRefreshTokens(affected, at);
      await standing?.revokeOffline(affected);
    }
    // A plain logout keeps agents running; the immediate check stops them only when the provider no longer honours the token.
    if (!claims.revokeOffline && affected.length) await standing?.checkSoon(affected);
    log.info({ ended: users.length, revokeOffline: claims.revokeOffline }, 'Back-channel logout processed');
    return reply.code(200).send({});
  });
}
