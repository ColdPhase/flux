import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { schema } from '@flux/db';
import { agentOauthUseCases, type Database } from '@flux/core';
import { createAgentConnectionStore } from '../agent-connection/store.js';
import type { IdentityConfig, OidcConfig } from './config.js';
import type { Mailer } from './mailer.js';
import type { OauthRequests } from './oauth-flow.js';

/** Set by the Fastify bridge from the socket or trusted-proxy address; client copies are dropped. */
export const CLIENT_IP_HEADER = 'x-flux-client-ip';
export const SESSION_COOKIE_PREFIX = 'flux';

export interface AuthDependencies {
  /** Pool handle; Better Auth's Drizzle adapter reads and writes the auth tables through it. */
  db: Database;
  config: IdentityConfig;
  mailer: Mailer | null;
  onMailError?: (error: unknown) => void;
  oauthRequests: OauthRequests;
}

/**
 * The person an ID token names (#113). The plugin has already verified the token's signature,
 * audience, expiry and nonce against the discovery JWKS; this accepts only claims from the exact
 * configured issuer with a verified email, and ignores groups, roles and domains (Flux access comes
 * from Flux grants). Null refuses the sign-in, which Better Auth turns into the error redirect.
 */
export function oidcUser(oidc: Pick<OidcConfig, 'issuer'>, claims: Record<string, unknown> | null) {
  if (!claims) return null;
  const issuer = typeof claims.iss === 'string' ? claims.iss.replace(/\/$/, '') : '';
  const subject = typeof claims.sub === 'string' ? claims.sub : '';
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  if (issuer !== oidc.issuer || !subject || !email || claims.email_verified !== true) return null;
  const name = [claims.name, claims.preferred_username].find((value): value is string => typeof value === 'string' && !!value.trim());
  return { id: subject, email, emailVerified: true, name: (name ?? email).trim().slice(0, 200) };
}

/** The payload of an ID token the plugin verified before calling getUserInfo. */
function idTokenClaims(idToken: string | undefined): Record<string, unknown> | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function createAuth({ db, config, mailer, onMailError, oauthRequests }: AuthDependencies) {
  const connections = agentOauthUseCases(createAgentConnectionStore(db));
  const resource = `${config.publicOrigin}/mcp`;
  const connectionForGrant = async (userId: string, sessionId: string, scopes: readonly string[]) => {
    const request = oauthRequests.getStore();
    if (!request || request.clearedSessionId && request.clearedSessionId !== sessionId) throw new Error('OAuth flow is unavailable');
    const grant = await connections.flowForOauth(userId, sessionId, request.fingerprint);
    const connection = grant?.connection;
    if (!connection || scopes.some((scope) => scope !== 'offline_access' && !connection.scopes.includes(scope as 'flux.context.read' | 'flux.proposal.write' | 'flux.action.execute'))) {
      throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Agent connection is unavailable' });
    }
    return grant!;
  };
  return betterAuth({
    appName: 'Flux',
    baseURL: config.publicOrigin,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.publicOrigin],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        authUsers: schema.authUsers,
        authSessions: schema.authSessions,
        authAccounts: schema.authAccounts,
        authVerifications: schema.authVerifications,
        jwks: schema.jwks,
        oauthClient: schema.oauthClient,
        oauthResource: schema.oauthResource,
        oauthClientResource: schema.oauthClientResource,
        oauthRefreshToken: schema.oauthRefreshToken,
        oauthAccessToken: schema.oauthAccessToken,
        oauthConsent: schema.oauthConsent,
        oauthClientAssertion: schema.oauthClientAssertion,
      },
    }),
    user: { modelName: 'authUsers' },
    // No cookie cache: every request reads the session row, so revocation applies immediately.
    session: { modelName: 'authSessions', cookieCache: { enabled: false } },
    // A new identity never acquires an existing account by asserting the same email (#113).
    account: { modelName: 'authAccounts', accountLinking: { disableImplicitLinking: true } },
    verification: { modelName: 'authVerifications', storeIdentifier: 'hashed' },
    plugins: [
      jwt(),
      mcp({
        loginPage: '/login', consentPage: '/consent', resource,
        scopes: ['flux.context.read', 'flux.proposal.write', 'flux.action.execute', 'offline_access'],
        grantTypes: ['authorization_code', 'refresh_token'],
        postLogin: {
          page: '/connect-agent',
          shouldRedirect: async ({ user, session }) => {
            const request = oauthRequests.getStore();
            return !request || !await connections.flowForOauth(user.id, session.id, request.fingerprint);
          },
          consentReferenceId: async ({ user, session, scopes }) =>
            (await connectionForGrant(user.id, session.id, scopes)).referenceId,
        },
        customAccessTokenClaims: async ({ user, referenceId, scopes, resources }) => {
          if (!user || !referenceId || resources?.length !== 1 || resources[0] !== resource) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Agent connection is unavailable' });
          }
          const grant = await connections.grantForOauth(user.id, referenceId);
          const connection = grant?.connection;
          if (!connection || scopes.some((scope) => scope !== 'offline_access' && !connection.scopes.includes(scope as 'flux.context.read' | 'flux.proposal.write' | 'flux.action.execute'))) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Agent connection is unavailable' });
          }
          return { flux_connection_id: connection.id, flux_owner_user_id: user.id, flux_grant_reference: grant!.referenceId };
        },
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
      ...(config.oidc ? [oidcPlugin(config.oidc)] : []),
    ],
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: config.passwordResetTtlSeconds,
      sendResetPassword: mailer
        ? async ({ user, url }) => {
          try {
            await mailer.send({
              to: user.email,
              subject: 'Reset your Flux password',
              text: `A password reset was requested for your Flux account.\n\nOpen this link to choose a new password. It works once and expires in ${Math.round(config.passwordResetTtlSeconds / 60)} minutes:\n\n${url}\n\nIf you did not ask for this, ignore this message.\n`,
            });
          } catch (error) {
            onMailError?.(error);
            throw error;
          }
        }
        : undefined,
    },
    // Better Auth's list endpoint returns raw session tokens; Flux lists sessions by id instead.
    disabledPaths: ['/list-sessions'],
    rateLimit: { enabled: config.rateLimit, storage: 'memory' },
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: SESSION_COOKIE_PREFIX,
      useSecureCookies: config.publicOrigin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      trustedProxyHeaders: false,
      disableCSRFCheck: false,
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      database: { generateId: () => randomUUID() },
    },
  });
}

export type FluxAuth = ReturnType<typeof createAuth>;

/** One operator-configured OpenID Connect provider for human sign-in (#113). */
function oidcPlugin(oidc: OidcConfig) {
  return genericOAuth({
    config: [{
      providerId: oidc.providerId,
      discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      scopes: ['openid', 'email', 'profile'],
      pkce: true,
      // Fail closed when discovery publishes no usable issuer/JWKS: claims must come from a verified ID token.
      requireIdTokenVerification: true,
      // The same subject keeps the same Flux person; a changed (verified) email updates it.
      overrideUserInfo: true,
      getUserInfo: async (tokens) => oidcUser(oidc, idTokenClaims(tokens.idToken)),
    }],
  });
}
