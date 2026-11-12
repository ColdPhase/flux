import type { IncomingHttpHeaders } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import { queryPrepared, schema, type Database } from '@flux/db';
import type { Principal } from '@flux/core';
import { rememberPrincipal } from '../security-log.js';
import type { FluxAuth } from './auth.js';
import type { Confirmation } from './confirmation.js';
import type { IdpStanding } from './standing.js';
import { sessionCookieValue } from './session-cookie.js';

export interface HumanPrincipal extends Principal {
  kind: 'human';
}

export interface SessionContext {
  principal: HumanPrincipal;
  sessionId: string;
  expiresAt: Date;
  user: { id: string; email: string; name: string };
}

export class UnauthenticatedError extends Error {
  readonly statusCode = 401;
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('Authentication required');
  }
}

export interface SessionResolver {
  /** Reads the current session row on every call; a revoked or expired session yields null. */
  resolveSession(headers: IncomingHttpHeaders): Promise<SessionContext | null>;
  /** For HTTP handlers, stream upgrades and other entry points; throws a 401 error without a live session. */
  requirePrincipal(request: { headers: IncomingHttpHeaders; acceptCredential?: ((proof: { sessionToken: string }) => void) | null }): Promise<SessionContext>;
}

/** `confirmation` ends a provider session whose provider confirmation lapsed (F-024 S2, #312). */
/**
 * With an active sole provider (#313), only sessions that signed in through it continue: a password session, or one
 * from before the sign-in method was recorded, is refused. Ordinary password authority ends at the session boundary too.
 */
export interface SsoOnlySessions { db: Database; providerId: string }

/** The longest a session lasts from sign-in, however much it is used (FLUX_SESSION_MAX_AGE, #993). */
export interface SessionLimits { db: Database; maxAgeMs: number }

/**
 * The fast path of the session read (#1178): the session cookie Better Auth reads, and its idle settings (`expiresIn`, `updateAge`), so a
 * session that is due for renewal goes back to Better Auth, which renews it.
 */
export interface SessionFastPath { db: Database; cookieName: string; expiresInSeconds: number; updateAgeSeconds: number }

/** A session cookie Better Auth accepted: what it resolved to, kept for a while by the cookie's whole signed value. */
interface Accepted { context: SessionContext; token: string; acceptedAt: number }
const ACCEPTED_MAX = 5000;
const ACCEPTED_MS = 5 * 60_000;
const SESSION_ROW = `SELECT s.expires_at AS "expiresAt", s.created_at AS "createdAt", u.email, u.name FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
  WHERE s.id = $1 AND s.token = $2 AND s.user_id = $3`;

export function createSessionResolver(auth: FluxAuth, standing: Pick<IdpStanding, 'stands'> | null = null, confirmation?: Confirmation,
  ssoOnly: SsoOnlySessions | null = null, limits: SessionLimits | null = null, fast: SessionFastPath | null = null): SessionResolver {
  /**
   * Session cookies Better Auth accepted in this process, by their whole signed value (#1178: a session read was a fifth of the API's CPU).
   * Only an exact value Better Auth verified is ever found here, so a forged or altered cookie always goes to Better Auth. A value found
   * here is never trusted alone: every request reads its session row again (one statement, the session and its person), so a sign-out, a
   * revoked session, a password reset or a deleted account ends it on the very next request, in every API process. Whatever else ends a
   * session (the absolute limit, single sign-on only, standing, confirmation) is checked on every request as before.
   */
  const accepted = new Map<string, Accepted>();
  const forget = (key: string) => { accepted.delete(key); };

  /** The checks every session read makes after the row (Better Auth's, or the fast path's) says the session is live. */
  async function stillValid(sessionId: string, userId: string, createdAt: number, checkSso: boolean): Promise<boolean> {
    // Better Auth renews a session that is used, so its own expiry is the idle limit; the absolute limit is checked here, on the session row.
    if (limits && Date.now() - createdAt > limits.maxAgeMs) {
      await limits.db.delete(schema.authSessions).where(eq(schema.authSessions.id, sessionId));
      return false;
    }
    // How a session signed in never changes after it was created, so the fast path need not read it again.
    if (ssoOnly && checkSso) {
      const [identity] = await ssoOnly.db.select({ method: schema.authSessionIdentities.method }).from(schema.authSessionIdentities)
        .where(eq(schema.authSessionIdentities.sessionId, sessionId));
      if (identity?.method !== ssoOnly.providerId) return false;
    }
    // A person whose account no longer stands at the identity provider is signed out (S4, #311); the stored
    // state is read, the provider is not called.
    if (standing && !await standing.stands(userId)) return false;
    if (await confirmation?.endIfLapsed(sessionId)) return false;
    return true;
  }

  /** Better Auth's own read: the signed cookie, the session row and its person, and the renewal of a session that is due. */
  async function full(cookie: string, key: string | null): Promise<{ context: SessionContext; token: string } | null> {
    const result = await auth.api.getSession({
      headers: fromNodeHeaders({ cookie }),
      query: { disableCookieCache: true },
    });
    if (!result) return null;
    const { session, user } = result;
    const createdAt = new Date(session.createdAt).getTime();
    if (!await stillValid(session.id, user.id, createdAt, true)) return null;
    const context: SessionContext = {
      principal: { id: user.id, kind: 'human' },
      sessionId: session.id,
      expiresAt: new Date(session.expiresAt),
      user: { id: user.id, email: user.email, name: user.name },
    };
    // Kept only when the cookie's token part is the session Better Auth returned, so a parser difference over duplicate cookies (first
    // versus last of one name) can never key one session under another cookie value.
    if (key && key.slice(0, key.lastIndexOf('.')) === session.token) {
      if (accepted.size >= ACCEPTED_MAX) accepted.delete(accepted.keys().next().value!);
      accepted.set(key, { context, token: session.token, acceptedAt: Date.now() });
    }
    return { context, token: session.token };
  }

  /** The session the request's cookie names, and its token: what the API's request limit needs to know which credential was checked (#1022). */
  async function resolve(headers: IncomingHttpHeaders): Promise<{ context: SessionContext; token: string } | null> {
    const cookie = headers.cookie;
    if (!cookie) return null;
    const key = fast ? sessionCookieValue(cookie, fast.cookieName) : null;
    const known = key ? accepted.get(key) : undefined;
    if (!fast || !key || !known) return full(cookie, key);
    if (Date.now() - known.acceptedAt > ACCEPTED_MS) { forget(key); return full(cookie, key); }
    const { context } = known;
    const [row] = (await queryPrepared<{ expiresAt: Date | string; createdAt: Date | string; email: string; name: string }>(fast.db, SESSION_ROW,
      [context.sessionId, known.token, context.principal.id])).rows;
    const expiresAt = row ? new Date(row.expiresAt).getTime() : 0;
    // Gone (signed out, revoked, a password reset, the account deleted), expired, or due for renewal: Better Auth decides, as without this path.
    if (!row || expiresAt < Date.now() || expiresAt - fast.expiresInSeconds * 1000 + fast.updateAgeSeconds * 1000 <= Date.now()) {
      forget(key);
      return full(cookie, key);
    }
    if (!await stillValid(context.sessionId, context.principal.id, new Date(row.createdAt).getTime(), false)) { forget(key); return null; }
    const fresh: SessionContext = { ...context, expiresAt: new Date(expiresAt), user: { id: context.principal.id, email: row.email, name: row.name } };
    return { context: fresh, token: known.token };
  }
  return {
    async resolveSession(headers) { return (await resolve(headers))?.context ?? null; },
    async requirePrincipal(request) {
      const resolved = await resolve(request.headers);
      if (!resolved) throw new UnauthenticatedError();
      // A refused request (403) is logged with the person it was refused to (#997).
      rememberPrincipal(request, resolved.context.principal.id);
      // The cookie resolved to a person: the API's request limit gives the credential a budget of its own from now on, if it is the one this
      // session's token names (#1022).
      request.acceptCredential?.({ sessionToken: resolved.token });
      return resolved.context;
    },
  };
}
