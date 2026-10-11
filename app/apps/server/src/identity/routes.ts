import type { FastifyInstance } from 'fastify';
import {
  IDENTITY_CAPABILITIES_PATH,
  ME_PATH,
  REVOKE_OTHER_SESSIONS_PATH,
  SESSIONS_PATH,
  type ApiError,
  type IdentityCapabilities,
  type MeResponse,
  type SessionSummary,
} from '@flux/contracts';
import type { SessionResolver } from './session.js';

export interface StoredSession {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Port for listing and revoking a person's own sessions. `@flux/db`'s `createSessionRepository`
 * implements it. Every method is scoped to `userId`.
 */
export interface SessionStore {
  listActive(userId: string): Promise<StoredSession[]>;
  deleteOwned(userId: string, sessionId: string): Promise<boolean>;
  deleteOthers(userId: string, keepSessionId: string): Promise<number>;
}

export interface IdentityRouteOptions {
  sessions: SessionResolver;
  store: SessionStore;
  passwordReset: IdentityCapabilities['passwordReset'];
  /** Evaluated per request: the provider's reachability changes while Flux runs. */
  sso: () => Promise<IdentityCapabilities['sso']>;
}

/** Flux's own identity routes: capabilities, the current principal and session management. */
export function registerIdentityRoutes(app: FastifyInstance, { sessions, store, passwordReset, sso }: IdentityRouteOptions) {
  app.get(IDENTITY_CAPABILITIES_PATH, async (): Promise<IdentityCapabilities> => ({ passwordReset, sso: await sso() }));

  app.get(ME_PATH, async (request): Promise<MeResponse> => {
    const context = await sessions.requirePrincipal(request);
    return { principal: context.principal, user: context.user, session: { id: context.sessionId, expiresAt: context.expiresAt.toISOString() } };
  });

  app.get(SESSIONS_PATH, async (request): Promise<SessionSummary[]> => {
    const context = await sessions.requirePrincipal(request);
    const rows = await store.listActive(context.principal.id);
    return rows.map((row) => ({
      id: row.id,
      current: row.id === context.sessionId,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
    }));
  });

  app.delete<{ Params: { id: string } }>(`${SESSIONS_PATH}/:id`, async (request, reply) => {
    const context = await sessions.requirePrincipal(request);
    if (!await store.deleteOwned(context.principal.id, request.params.id)) {
      return reply.code(404).send({ error: 'Session not found', code: 'SESSION_NOT_FOUND' } satisfies ApiError);
    }
    return reply.code(204).send();
  });

  app.post(REVOKE_OTHER_SESSIONS_PATH, async (request) => {
    const context = await sessions.requirePrincipal(request);
    return { revoked: await store.deleteOthers(context.principal.id, context.sessionId) };
  });
}
