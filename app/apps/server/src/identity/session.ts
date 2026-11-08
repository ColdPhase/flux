import type { IncomingHttpHeaders } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import { eq } from 'drizzle-orm';
import { schema, type Database } from '@flux/db';
import type { Principal } from '@flux/core';
import { rememberPrincipal } from '../security-log.js';
import type { FluxAuth } from './auth.js';
import type { Confirmation } from './confirmation.js';
import type { IdpStanding } from './standing.js';

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

export function createSessionResolver(auth: FluxAuth, standing: Pick<IdpStanding, 'stands'> | null = null, confirmation?: Confirmation,
  ssoOnly: SsoOnlySessions | null = null, limits: SessionLimits | null = null): SessionResolver {
  /** The session the request's cookie names, and its token: what the API's request limit needs to know which credential was checked (#1022). */
  async function resolve(headers: IncomingHttpHeaders): Promise<{ context: SessionContext; token: string } | null> {
    if (!headers.cookie) return null;
    const result = await auth.api.getSession({
      headers: fromNodeHeaders({ cookie: headers.cookie }),
      query: { disableCookieCache: true },
    });
    if (!result) return null;
    const { session, user } = result;
    // Better Auth renews a session that is used, so its own expiry is the idle limit; the absolute limit is checked here, on the session row.
    if (limits && Date.now() - new Date(session.createdAt).getTime() > limits.maxAgeMs) {
      await limits.db.delete(schema.authSessions).where(eq(schema.authSessions.id, session.id));
      return null;
    }
    if (ssoOnly) {
      const [identity] = await ssoOnly.db.select({ method: schema.authSessionIdentities.method }).from(schema.authSessionIdentities)
        .where(eq(schema.authSessionIdentities.sessionId, session.id));
      if (identity?.method !== ssoOnly.providerId) return null;
    }
    // A person whose account no longer stands at the identity provider is signed out (S4, #311); the stored
    // state is read, the provider is not called.
    if (standing && !await standing.stands(user.id)) return null;
    if (await confirmation?.endIfLapsed(session.id)) return null;
    return {
      context: {
        principal: { id: user.id, kind: 'human' },
        sessionId: session.id,
        expiresAt: new Date(session.expiresAt),
        user: { id: user.id, email: user.email, name: user.name },
      },
      token: session.token,
    };
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
