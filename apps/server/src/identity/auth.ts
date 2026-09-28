import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';
import { createAgentConnectionStore } from '../agent-connection/store.js';
import type { IdentityConfig } from './config.js';
import type { Mailer } from './mailer.js';

/** Set by the Fastify bridge from the socket or trusted-proxy address; client copies are dropped. */
export const CLIENT_IP_HEADER = 'x-flux-client-ip';
export const SESSION_COOKIE_PREFIX = 'flux';

export interface AuthDependencies {
  /** Pool handle; Better Auth's Drizzle adapter reads and writes the auth tables through it. */
  db: Database;
  config: IdentityConfig;
  mailer: Mailer | null;
  onMailError?: (error: unknown) => void;
}

export function createAuth({ db, config, mailer, onMailError }: AuthDependencies) {
  const connections = createAgentConnectionStore(db);
  const resource = `${config.publicOrigin}/mcp`;
  const connectionForGrant = async (userId: string, sessionId: string, scopes: readonly string[]) => {
    const connection = await connections.selectedForOauth(userId, sessionId);
    if (!connection || scopes.some((scope) => scope !== 'offline_access' && !connection.scopes.includes(scope as 'flux.context.read' | 'flux.proposal.write'))) {
      throw new Error('OAuth agent connection or grant is unavailable');
    }
    return connection;
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
    account: { modelName: 'authAccounts' },
    verification: { modelName: 'authVerifications', storeIdentifier: 'hashed' },
    plugins: [
      jwt(),
      mcp({
        loginPage: '/login', consentPage: '/consent', resource,
        scopes: ['flux.context.read', 'flux.proposal.write', 'offline_access'],
        grantTypes: ['authorization_code', 'refresh_token'],
        postLogin: {
          page: '/connect-agent',
          shouldRedirect: async ({ user, session }) => !await connections.selectedForOauth(user.id, session.id),
          consentReferenceId: async ({ user, session, scopes }) =>
            (await connectionForGrant(user.id, session.id, scopes)).id,
        },
        customAccessTokenClaims: async ({ user, referenceId, scopes, resources }) => {
          if (!user || !referenceId || resources?.some((value) => value !== resource)) {
            throw new Error('OAuth agent connection or resource is unavailable');
          }
          const connection = await connections.resolve(user.id, referenceId);
          if (!connection || scopes.some((scope) => scope !== 'offline_access' && !connection.scopes.includes(scope as 'flux.context.read' | 'flux.proposal.write'))) {
            throw new Error('OAuth agent connection or grant is unavailable');
          }
          return { flux_connection_id: connection.id, flux_owner_user_id: user.id };
        },
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
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
