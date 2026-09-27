import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { schema, type DbExecutor } from '@flux/db';
import type { IdentityConfig } from './config.js';
import type { Mailer } from './mailer.js';

/** Set by the Fastify bridge from the socket or trusted-proxy address; client copies are dropped. */
export const CLIENT_IP_HEADER = 'x-flux-client-ip';
export const SESSION_COOKIE_PREFIX = 'flux';

export interface AuthDependencies {
  /** Pool handle; Better Auth's Drizzle adapter reads and writes the auth tables through it. */
  db: DbExecutor;
  config: IdentityConfig;
  mailer: Mailer | null;
  onMailError?: (error: unknown) => void;
}

export function createAuth({ db, config, mailer, onMailError }: AuthDependencies) {
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
      },
    }),
    user: { modelName: 'authUsers' },
    // No cookie cache: every request reads the session row, so revocation applies immediately.
    session: { modelName: 'authSessions', cookieCache: { enabled: false } },
    account: { modelName: 'authAccounts' },
    verification: { modelName: 'authVerifications', storeIdentifier: 'hashed' },
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
