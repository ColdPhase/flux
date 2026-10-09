import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, createEmailVerificationToken } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { schema } from '@flux/db';
import { agentOauthUseCases, type Database } from '@flux/core';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { createAgentConnectionStore } from '../agent-connection/store.js';
import type { IdentityConfig, OidcConfig } from './config.js';
import type { Mailer } from './mailer.js';
import type { OauthRequests } from './oauth-flow.js';
import { createSignIns, type SignIns } from './sign-in.js';
import { createEmailClaims, type EmailClaims } from './claim.js';
import { createLinkIntents, type LinkIntents } from './link.js';
import { profileFromClaims } from './claim-profile.js';
import { createConfirmation, type Confirmation } from './confirmation.js';
import { signInAgainMessage, type IdpStanding } from './standing.js';

/** Set by the Fastify bridge from the socket or trusted-proxy address; client copies are dropped. */
export const CLIENT_IP_HEADER = 'x-flux-client-ip';
export const SESSION_COOKIE_PREFIX = 'flux';
const AUTH_VERIFY_PATH = '/api/auth/verify-email';
/** Ordinary password routes. They exist only in password mode: with a sign-on provider configured, they are refused (#313). */
const PASSWORD_ROUTES = ['/sign-in/email', '/change-password', '/request-password-reset', '/forget-password', '/reset-password'];

export interface AuthDependencies {
  /** Pool handle; Better Auth's Drizzle adapter reads and writes the auth tables through it. */
  db: Database;
  config: IdentityConfig;
  mailer: Mailer | null;
  onMailError?: (error: unknown) => void;
  oauthRequests: OauthRequests;
  /** Per-request facts about the sign-in in progress; the bridge runs each auth request inside it (#310). */
  signIns?: SignIns;
  /** Defaults to one over `db` and the configured provider (F-024 S2, #312). */
  confirmation?: Confirmation;
  /** Present with a provider and the standing check on (#311): sign-in stores the offline token. */
  standing?: IdpStanding | null;
  log?: { error(object: object, message: string): void };
  /** Defaults to one over `db` (#313): provider sign-ins whose email another account holds. */
  claims?: EmailClaims;
  /** Explicit links of password accounts to the provider before cutover (#315). Defaults to one over `db`. */
  links?: LinkIntents;
}

/**
 * The person an ID token names (#113). The plugin has already verified the token's signature,
 * audience, expiry and nonce against the discovery JWKS; this accepts only claims from the exact
 * configured issuer with a verified email, and ignores groups, roles and domains (Flux access comes
 * from Flux grants). Null refuses the sign-in, which Better Auth turns into the error redirect.
 */
export function oidcUser(oidc: Pick<OidcConfig, 'issuer'>, claims: Record<string, unknown> | null) {
  if (!claims) return null;
  // The plugin keys the Flux account by `sub` (the stable OIDC subject), never by email (#313, #315 AC-3).
  const profile = profileFromClaims(oidc.issuer, claims);
  if (!profile.ok) return null;
  return { id: profile.subject, sub: profile.subject, email: profile.email, emailVerified: true, name: (profile.name ?? profile.email).slice(0, 200) };
}

const IDP_TOKEN_FIELDS = ['accessToken', 'refreshToken', 'idToken', 'accessTokenExpiresAt', 'refreshTokenExpiresAt'] as const;

/** Drops every provider token from an auth_accounts write; the password hash and identity keys stay. */
export function withoutIdpTokens<T extends Record<string, unknown>>(account: T): T {
  const clean: Record<string, unknown> = { ...account };
  for (const field of IDP_TOKEN_FIELDS) if (field in clean) clean[field] = null;
  return clean as T;
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

export function createAuth({ db, config, mailer, onMailError, oauthRequests, signIns = createSignIns(), standing = null, log, confirmation = createConfirmation(db, config.oidc), claims = createEmailClaims(db), links = createLinkIntents(db) }: AuthDependencies) {
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
  // The verification mail (#313): new password accounts while sign-up is `verified`, and a pre-F-024 account the
  // next time it signs in with a password once a provider is configured, so an administrator can find it by address.
  // One per address per minute; the link works once for a day and lands on the sign-in page.
  const lastVerificationMail = new Map<string, number>();
  const sendVerification = async (email: string, url?: string) => {
    if (!mailer) return;
    const key = email.toLowerCase();
    const last = lastVerificationMail.get(key);
    if (last && Date.now() - last < 60_000) return;
    if (lastVerificationMail.size > 5000) lastVerificationMail.clear();
    lastVerificationMail.set(key, Date.now());
    const link = url ?? `${config.publicOrigin}${AUTH_VERIFY_PATH}?token=${await createEmailVerificationToken(config.secret, key, undefined, 86_400)}&callbackURL=${encodeURIComponent('/sign-in?notice=email-verified')}`;
    try {
      await mailer.send({ to: email, subject: 'Verify your email for Flux',
        text: `Confirm that this is your email address for Flux.\n\nOpen this link. It works once and expires in 24 hours:\n\n${link}\n\nIf you did not ask for this, ignore this message.\n` });
    } catch (error) { onMailError?.(error); }
  };
  const verifiedSignUp = config.signup === 'verified';
  const ssoOnly = config.ssoOnly;
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
        // Clients arrive only through Client ID Metadata Documents (the cimd plugin below, which does
        // not consult this hook). No browser session may create, read, list, update, rotate or delete
        // an OAuth client, so a member cannot register a look-alike client with their own redirect
        // (#287). RFC 7591 dynamic registration at /oauth2/register stays off.
        clientPrivileges: () => false,
        allowDynamicClientRegistration: false,
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
          // The refresh grant and the code exchange both come through here: once the provider's confirmation is
          // older than the confirmation age the client must authorize again, through the provider (F-024 S2, #312).
          if (user && await confirmation.lapsed(user.id)) throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: signInAgainMessage(config.oidc?.label ?? '') });
          if (!user || !referenceId || resources?.length !== 1 || resources[0] !== resource) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Agent connection is unavailable' });
          }
          // Refused while the provider no longer honours this person; nothing is revoked (S4, #311).
          if (standing && !await standing.stands(user.id)) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: signInAgainMessage(config.oidc?.label ?? '') });
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
      ...(config.oidc ? [oidcPlugin(config.oidc, signIns, claims, links, log)] : []),
    ],
    // Sign-up is a Flux decision (#313): closed, or the new account must verify its address before it can sign in.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email' && config.signup === 'off') {
          throw new APIError('FORBIDDEN', { message: 'Creating an account with a password is closed on this Flux server', code: 'SIGNUP_CLOSED' });
        }
        // With an active sole provider, ordinary authentication is single sign-on only (F-024 S5a, #313).
        if (ssoOnly && PASSWORD_ROUTES.includes(ctx.path)) {
          throw new APIError('FORBIDDEN', { message: 'Password sign-in and recovery are closed on this Flux server. Sign in with single sign-on', code: 'SSO_ONLY' });
        }
        if (ctx.path === '/sign-in/email') {
          const email = typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
          const password = typeof ctx.body?.password === 'string' ? ctx.body.password : '';
          if (!email || !password) return;
          const [pending] = await db.select({ id: schema.authUsers.id, hash: schema.authAccounts.password }).from(schema.authUsers)
            .innerJoin(schema.authAccounts, and(eq(schema.authAccounts.userId, schema.authUsers.id), eq(schema.authAccounts.providerId, 'credential'), isNotNull(schema.authAccounts.password)))
            .where(and(eq(sql`lower(${schema.authUsers.email})`, email), eq(schema.authUsers.verificationRequired, true), eq(schema.authUsers.emailVerified, false)));
          // Only someone who knows the password learns the account waits for its address to be verified.
          if (pending?.hash && await ctx.context.password.verify({ hash: pending.hash, password })) {
            await sendVerification(email);
            throw new APIError('FORBIDDEN', { message: 'Verify your email address first. A link has been sent to it', code: 'EMAIL_NOT_VERIFIED' });
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const signedIn = ctx.context.newSession?.user;
        // A pre-F-024 account is unverified; once mail is set it gets the link the next time it signs in with its password (#313).
        if (ctx.path === '/sign-in/email' && signedIn && !signedIn.emailVerified && mailer) await sendVerification(signedIn.email);
      }),
    },
    emailVerification: {
      sendOnSignUp: verifiedSignUp,
      autoSignInAfterVerification: false,
      expiresIn: 86_400,
      sendVerificationEmail: async ({ user, url }) => { await sendVerification(user.email, url); },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            // A password sign-up while sign-up is `verified` cannot sign in until the address is verified.
            if (verifiedSignUp && !signIns.getStore()?.providerId) await db.update(schema.authUsers).set({ verificationRequired: true }).where(eq(schema.authUsers.id, user.id));
          },
        },
      },
      session: {
        create: {
          // Every session records how it signed in: password, or the provider id with its IdP `sid` (#310).
          after: async (session) => {
            const sign = signIns.getStore();
            await db.insert(schema.authSessionIdentities).values({
              sessionId: session.id, method: sign?.providerId ?? 'password', idpSid: sign?.idpSid ?? null,
            }).onConflictDoNothing();
            // A provider sign-in is the provider vouching for the person now (F-024 S2, #312).
            if (sign?.providerId) await confirmation.confirm(session.userId, sign.providerId);
            // The provider vouched for the person just now: keep its offline token for the standing check and
            // clear sign-in required (#311). The token never reaches auth_accounts or a log.
            if (sign?.providerId && sign.refreshToken && standing) await standing.recordSignIn(session.userId, sign.refreshToken);
          },
        },
      },
      // The provider's access, ID and refresh tokens never reach auth_accounts. Flux needs only the
      // verified identity; S4 keeps the refresh token in its own encrypted table (#310 AC-8).
      account: {
        create: { before: async (account) => ({ data: withoutIdpTokens(account) }) },
        update: { before: async (account) => ({ data: withoutIdpTokens(account) }) },
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: !verifiedSignUp,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: config.passwordResetTtlSeconds,
      sendResetPassword: mailer
        ? async ({ user, url }) => {
          // A reset never creates a password (password mode only; the route is refused under single sign-on).
          const [credential] = await db.select({ id: schema.authAccounts.id }).from(schema.authAccounts)
            .where(and(eq(schema.authAccounts.userId, user.id), eq(schema.authAccounts.providerId, 'credential'), isNotNull(schema.authAccounts.password)));
          if (!credential) return;
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
    disabledPaths: ['/list-sessions', '/send-verification-email'],
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
function oidcPlugin(oidc: OidcConfig, signIns: SignIns, emailClaims: EmailClaims, links: LinkIntents, log?: { error(object: object, message: string): void }) {
  return genericOAuth({
    config: [{
      providerId: oidc.providerId,
      discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      // offline_access asks for the refresh token the standing check keeps (#311).
      scopes: oidc.standing === 'refresh' ? ['openid', 'email', 'profile', 'offline_access'] : ['openid', 'email', 'profile'],
      pkce: true,
      // Fail closed when discovery publishes no usable issuer/JWKS: claims must come from a verified ID token.
      requireIdTokenVerification: true,
      // The same subject keeps the same Flux person; a changed (verified) email updates it.
      overrideUserInfo: true,
      getUserInfo: async (tokens) => {
        const claims = idTokenClaims(tokens.idToken);
        const user = oidcUser(oidc, claims);
        const sign = signIns.getStore();
        // A link round trip (#315) never signs anyone in: it attaches the subject to the intent's account, or refuses.
        if (sign?.linkRejected) { sign.refused = 'link_expired'; return null; }
        if (user && sign?.link) {
          const outcome = await links.attach(sign.link.id, oidc.providerId, user.sub);
          sign.refused = outcome;
          return null;
        }
        if (user && sign && oidc.standing === 'refresh' && !tokens.refreshToken) {
          // N1: without a refresh token the next check would suspend this person again. Refuse the sign-in and
          // tell the operator; the browser is told why by the bridge.
          sign.refused = 'no_refresh_token';
          log?.error({ issuer: oidc.issuer, providerId: oidc.providerId }, 'The identity provider returned no refresh token, so the sign-in was refused. Grant the offline_access scope and the refresh_token grant to the Flux client, or set FLUX_OIDC_STANDING=off');
          return null;
        }
        if (user && sign) {
          // An address is never a key (#313). Held by a verified account: refused. Held by an unverified one: the
          // person may claim it, from this browser, on the page the bridge sends them to.
          const holder = await emailClaims.holder(oidc.providerId, user.sub, user.email);
          if (holder.kind === 'held') { sign.refused = 'email_held'; return null; }
          if (holder.kind === 'unverified') {
            sign.claimToken = await emailClaims.open(oidc.providerId, user.sub, user.email, holder.userId);
            sign.refused = 'email_claim';
            return null;
          }
          sign.providerId = oidc.providerId;
          if (tokens.refreshToken) sign.refreshToken = tokens.refreshToken;
          if (typeof claims?.sid === 'string' && claims.sid && claims.sid.length <= 512) sign.idpSid = claims.sid;
        }
        return user;
      },
    }],
  });
}
