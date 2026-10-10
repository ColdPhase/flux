import type { IncomingHttpHeaders } from 'node:http';
import { fromNodeHeaders } from 'better-auth/node';
import type { Principal } from '@flux/core';
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
  requirePrincipal(request: { headers: IncomingHttpHeaders }): Promise<SessionContext>;
}

/** `confirmation` ends a provider session whose provider confirmation lapsed (F-024 S2, #312). */
export function createSessionResolver(auth: FluxAuth, standing: Pick<IdpStanding, 'stands'> | null = null, confirmation?: Confirmation): SessionResolver {
  async function resolveSession(headers: IncomingHttpHeaders): Promise<SessionContext | null> {
    if (!headers.cookie) return null;
    const result = await auth.api.getSession({
      headers: fromNodeHeaders({ cookie: headers.cookie }),
      query: { disableCookieCache: true },
    });
    if (!result) return null;
    const { session, user } = result;
    // A person whose account no longer stands at the identity provider is signed out (S4, #311); the stored
    // state is read, the provider is not called.
    if (standing && !await standing.stands(user.id)) return null;
    if (await confirmation?.endIfLapsed(session.id)) return null;
    return {
      principal: { id: user.id, kind: 'human' },
      sessionId: session.id,
      expiresAt: new Date(session.expiresAt),
      user: { id: user.id, email: user.email, name: user.name },
    };
  }
  return {
    resolveSession,
    async requirePrincipal(request) {
      const context = await resolveSession(request.headers);
      if (!context) throw new UnauthenticatedError();
      return context;
    },
  };
}
