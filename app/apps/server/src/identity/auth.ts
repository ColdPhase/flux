import { randomUUID } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { verifyPassword } from 'better-auth/crypto';
import { APIError, createAuthMiddleware, createEmailVerificationToken, getSessionFromCtx } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import { mcp } from '@better-auth/mcp';
import { accessPorts, schema, type Database } from '@flux/db';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@flux/contracts';
import { agentOauthUseCases, companyDisplayName, DomainError, joinCompany } from '@flux/core';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { createAgentConnectionStore } from '../agent-connection/store.js';
import { createOneClickSignIn } from '../agent-connection/one-click.js';
import type { IdentityConfig, OidcConfig } from './config.js';
import type { Mailer } from './mailer.js';
import type { OauthRequests } from './oauth-flow.js';
import { createSignIns, type SignIns } from './sign-in.js';
import { createEmailClaims, type EmailClaims } from './claim.js';
import { createLinkIntents, type LinkIntents } from './link.js';
import { profileFromClaims } from './claim-profile.js';
import { offlineStepProblem } from './offline-step.js';
import { createConfirmation, type Confirmation } from './confirmation.js';
import { signInAgainMessage, type IdpStanding } from './standing.js';
import { SESSION_COOKIE_PREFIX } from './session-cookie.js';
import { accountKey, securityEvent, type SecurityLogger } from '../security-log.js';
import { authSecurityEvent } from './security-events.js';
import { PASSWORD_TOO_WEAK_MESSAGE, passwordProblem } from './password-policy.js';
import { createSignInThrottle } from './sign-in-throttle.js';
import { createDevices } from './devices.js';
import { authLogEntry } from './auth-log.js';

/** Set by the Fastify bridge from the socket or trusted-proxy address; client copies are dropped. */
export const CLIENT_IP_HEADER = 'x-flux-client-ip';
/** Set by the bridge to the Fastify request id, so a security event of an auth route carries the id of its access-log lines. */
export const REQUEST_ID_HEADER = 'x-flux-request-id';
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
  log?: SecurityLogger & { error(object: object, message: string): void };
  /** Defaults to one over `db` (#313): provider sign-ins whose email another account holds. */
  claims?: EmailClaims;
  /** Explicit links of password accounts to the provider before cutover (#315). Defaults to one over `db`. */
  links?: LinkIntents;
  /** Discovery recovery may temporarily omit the plugin, while retaining the configured authentication mode. */
  installProvider?: boolean;
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

/** Snapshot the authorizing session at code redemption, keyed to the immutable refresh lineage (#310 AC-3). */
export async function recordGrantAuthentication(db: Database, userId: string, sessionId: string | undefined,
  referenceId: string, authorizationCodeId: string) {
  const [previous] = await db.select().from(schema.oauthGrantAuthentication)
    .where(eq(schema.oauthGrantAuthentication.authorizationCodeId, authorizationCodeId));
  if (previous) {
    if (previous.userId !== userId || previous.referenceId !== referenceId)
      throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Grant authentication is unavailable' });
    return; // Refresh and unrelated sessions cannot replace the original facts.
  }
  if (!sessionId) throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Sign-in is unavailable' });
  const [facts] = await db.select({ method: schema.authSessionIdentities.method, idpSid: schema.authSessionIdentities.idpSid,
    confirmedAt: schema.authSessionIdentities.confirmedAt }).from(schema.authSessionIdentities)
    .innerJoin(schema.authSessions, eq(schema.authSessions.id, schema.authSessionIdentities.sessionId))
    .where(and(eq(schema.authSessionIdentities.sessionId, sessionId), eq(schema.authSessions.userId, userId)));
  if (!facts) throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Sign-in is unavailable' });
  await db.insert(schema.oauthGrantAuthentication).values({ authorizationCodeId, userId, referenceId,
    authMethod: facts.method, authIdpSid: facts.idpSid, authConfirmedAt: facts.confirmedAt }).onConflictDoNothing();
}

/** Where Better Auth's log lines go when the API gives no logger (tests that build the auth by itself). */
const CONSOLE_LOG = {
  info: (object: object, message: string) => console.info(message, object),
  warn: (object: object, message: string) => console.warn(message, object),
  error: (object: object, message: string) => console.error(message, object),
};

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

/** The MCP resource identifier Better Auth seeds into `oauth_resource` at initialization. */
export function mcpResourceIdentifier(publicOrigin: string): string {
  return `${publicOrigin}/mcp`;
}

/**
 * Inserts the MCP resource row if it is missing, and fails when it cannot (#316, #916). `startIdentity` calls it before anything is
 * registered, so a database that cannot take the row stops the server at startup. That is the point of calling it, not a race
 * workaround: Better Auth 1.7.18 seeds the same row itself, re-reads it after a lost insert (two processes starting together are safe
 * without this) and, when the insert fails, logs it and retries on the first resource access, which would start a server whose OAuth
 * does not work. `ON CONFLICT DO NOTHING` makes a second start, or a second process, leave the one row. Do not remove the call:
 * `oauth-initialization.test.ts` ("startIdentity stops the server...") fails without it.
 */
export async function ensureOauthResource(db: Database, publicOrigin: string): Promise<void> {
  const identifier = mcpResourceIdentifier(publicOrigin);
  const now = new Date();
  await db.insert(schema.oauthResource).values({
    id: randomUUID(),
    identifier,
    name: identifier,
    dpopBoundAccessTokensRequired: false,
    disabled: false,
    policyVersion: 1,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoNothing({ target: schema.oauthResource.identifier });
}

export function createAuth({ db, config, mailer, onMailError, oauthRequests, signIns = createSignIns(), installProvider = true, standing = null, log, confirmation = createConfirmation(db, config.oidc, undefined, config.ssoOnly), claims = createEmailClaims(db), links = createLinkIntents(db) }: AuthDependencies) {
  const connectionStore = createAgentConnectionStore(db);
  const connections = agentOauthUseCases(connectionStore);
  const throttle = createSignInThrottle(db, config.secret);
  const devices = createDevices(db, config.secret, config.publicOrigin.startsWith('https:'));
  /**
   * The password version of the account whose hash a check accepted, or null when it has changed since (#1088, migration 0042). Read by user and
   * compared here: the hash is never a parameter of a statement, because a failed statement is quoted with its parameters in the error.
   */
  const acceptedPasswordVersion = async (userId: string, accepted: string): Promise<number | null> => {
    const [credential] = await db.select({ password: schema.authAccounts.password, version: schema.authAccounts.passwordVersion }).from(schema.authAccounts)
      .where(and(eq(schema.authAccounts.userId, userId), eq(schema.authAccounts.providerId, 'credential')));
    return credential?.password === accepted ? credential.version : null;
  };
  const signIn = createOneClickSignIn(db);
  const resource = mcpResourceIdentifier(config.publicOrigin);
  const unavailable = () => new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: 'Agent connection is unavailable' });
  /**
   * The grant a client's authorization continues with (#859). Looking at a request never writes: a client that already has a live
   * connection of this person's gets its reference, and any other gets one no consent can match, so the person is asked. Only the
   * person's approval on the consent page (`consenting`, from the signed request and the session that reached the page) makes the
   * connection and its agent, so a refusal, a forged request or another browser's session leaves nothing behind.
   */
  const referenceFor = async (userId: string, sessionId: string) => {
    const request = oauthRequests.getStore();
    // The authorization resumed by a provider sign-in callback carries no request context: nothing is known about the client yet, so the
    // reference is one no consent can match and the person is asked on the consent page. It writes nothing.
    if (!request) return `flux-pending:${randomUUID()}`;
    // Another browser's session is refused as a plain 400 and leaves nothing behind.
    if (request.consenting ? request.clearedSessionId !== sessionId : request.clearedSessionId && request.clearedSessionId !== sessionId) throw unavailable();
    try {
      const grant = request.consenting && request.flow ? await signIn.connect(userId, request.flow) : await signIn.held(userId, request.clientId);
      return grant?.referenceId ?? `flux-pending:${randomUUID()}`;
    } catch (error) {
      if (error instanceof DomainError) throw unavailable();
      throw error;
    }
  };
  // The verification mail (#313): new password accounts while sign-up is `verified`, and a pre-F-024 account the
  // next time it signs in with a password once a provider is configured, so an administrator can find it by address.
  // One per address per minute; the link works once for a day and lands on the sign-in page.
  const lastVerificationMail = new Map<string, number>();
  const lastExistingMail = new Map<string, number>();
  // The guide: the company's name is in its emails. Nothing is added before setup or while it has the name setup gave it.
  const atCompany = async () => { const name = await companyDisplayName(db, accessPorts); return name ? ` at ${name}` : ''; };
  /** One mail of a kind per address per minute (the map is bounded), so sign-up cannot be used to mail someone repeatedly. */
  const oncePerMinute = (sent: Map<string, number>, key: string) => {
    const last = sent.get(key);
    if (last && Date.now() - last < 60_000) return false;
    if (sent.size > 5000) sent.clear();
    sent.set(key, Date.now());
    return true;
  };
  const sendVerification = async (email: string, url?: string) => {
    if (!mailer) return;
    const key = email.toLowerCase();
    if (!oncePerMinute(lastVerificationMail, key)) return;
    const link = url ?? `${config.publicOrigin}${AUTH_VERIFY_PATH}?token=${await createEmailVerificationToken(config.secret, key, undefined, 86_400)}&callbackURL=${encodeURIComponent('/sign-in?notice=email-verified')}`;
    try {
      await mailer.send({ to: email, subject: 'Verify your email for Flux',
        text: `Confirm that this is your email address for Flux${await atCompany()}.\n\nOpen this link. It works once and expires in 24 hours:\n\n${link}\n\nIf you did not ask for this, ignore this message.\n` });
    } catch (error) { onMailError?.(error); }
  };
  const verifiedSignUp = config.signup === 'verified';
  const ssoOnly = config.ssoOnly;
  /** Where a request came from and which access-log lines are its own, for a security event (#997). */
  const whereFrom = (ctx: { request?: Request; headers?: Headers }) => {
    const headers = ctx.request?.headers ?? ctx.headers;
    return { ip: headers?.get(CLIENT_IP_HEADER) ?? undefined, reqId: headers?.get(REQUEST_ID_HEADER) ?? undefined };
  };
  /** The address (and browser) whose back-off a request already counted in `before`, found again in `after` (the same request context). */
  const counted = new WeakMap<object, { email: string; device?: string }>();
  /** The address whose password a reset is about to change, and the device of this browser if it knew the account, so the browser that finishes the reset is remembered. */
  const resetting = new WeakMap<object, { userId: string; email: string; device?: string }>();
  // The answer says neither when the wait ends nor how long it is: with the exact second, a stranger could time one guess for each end (#990).
  const throttledSignIn = (what: 'sign-in' | 'change') => new APIError('TOO_MANY_REQUESTS', {
    message: what === 'sign-in' ? 'Too many sign-in attempts for this account. Try again in a few minutes'
      : 'Too many attempts to change this account. Try again in a few minutes',
    code: 'SIGN_IN_THROTTLED' });
  // A browser that signed in to an account, or finished its password reset, is remembered (a signed cookie that names the account): its
  // wrong guesses count in a wait of their own, so a stranger's guesses at the address never keep the person out (OWASP device cookies).
  // A reset and "Sign out all other devices" end every older copy of the cookie (the account's device generation, `devices.ts`, #1031).
  const { cookie: deviceCookie } = devices;
  type CookieContext = { getCookie(name: string): string | null | undefined; setCookie(name: string, value: string, options: Record<string, unknown>): unknown };
  const knownDevice = (ctx: CookieContext, email: string) => devices.known(ctx.getCookie(deviceCookie.name), email);
  /** `generation` is the one this request's own raise made, when it made one (#1067). */
  const rememberDevice = async (ctx: CookieContext, email: string, generation?: number) => {
    ctx.setCookie(deviceCookie.name, await devices.remember(ctx.getCookie(deviceCookie.name), email, generation), deviceCookie.options);
  };
  return betterAuth({
    appName: 'Flux',
    // An error that is not Better Auth's own (a failed statement: drizzle quotes it with its parameters, which can be a password hash or an
    // email address) is not logged by Better Auth's router or by better-call, which would print it whole. It goes to Flux's error handler,
    // which logs only the class, the SQLSTATE and the constraint and answers 500 (#991, ASVS V7.4.1; found in the review of #1093). Better Auth's own
    // errors (a wrong password, a refused origin) are still answered as they were.
    onAPIError: { throw: true },
    // Better Auth's own log lines go to Flux's logger, reduced to what says why something failed and nothing personal or secret (`auth-log.ts`):
    // a failed statement is quoted with its parameters (a sign-up that lost a race with the same address prints the email and the name), and
    // Better Auth hands that error to its logger (#1088, found in the delta reviews of #1093 and #1098).
    logger: {
      log: (level, message, ...details) => {
        const entry = authLogEntry(level, message, details);
        (log ?? CONSOLE_LOG)[entry.level](entry.object, entry.text);
      },
    },
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
        authRateLimits: schema.authRateLimits,
      },
    }),
    // Settings → Account (#763 SG-1): a person changes their own address. An unverified address (no outgoing mail) changes
    // at once; a verified one only after the link sent to the new address is opened. The hook below asks for the
    // current password first, and single sign-on refuses it (the provider owns the address).
    user: { modelName: 'authUsers', changeEmail: { enabled: true, updateEmailWithoutVerification: true } },
    // No cookie cache: every request reads the session row, so revocation applies immediately. A session ends after `sessionIdleSeconds`
    // without use (it is renewed when used after `updateAge`); the longest it can last is `sessionMaxAgeSeconds`, enforced when it is read
    // (`createSessionResolver`), because Better Auth only renews it (#993).
    session: { modelName: 'authSessions', cookieCache: { enabled: false }, expiresIn: config.sessionIdleSeconds,
      updateAge: Math.min(86_400, Math.max(60, Math.floor(config.sessionIdleSeconds / 4))),
      additionalFields: { passwordVersionChecked: { type: 'number', required: false, input: false, returned: false } } },
    // A new identity never acquires an existing account by asserting the same email (#113).
    account: { modelName: 'authAccounts', accountLinking: { disableImplicitLinking: true },
      additionalFields: { passwordVersionExpected: { type: 'number', required: false, input: false, returned: false } } },
    verification: { modelName: 'authVerifications', storeIdentifier: 'hashed' },
    plugins: [
      // The OAuth tokens of the MCP plugin are signed with these keys. Better Auth would also sign a JWT on every session read for a
      // `set-auth-jwt` header that nothing in Flux reads: one more statement and one signature per session resolution, four per work read (#850).
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        loginPage: '/login', consentPage: '/consent', resource,
        // One scope: the client may stay connected until the person disconnects it. What it may do is not a scope. It acts with its
        // owner's rights and does what its "What it may do" says, both read again at every call (#859).
        scopes: ['offline_access'],
        grantTypes: ['authorization_code', 'refresh_token'],
        // Clients arrive only through Client ID Metadata Documents (the cimd plugin below, which does
        // not consult this hook). No browser session may create, read, list, update, rotate or delete
        // an OAuth client, so a member cannot register a look-alike client with their own redirect
        // (#287). RFC 7591 dynamic registration at /oauth2/register stays off.
        clientPrivileges: () => false,
        allowDynamicClientRegistration: false,
        postLogin: {
          page: '/connect-agent',
          // Nothing is chosen between signing in and the consent page: the person's one decision is on that page (#859).
          shouldRedirect: () => false,
          consentReferenceId: async ({ user, session }) => {
            if (!user || !session) throw new Error('OAuth flow is unavailable');
            return referenceFor(user.id, session.id);
          },
        },
        customAccessTokenClaims: async (args) => {
          const { user, referenceId, resources } = args;
          // The pinned provider patch exposes its validated session and code-family key at issuance.
          const { sessionId, authorizationCodeId } = args as typeof args & { sessionId?: string; authorizationCodeId?: string };
          // The refresh grant and the code exchange both come through here: once the provider's confirmation is
          // older than the confirmation age the client must authorize again, through the provider (F-024 S2, #312).
          if (user && await confirmation.lapsed(user.id)) throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: signInAgainMessage(config.oidc?.label ?? '') });
          if (!user || !referenceId || resources?.length !== 1 || resources[0] !== resource) {
            throw unavailable();
          }
          // Refused while the provider no longer honours this person; nothing is revoked (S4, #311).
          if (standing && !await standing.stands(user.id)) {
            throw new APIError('BAD_REQUEST', { error: 'invalid_grant', error_description: signInAgainMessage(config.oidc?.label ?? '') });
          }
          const grant = await connections.grantForOauth(user.id, referenceId);
          const connection = grant?.connection;
          if (!connection) throw unavailable();
          if (authorizationCodeId) await recordGrantAuthentication(db, user.id, sessionId, referenceId, authorizationCodeId);
          return { flux_connection_id: connection.id, flux_owner_user_id: user.id, flux_grant_reference: grant!.referenceId,
            ...(authorizationCodeId ? { flux_authentication_reference: authorizationCodeId } : {}) };
        },
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
      ...(config.oidc && installProvider ? [oidcPlugin(config.oidc, signIns, claims, links, log, config.ssoMode === 'prepare')] : []),
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
        // Whose password a reset changes (a token that does not name an account changes nothing).
        let resetUser: { id?: unknown; name?: unknown; email?: unknown } | null = null;
        if (ctx.path === '/reset-password') {
          const token = ctx.body?.token ?? ctx.query?.token;
          const reset = typeof token === 'string' ? await ctx.context.internalAdapter.findVerificationValue(`reset-password:${token}`) : null;
          resetUser = reset ? await ctx.context.internalAdapter.findUserById(reset.value) : null;
          if (typeof resetUser?.email === 'string') resetting.set(ctx.context, { userId: String(resetUser.id), email: resetUser.email, device: (await knownDevice(ctx, resetUser.email))?.id });
        }
        // A password the person chooses (sign-up, reset, change) must not be a common or easy-to-guess one, nor built from their own name or
        // address (#990). The length rule is Better Auth's (`minPasswordLength`), so a password outside it falls through to its own error.
        if (ctx.path === '/sign-up/email' || ctx.path === '/reset-password' || ctx.path === '/change-password') {
          const chosen = ctx.path === '/sign-up/email' ? ctx.body?.password : ctx.body?.newPassword;
          if (typeof chosen === 'string' && chosen.length >= PASSWORD_MIN_LENGTH && chosen.length <= PASSWORD_MAX_LENGTH) {
            let person: { name?: unknown; email?: unknown } | null | undefined = ctx.body;
            if (ctx.path === '/change-password') person = (await getSessionFromCtx(ctx))?.user;
            if (ctx.path === '/reset-password') person = resetUser;
            const personal = [person?.name, person?.email].filter((value): value is string => typeof value === 'string');
            if (passwordProblem(chosen, personal)) throw new APIError('BAD_REQUEST', { message: PASSWORD_TOO_WEAK_MESSAGE, code: 'PASSWORD_TOO_WEAK' });
          }
        }
        // Changing the password or the address asks for the current password, so a session left open could be used to guess it: the same
        // back-off counts those attempts for the account (#990). A success clears it, as a sign-in does.
        if (ctx.path === '/change-password' || ctx.path === '/change-email') {
          const holder = (await getSessionFromCtx(ctx))?.user.email;
          if (holder) {
            const device = await knownDevice(ctx, holder);
            if (await throttle.attempt(holder, device?.id) > 0) {
              if (log) securityEvent(log, { event: ctx.path === '/change-password' ? 'password_changed' : 'email_changed', outcome: 'limited', reason: 'account_back_off',
                account: accountKey(config.secret, holder), ...whereFrom(ctx) });
              throw throttledSignIn('change');
            }
            counted.set(ctx.context, { email: holder, device: device?.id });
          }
        }
        if (ctx.path === '/change-email') {
          if (ssoOnly || config.oidc) throw new APIError('FORBIDDEN', { message: 'Your email address comes from single sign-on on this Flux server', code: 'SSO_ONLY' });
          // A change of address proves the person knows the password, like a change of password does, so a session left
          // open on someone else's device cannot move the account to another address and then reset its password.
          const password = typeof ctx.body?.currentPassword === 'string' ? ctx.body.currentPassword : '';
          const session = await getSessionFromCtx(ctx);
          const [credential] = session ? await db.select({ hash: schema.authAccounts.password }).from(schema.authAccounts)
            .where(and(eq(schema.authAccounts.userId, session.user.id), eq(schema.authAccounts.providerId, 'credential'), isNotNull(schema.authAccounts.password))) : [];
          if (!password || !credential?.hash || !await ctx.context.password.verify({ hash: credential.hash, password })) {
            throw new APIError('BAD_REQUEST', { message: 'Your current password is not right', code: 'INVALID_PASSWORD' });
          }
        }
        if (ctx.path === '/sign-in/email') {
          const email = typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : '';
          const password = typeof ctx.body?.password === 'string' ? ctx.body.password : '';
          if (!email || !password) return;
          // The account's own back-off, shared by every API process and not escaped by changing the client address (#990). A browser that
          // has signed in to this account before counts in a wait of its own.
          const device = await knownDevice(ctx, email);
          if (await throttle.attempt(email, device?.id) > 0) {
            if (log) securityEvent(log, { event: 'sign_in', outcome: 'limited', reason: 'account_back_off', account: accountKey(config.secret, email), ...whereFrom(ctx) });
            throw throttledSignIn('sign-in');
          }
          counted.set(ctx.context, { email, device: device?.id });
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
        // The person knew the password (a sign-in, or a change of password or address that went through): the count starts again, and the
        // browser is remembered. A browser that had the cookie clears only its own count, never a stranger's wait on the account.
        const countedFor = counted.get(ctx.context);
        const succeeded = ctx.path === '/sign-in/email' ? !!signedIn : !(ctx.context.returned instanceof APIError);
        if (countedFor && succeeded) await throttle.clear(countedFor.email, countedFor.device);
        if (signedIn && (ctx.path === '/sign-in/email' || ctx.path === '/sign-up/email')) await rememberDevice(ctx, signedIn.email);
        // A reset is the way back for the owner of the mailbox: the browser that finished it is remembered too, with the new device
        // generation (`onPasswordReset` raised it, so a copy of its old cookie is no longer this browser, #1031).
        const resetFor = resetting.get(ctx.context);
        if (resetFor && !(ctx.context.returned instanceof APIError)) {
          await throttle.clear(resetFor.email, resetFor.device);
          // Raised again now that the reset has ended every session: a "Sign out all other devices" that was running with one of them can
          // no longer raise it, and the cookie below is for the generation this raise made (#1067).
          const generation = await devices.endAll(resetFor.userId);
          if (generation !== null) await rememberDevice(ctx, resetFor.email, generation);
        }
        // "Sign out my other devices" with a password change ends the person's other browsers, and so their local AI clients (#989)
        // and every copy of the device cookie but this browser's own (#1031).
        let disconnected = 0;
        if (ctx.path === '/change-password' && ctx.body?.revokeOtherSessions === true && signedIn) {
          disconnected = await connectionStore.disconnectClients(signedIn.id);
          const generation = await devices.endAll(signedIn.id);
          if (generation !== null) await rememberDevice(ctx, signedIn.email, generation);
        }
        if (!log) return;
        // The security event of the route (#997). A reset is recorded where its person is known (`onPasswordReset`).
        const place = whereFrom(ctx);
        const acting = signedIn?.id ?? (/^\/(change-password|change-email|oauth2\/consent)$/.test(ctx.path) ? (await getSessionFromCtx(ctx))?.user.id : undefined);
        const event = authSecurityEvent({ path: ctx.path, body: ctx.body, returned: ctx.context.returned, userId: acting });
        if (!event || (ctx.path === '/reset-password' && event.outcome === 'success')) return;
        const named = typeof ctx.body?.email === 'string' && (ctx.path === '/sign-in/email' || ctx.path === '/request-password-reset' || ctx.path === '/forget-password');
        securityEvent(log, { ...event, ...(named ? { account: accountKey(config.secret, ctx.body.email) } : {}), ...place });
        if (disconnected > 0 && acting) securityEvent(log, { event: 'client_disconnected', outcome: 'success', reason: 'password_change', userId: acting, count: disconnected, ...place });
        if (ctx.path === '/change-password' && ctx.body?.revokeOtherSessions === true && acting && event.outcome === 'success')
          securityEvent(log, { event: 'sessions_revoked', outcome: 'success', reason: 'password_change', userId: acting, ...place });
      }),
    },
    emailVerification: {
      sendOnSignUp: verifiedSignUp,
      autoSignInAfterVerification: false,
      expiresIn: 86_400,
      sendVerificationEmail: async ({ user, url }) => { await sendVerification(user.email, url); },
      afterEmailVerification: async (user) => { await joinCompany(user.id, { sso: false }, db, accessPorts); },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const sso = !!signIns.getStore()?.providerId;
            // A password sign-up while sign-up is `verified` cannot sign in until the address is verified, and sets up
            // nothing before that: a mistyped address must not leave a company whose owner nobody can be.
            if (verifiedSignUp && !sso) {
              await db.update(schema.authUsers).set({ verificationRequired: true }).where(eq(schema.authUsers.id, user.id));
              return;
            }
            // F-037: the first account sets up the company as its owner.
            await joinCompany(user.id, { sso }, db, accessPorts);
          },
        },
      },
      session: {
        create: {
          // A password check that accepted a hash which has since changed (a reset came in between) creates no session: the database refuses
          // the insert too (migration 0042), this refuses it first and cleanly (#1088).
          before: async (session) => {
            const checked = signIns.getStore()?.passwordChecked;
            if (!checked) return;
            const version = await acceptedPasswordVersion(session.userId, checked);
            if (version === null) throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' });
            return { data: { passwordVersionChecked: version } };
          },
          // Every session records how it signed in: password, or the provider id with its IdP `sid` (#310).
          after: async (session) => {
            const sign = signIns.getStore();
            try {
              await db.insert(schema.authSessionIdentities).values({
                sessionId: session.id, method: sign?.providerId ?? 'password', idpSid: sign?.idpSid ?? null,
              }).onConflictDoNothing();
            } catch (error) {
              // A reset that ended the sessions after this one was written (the password check was still current when the row went in) took it away
              // before it could be recorded: the sign-in lost the race, and is answered as a refused one (#1088).
              const state = (error as { code?: unknown; cause?: { code?: unknown } }).cause?.code ?? (error as { code?: unknown }).code;
              if (state === '23503' && !sign?.providerId) throw new APIError('UNAUTHORIZED', { message: 'Invalid email or password', code: 'INVALID_EMAIL_OR_PASSWORD' });
              throw error;
            }
            // A provider sign-in is the provider vouching for the person now (F-024 S2, #312).
            if (sign?.providerId) await confirmation.confirm(session.userId, sign.providerId);
            // The provider vouched for the person just now: keep its offline token for the standing check and
            // clear sign-in required (#311). The token never reaches auth_accounts or a log.
            if (sign?.providerId && sign.refreshToken && standing) await standing.recordSignIn(session.userId, sign.refreshToken, sign.idpSid);
            // F-037: whoever the provider lets in joins on their first sign-in, also with an account that existed before
            // they linked the provider. Last, so the standing check above is not kept waiting.
            if (sign?.providerId) await joinCompany(session.userId, { sso: true }, db, accessPorts);
          },
        },
      },
      // The provider's access, ID and refresh tokens never reach auth_accounts. Flux needs only the
      // verified identity; S4 keeps the refresh token in its own encrypted table (#310 AC-8).
      account: {
        create: { before: async (account) => ({ data: withoutIdpTokens(account) }) },
        update: {
          before: async (account, context) => {
            const data: Record<string, unknown> = withoutIdpTokens(account);
            const facts = signIns.getStore();
            // A change of the password that follows a password check (change-password) is written only if the account is still at the version
            // the accepted hash had, so a reset that came in between is not undone; a reset carries no check and always writes (#1088). The
            // session the same request creates next is for the new hash.
            if (typeof data.password === 'string' && facts?.passwordChecked) {
              const userId = context ? (await getSessionFromCtx(context))?.user.id : undefined;
              const version = userId ? await acceptedPasswordVersion(userId, facts.passwordChecked) : null;
              if (version === null) throw new APIError('BAD_REQUEST', { message: 'Invalid password', code: 'INVALID_PASSWORD' });
              facts.passwordChecked = data.password;
              return { data: { ...data, passwordVersionExpected: version } };
            }
            return { data };
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      autoSignIn: !verifiedSignUp,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      revokeSessionsOnPasswordReset: true,
      // The check of a password remembers the hash it accepted for the writes that follow in the same request (#1088).
      password: {
        verify: async (input) => {
          const accepted = await verifyPassword(input);
          const facts = signIns.getStore();
          if (accepted && facts) facts.passwordChecked = input.hash;
          return accepted;
        },
      },
      // A reset is the recovery from a stolen password or session, so it also ends what a local AI client holds and clears the account's back-off (#989, #990).
      onPasswordReset: async ({ user }, request) => {
        const disconnected = await connectionStore.disconnectClients(user.id);
        await throttle.clear(user.email);
        await devices.endAll(user.id);
        if (!log) return;
        const place = whereFrom({ request });
        securityEvent(log, { event: 'password_reset', outcome: 'success', userId: user.id, ...place });
        securityEvent(log, { event: 'sessions_revoked', outcome: 'success', reason: 'password_reset', userId: user.id, ...place });
        if (disconnected > 0) securityEvent(log, { event: 'client_disconnected', outcome: 'success', reason: 'password_reset', userId: user.id, count: disconnected, ...place });
      },
      resetPasswordTokenExpiresIn: config.passwordResetTtlSeconds,
      // `verified` sign-up answers an address that has an account like a new one (Better Auth's generic answer, because there is no automatic
      // sign-in), so the page cannot tell. The mailbox's owner is told instead: the verification link if they never verified, else where to sign in.
      // `open` sign-up signs the new account in, so the answer cannot be the same; that is the accepted risk in docs/operations/hardening.md (#993).
      onExistingUserSignUp: async ({ user }) => {
        if (!mailer || !verifiedSignUp) return;
        const [row] = await db.select({ pending: schema.authUsers.verificationRequired }).from(schema.authUsers).where(eq(schema.authUsers.id, user.id));
        if (row?.pending && !user.emailVerified) { await sendVerification(user.email); return; }
        if (!oncePerMinute(lastExistingMail, user.email.toLowerCase())) return;
        try {
          await mailer.send({ to: user.email, subject: 'You already have a Flux account',
            text: `Someone used this address to create a Flux account${await atCompany()}. You already have one, so nothing changed.\n\nSign in: ${config.publicOrigin}/sign-in\nForgot the password: ${config.publicOrigin}/forgot-password\n\nIf this was not you, ignore this message.\n` });
        } catch (error) { onMailError?.(error); }
      },
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
              text: `A password reset was requested for your Flux account${await atCompany()}.\n\nOpen this link to choose a new password. It works once and expires in ${Math.round(config.passwordResetTtlSeconds / 60)} minutes:\n\n${url}\n\nIf you did not ask for this, ignore this message.\n`,
            });
          } catch (error) {
            onMailError?.(error);
            throw error;
          }
        }
        : undefined,
    },
    // Better Auth's list endpoint returns raw session tokens; Flux lists sessions by id instead. Its two "revoke all" endpoints are off for the same
    // reason: Flux ends sessions through its own routes (`/api/v1/sessions`), which also disconnect the person's local AI clients (#989).
    disabledPaths: ['/list-sessions', '/send-verification-email', '/revoke-sessions', '/revoke-other-sessions'],
    // Per client address (an IPv6 address counts as its /64), in PostgreSQL so every API process shares the count (#990). The account's own back-off is `throttle`.
    rateLimit: { enabled: config.rateLimit, storage: 'database', modelName: 'authRateLimits' },
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

/**
 * One operator-configured OpenID Connect provider for human sign-in (#113). In `prepare` mode (F-024 S5b, #315) ordinary
 * provider sign-in is closed: only a callback that carries a valid, session-bound link intent may use the provider.
 */
function oidcPlugin(oidc: OidcConfig, signIns: SignIns, emailClaims: EmailClaims, links: LinkIntents, log: { error(object: object, message: string): void } | undefined, prepare: boolean) {
  return genericOAuth({
    config: [{
      providerId: oidc.providerId,
      discoveryUrl: `${oidc.issuer}/.well-known/openid-configuration`,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      // No offline_access here: asked first, it makes Keycloak 26.1+ delete the person's online session, and with it
      // back-channel logout. The bridge fetches the offline token in a silent second step (S1, revised 2026-10-09).
      scopes: ['openid', 'email', 'profile'],
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
        // Prepare mode: password-only ordinary sign-in. A provider callback without a valid link intent signs nobody in
        // and creates no account; the owner's own link (above) is the only use of the provider until cutover.
        if (prepare && !sign?.link) {
          if (sign) sign.refused = 'sign_in_closed';
          return null;
        }
        const sid = typeof claims?.sid === 'string' && claims.sid && claims.sid.length <= 512 ? claims.sid : undefined;
        const problem = user && sign && oidc.standing === 'refresh' ? offlineStepProblem(user.sub, sid, sign.offline) : null;
        if (user && sign && problem) {
          // N1: without an offline token for this person the next check would suspend them again. Refuse the sign-in
          // and tell the operator; the browser is told why by the bridge. This includes a silent step that answered
          // login_required or another error (S1, revised 2026-10-09).
          sign.refused = 'no_refresh_token';
          if (problem === 'no_refresh_token') log?.error({ issuer: oidc.issuer, providerId: oidc.providerId }, 'The identity provider returned no refresh token, so the sign-in was refused. Grant the offline_access scope and the refresh_token grant to the Flux client, or set FLUX_OIDC_STANDING=off');
          else log?.error({ issuer: oidc.issuer, providerId: oidc.providerId, cause: problem }, 'The identity provider refused the silent offline-access step, so the sign-in was refused');
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
          if (sign.offline && 'refreshToken' in sign.offline) sign.refreshToken = sign.offline.refreshToken;
          if (sid) sign.idpSid = sid;
        }
        return user;
      },
    }],
  });
}
