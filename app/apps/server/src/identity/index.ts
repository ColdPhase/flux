import type { FastifyInstance } from 'fastify';
import { createSessionRepository } from '@flux/db';
import type { Database } from '@flux/core';
import type { ApiError, IdentityCapabilities } from '@flux/contracts';
import { createAuth, ensureOauthResource, type FluxAuth } from './auth.js';
import { registerAuthBridge } from './bridge.js';
import type { IdentityConfig, OidcConfig } from './config.js';
import { createSmtpMailer, type Mailer } from './mailer.js';
import { originViolation } from './origin.js';
import { createOauthRequests } from './oauth-flow.js';
import { createSignIns } from './sign-in.js';
import { createConfirmation, type Confirmation } from './confirmation.js';
import { cachedReachability, discoveryReachable, waitForDiscovery } from './discovery.js';
import { registerAgentOauthContext } from './oauth-context.js';
import { registerIdentityRoutes } from './routes.js';
import { createSessionResolver, type SessionResolver } from './session.js';
import { registerBackchannelLogout } from './backchannel.js';
import { createIdpStanding, type IdpStanding } from './standing.js';
import { createOfflineStep } from './offline-step.js';

export { loadIdentityConfig, type IdentityConfig } from './config.js';
export { UnauthenticatedError, type SessionContext, type SessionResolver } from './session.js';

export interface IdentityOptions {
  db: Database;
  config: IdentityConfig;
  /** Defaults to SMTP from config; pass null to force password reset unavailable. */
  mailer?: Mailer | null;
}

export interface Identity extends SessionResolver {
  passwordReset: IdentityCapabilities['passwordReset'];
  auth: FluxAuth;
  confirmation: Confirmation;
  /** Null without a provider or with FLUX_OIDC_STANDING=off. */
  standing: IdpStanding | null;
}

/**
 * Starts identity before the server accepts requests. The OAuth resource row is ensured first so
 * that concurrent API processes do not race on Better Auth's seed insert (#316).
 */
export async function startIdentity(app: FastifyInstance, options: IdentityOptions): Promise<Identity> {
  await ensureOauthResource(options.db, options.config.publicOrigin);
  return registerIdentity(app, options);
}

/**
 * Registers the origin guard, the Better Auth bridge and Flux session routes. Call it before
 * other routes so the origin guard hook applies to every state-changing request.
 */
export function registerIdentity(app: FastifyInstance, options: IdentityOptions): Identity {
  const { db, config } = options;
  const mailer = options.mailer === undefined ? (config.smtp ? createSmtpMailer(config.smtp) : null) : options.mailer;
  if (mailer) app.addHook('onClose', async () => mailer.close());
  const oauthRequests = createOauthRequests();
  const signIns = createSignIns();
  const idpStanding = config.oidc ? createIdpStanding({ db, oidc: config.oidc, authSecret: config.secret, log: app.log }) : null;
  const standing = config.oidc?.standing === 'refresh' ? idpStanding : null;
  const confirmation = createConfirmation(db, config.oidc);
  const onMailError = (error: unknown) => app.log.error({ error }, 'Password reset mail failed');
  const build = (oidc: OidcConfig | null) => createAuth({ db, config, installProvider: oidc !== null, mailer, oauthRequests, signIns, standing, confirmation, log: app.log, onMailError });
  // The OIDC plugin reads the provider's discovery document once, when its Better Auth instance starts, and
  // drops the provider if that read fails. The instance is therefore created at startup, and again once the
  // provider answers if it was down then (#310 AC-4), so no restart is needed. Routes hold this stable reference.
  let current: FluxAuth | null = null;
  let providerInstalled = false;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  const auth = new Proxy({} as FluxAuth, {
    get(_target, key) {
      if (!current) throw new Error('Identity is starting');
      return Reflect.get(current, key);
    },
  });
  const start = async (withProvider: boolean) => {
    const next = build(withProvider ? config.oidc : null);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const context = await Promise.race([next.$context, new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Identity provider initialization timed out')), 4000);
      })]);
      // generic-oauth logs a failed discovery and skips the provider without rejecting $context.
      if (withProvider && !context.socialProviders.some((provider) => provider.id === config.oidc?.providerId))
        throw new Error('Identity provider was not registered');
      if (!stopped) { current = next; providerInstalled = withProvider; }
    } finally { clearTimeout(timeout); }
  };
  // Retries with backoff (2 s doubling to 30 s) until the provider answers, then installs it once.
  const awaitProvider = (oidc: OidcConfig, delayMs = 2000) => {
    retry = setTimeout(async () => {
      if (stopped) return;
      if (await discoveryReachable(oidc)) {
        try {
          await start(true);
          app.log.info({ issuer: oidc.issuer }, 'Single sign-on is available');
          return;
        } catch (error) {
          app.log.error({ error }, 'Single sign-on could not start; retrying');
        }
      }
      awaitProvider(oidc, Math.min(delayMs * 2, 30_000));
    }, delayMs);
    retry.unref();
  };
  app.addHook('onClose', async () => { stopped = true; clearTimeout(retry); });
  // Startup waits briefly for the provider: two probes stay inside Fastify's 10 s onReady limit. A provider that
  // is still down is then awaited in the background, so an outage at boot never stops Flux from starting.
  app.addHook('onReady', async () => {
    if (config.oidc && await waitForDiscovery(config.oidc, { attempts: 2 })) {
      try { await start(true); } catch (error) { app.log.warn({ error }, 'Identity provider initialization failed; retrying'); }
    }
    if (!current) await start(false);
    if (config.oidc && !providerInstalled) {
      app.log.warn({ issuer: config.oidc.issuer }, 'The identity provider did not answer; single sign-on is reported as not reachable until it does');
      awaitProvider(config.oidc);
    }
    await idpStanding?.reconcile();
    standing?.start();
  });
  app.addHook('onClose', async () => standing?.stop());
  const sessions = createSessionResolver(auth, standing, confirmation);
  const passwordReset: IdentityCapabilities['passwordReset'] = mailer ? 'available' : 'unavailable';

  app.addHook('onRequest', async (request, reply) => {
    const violation = originViolation(request.method, request.headers, config.publicOrigin);
    if (violation) {
      request.log.warn({ violation, origin: request.headers.origin }, 'Rejected cross-origin state change');
      return reply.code(403).send({ error: 'Forbidden', code: 'ORIGIN_REJECTED', reason: violation } satisfies ApiError & { reason: string });
    }
  });

  const offlineStep = config.oidc && standing ? createOfflineStep({ oidc: config.oidc, publicOrigin: config.publicOrigin, authSecret: config.secret, standing }) : null;
  registerAuthBridge(app, { auth, publicOrigin: config.publicOrigin, passwordReset, oauthRequests, signIns, offlineStep, sessions });
  const reachable = config.oidc ? cachedReachability(config.oidc) : null;
  // The provider is offered from configuration; it is reachable only once installed and answering.
  const sso = async (): Promise<IdentityCapabilities['sso']> =>
    config.oidc && reachable ? { providerId: config.oidc.providerId, label: config.oidc.label, reachable: providerInstalled && await reachable() } : null;
  // Operators register this exact redirect URI with their identity provider (#113).
  if (config.oidc) app.log.info({ issuer: config.oidc.issuer, redirectUri: `${config.publicOrigin}/api/auth/callback/${config.oidc.providerId}` }, 'Single sign-on is on');
  registerIdentityRoutes(app, { sessions, store: createSessionRepository(db), passwordReset, sso });
  if (config.oidc) registerBackchannelLogout(app, { db, oidc: config.oidc, standing, log: app.log });
  registerAgentOauthContext(app, db, sessions, auth, config.publicOrigin);

  return { ...sessions, passwordReset, auth, standing, confirmation };
}
