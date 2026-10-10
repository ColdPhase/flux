import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { idpStandingRepository, type IdpCheckResult, type IdpStandingClaim } from '@flux/db';
import type { Database } from '@flux/core';
import type { OidcConfig } from './config.js';

/**
 * The standing check of a person's account at the identity provider (F-024 S4, #311). Flux keeps the
 * provider's offline refresh token, sealed, and asks the provider on a timer whether it still honours it.
 * The request path never calls the provider: it reads the stored state (`auth_idp_standing`).
 *
 * Decisions recorded in docs/product/mcp-identity.md (S4): a sign-in that returns no refresh token is
 * refused (N1), claims are leased in one short statement and the provider is called with no database
 * resource held (N3), and checks keep running for a suspended identity, so a later success restores it (N5).
 */

const KEY_INFO = 'flux-idp-refresh-token-v1';

/** A key for this one use, derived from FLUX_AUTH_SECRET, so it is not the key Better Auth signs with. */
export function sealKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', authSecret, 'flux-idp', KEY_INFO, 32));
}

/** AES-256-GCM bound to the row, so a sealed token copied to another person or provider does not open. */
export function sealToken(key: Buffer, userId: string, providerId: string, token: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${userId}\n${providerId}`));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function openToken(key: Buffer, userId: string, providerId: string, sealed: string): string | null {
  const [version, iv, tag, body] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${userId}\n${providerId}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** RFC 6750 §3 allows only %x20-21 / %x23-5B / %x5D-7E in `error_description`. */
export function signInAgainMessage(label: string): string {
  const safe = [...label].filter((char) => { const code = char.charCodeAt(0); return code === 0x20 || code === 0x21 || code >= 0x23 && code <= 0x5b || code >= 0x5d && code <= 0x7e; }).join('').trim();
  return `Sign in again with ${safe || 'your identity provider'}.`;
}

type Fetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface ProviderEndpoints { token: string; revocation: string | null }

export interface StandingLog { info(object: object, message: string): void; warn(object: object, message: string): void; error(object: object, message: string): void }

export interface IdpStanding {
  /** Stores a provider sign-in's refresh token and clears sign-in required; revokes the token it replaces. */
  recordSignIn(userId: string, refreshToken: string): Promise<void>;
  /** The state every gate reads: false while any of the person's identities is in sign-in required. */
  stands(userId: string): Promise<boolean>;
  /** One pass of the checker: leases due identities and asks the provider about each. Returns how many it checked. */
  runOnce(now?: Date): Promise<number>;
  /** At startup: accounts without a row are in sign-in required; with the check off, no row refuses anyone. */
  reconcile(now?: Date): Promise<void>;
  start(): void;
  stop(): void;
}

export interface IdpStandingOptions {
  db: Database;
  oidc: OidcConfig;
  authSecret: string;
  log: StandingLog;
  fetcher?: Fetch;
  now?: () => Date;
  /** Lease on a claimed identity; longer than the provider timeout so a slow answer is not raced. */
  leaseMs?: number;
  timeoutMs?: number;
  batch?: number;
  concurrency?: number;
  /** Delay before an inconclusive check is repeated. */
  retryMs?: number;
}

export function createIdpStanding(options: IdpStandingOptions): IdpStanding {
  const { oidc, log, fetcher = fetch as unknown as Fetch, now = () => new Date(), timeoutMs = 10_000, batch = 20, concurrency = 4, retryMs = 60_000 } = options;
  const leaseMs = options.leaseMs ?? timeoutMs * 3;
  const rows = idpStandingRepository(options.db);
  const key = sealKey(options.authSecret);
  let endpoints: { at: number; value: Promise<ProviderEndpoints | null> } | null = null;

  const discover = () => {
    if (!endpoints || now().getTime() - endpoints.at > 300_000) {
      endpoints = { at: now().getTime(), value: (async () => {
        try {
          const response = await fetcher(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(timeoutMs) });
          if (!response.ok) return null;
          const document = await response.json() as Record<string, unknown> | null;
          if (typeof document?.token_endpoint !== 'string') return null;
          return { token: document.token_endpoint, revocation: typeof document.revocation_endpoint === 'string' ? document.revocation_endpoint : null };
        } catch { return null; }
      })() };
    }
    return endpoints.value.then((value) => { if (!value && endpoints) endpoints = null; return value; });
  };

  const form = (fields: Record<string, string>) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(oidc.clientId)}:${encodeURIComponent(oidc.clientSecret)}`).toString('base64')}` },
    body: new URLSearchParams(fields).toString(),
  });

  /** A `refresh_token` grant at the provider's token endpoint, as Flux's client. Nothing from it is logged. */
  async function ask(token: string): Promise<{ result: IdpCheckResult; rotated?: string }> {
    const found = await discover();
    if (!found) return { result: { outcome: 'unknown' } };
    try {
      const response = await fetcher(found.token, { ...form({ grant_type: 'refresh_token', refresh_token: token }), signal: AbortSignal.timeout(timeoutMs) });
      const body = await response.json().catch(() => null) as Record<string, unknown> | null;
      if (response.ok) {
        if (!body || typeof body.access_token !== 'string') return { result: { outcome: 'unknown' } };
        return { result: { outcome: 'success' }, rotated: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : undefined };
      }
      // Only `invalid_grant` says the provider no longer honours the token. invalid_client, 5xx and anything
      // else is a problem with Flux's own credentials or with the provider, which is not a verdict on the person.
      if (response.status >= 400 && response.status < 500 && body?.error === 'invalid_grant') return { result: { outcome: 'sign_in_required', reason: 'invalid_grant' } };
      return { result: { outcome: 'unknown' } };
    } catch {
      return { result: { outcome: 'unknown' } };
    }
  }

  async function revoke(token: string) {
    try {
      const found = await discover();
      if (!found?.revocation) return;
      await fetcher(found.revocation, { ...form({ token, token_type_hint: 'refresh_token' }), signal: AbortSignal.timeout(timeoutMs) });
    } catch { /* best effort: the provider's own session limits still apply */ }
  }

  async function check(claim: IdpStandingClaim) {
    const token = openToken(key, claim.userId, claim.providerId, claim.refreshTokenEnc);
    let result: IdpCheckResult = { outcome: 'sign_in_required', reason: 'unreadable_token' };
    if (token) {
      const answer = await ask(token);
      result = answer.result;
      if (result.outcome === 'success' && answer.rotated && answer.rotated !== token) {
        result = { outcome: 'success', refreshTokenEnc: sealToken(key, claim.userId, claim.providerId, answer.rotated) };
      }
    }
    const done = now();
    const next = new Date(done.getTime() + (result.outcome === 'unknown' ? retryMs : oidc.standingIntervalMs));
    const written = await rows.finish(claim, result, done, next);
    if (!written) return;
    if (result.outcome === 'sign_in_required') log.warn({ userId: claim.userId, reason: result.reason }, 'The identity provider no longer honours this person; sign-in required');
    else if (result.outcome === 'unknown') log.warn({ userId: claim.userId }, 'The identity provider could not be asked; confirmation is unchanged');
  }

  let timer: NodeJS.Timeout | null = null;
  let running = false;
  const self: IdpStanding = {
    async recordSignIn(userId, refreshToken) {
      const at = now();
      const previous = await rows.record(userId, oidc.providerId, sealToken(key, userId, oidc.providerId, refreshToken), at, new Date(at.getTime() + oidc.standingIntervalMs));
      const old = previous ? openToken(key, userId, oidc.providerId, previous) : null;
      if (old && old !== refreshToken) await revoke(old);
    },
    stands: async (userId) => !await rows.refuses(userId),
    async reconcile(at = now()) {
      await rows.forgetOtherProviders(oidc.providerId);
      if (oidc.standing === 'off') await rows.clear(oidc.providerId);
      else await rows.reconcile(oidc.providerId, at);
    },
    async runOnce(at = now()) {
      if (oidc.standing === 'off') return 0;
      const claims = await rows.claim(at, leaseMs, batch, randomUUID());
      let index = 0;
      const worker = async () => { while (index < claims.length) { const claim = claims[index++]!; try { await check(claim); } catch (error) { log.error({ error }, 'Standing check failed'); } } };
      await Promise.all(Array.from({ length: Math.min(concurrency, claims.length) }, worker));
      return claims.length;
    },
    start() {
      if (timer || oidc.standing === 'off') return;
      const tick = async () => {
        if (running) return;
        running = true;
        try { await self.runOnce(); }
        catch (error) { log.error({ error }, 'Standing check pass failed'); }
        finally { running = false; }
      };
      timer = setInterval(() => { void tick(); }, Math.max(1000, Math.min(30_000, Math.floor(oidc.standingIntervalMs / 3))));
      timer.unref();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
  return self;
}
