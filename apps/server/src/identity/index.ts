import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, gt, ne } from 'drizzle-orm';
import { fromNodeHeaders } from 'better-auth/node';
import { schema } from '@flux/db';
import type { Database } from '@flux/core';
import {
  AUTH_BASE_PATH,
  IDENTITY_CAPABILITIES_PATH,
  ME_PATH,
  REVOKE_OTHER_SESSIONS_PATH,
  SESSIONS_PATH,
  type IdentityCapabilities,
  type MeResponse,
  type SessionSummary,
} from '@flux/contracts';
import { CLIENT_IP_HEADER, createAuth } from './auth.js';
import type { IdentityConfig } from './config.js';
import { createSmtpMailer, type Mailer } from './mailer.js';
import { originViolation } from './origin.js';
import { createSessionResolver, type SessionResolver } from './session.js';

export { loadIdentityConfig, type IdentityConfig } from './config.js';
export { UnauthenticatedError, type SessionContext, type SessionResolver } from './session.js';

// Forwarding headers are dropped before Better Auth sees a request. Client addresses come
// from Fastify's request.ip, which honours only the configured trusted proxies.
const UNTRUSTED_FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'x-client-ip', 'cf-connecting-ip', 'true-client-ip', CLIENT_IP_HEADER];
const PASSWORD_RESET_REQUEST_PATHS = new Set([`${AUTH_BASE_PATH}/request-password-reset`, `${AUTH_BASE_PATH}/forget-password`]);

/**
 * Better Auth echoes the raw session token in sign-in/sign-up and get-session bodies. The
 * browser only needs the HttpOnly cookie, so the bridge removes the token from JSON bodies
 * and script cannot read or exfiltrate it.
 */
function redactSessionTokens(text: string) {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return text; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return text;
  const record = data as Record<string, unknown>;
  delete record.token;
  if (record.session && typeof record.session === 'object') delete (record.session as Record<string, unknown>).token;
  return JSON.stringify(record);
}

export interface IdentityOptions {
  db: Database;
  config: IdentityConfig;
  /** Defaults to SMTP from config; pass null to force password reset unavailable. */
  mailer?: Mailer | null;
}

export interface Identity extends SessionResolver {
  passwordReset: IdentityCapabilities['passwordReset'];
}

/**
 * Registers the origin guard, the Better Auth bridge and Flux session routes. Call it before
 * other routes so the origin guard hook applies to every state-changing request.
 */
export function registerIdentity(app: FastifyInstance, options: IdentityOptions): Identity {
  const { db, config } = options;
  const mailer = options.mailer === undefined ? (config.smtp ? createSmtpMailer(config.smtp) : null) : options.mailer;
  if (mailer) app.addHook('onClose', async () => mailer.close());
  const auth = createAuth({ db, config, mailer, onMailError: (error) => app.log.error({ error }, 'Password reset mail failed') });
  const sessions = createSessionResolver(auth);
  const passwordReset: IdentityCapabilities['passwordReset'] = mailer ? 'available' : 'unavailable';

  app.addHook('onRequest', async (request, reply) => {
    const violation = originViolation(request.method, request.headers, config.publicOrigin);
    if (violation) {
      request.log.warn({ violation, origin: request.headers.origin }, 'Rejected cross-origin state change');
      return reply.code(403).send({ error: 'Forbidden', code: 'ORIGIN_REJECTED', reason: violation });
    }
  });

  app.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      // Build the URL from the configured origin, never from Host or an absolute-form target.
      const target = new URL(request.url, config.publicOrigin);
      const url = new URL(`${target.pathname}${target.search}`, config.publicOrigin);
      if (passwordReset === 'unavailable' && PASSWORD_RESET_REQUEST_PATHS.has(url.pathname)) {
        return reply.code(503).send({ error: 'Password reset is unavailable', code: 'PASSWORD_RESET_UNAVAILABLE' });
      }
      const headers = fromNodeHeaders(request.headers);
      for (const name of UNTRUSTED_FORWARDING_HEADERS) headers.delete(name);
      headers.set(CLIENT_IP_HEADER, request.ip);
      const body = request.body === undefined || request.body === null ? undefined : typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
      const response = await auth.handler(new Request(url, { method: request.method, headers, body }));
      reply.status(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie' && key !== 'content-length' && key !== 'transfer-encoding') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      const text = response.body ? await response.text() : null;
      return reply.send(text && response.headers.get('content-type')?.includes('application/json') ? redactSessionTokens(text) : text);
    },
  });

  app.get(IDENTITY_CAPABILITIES_PATH, async (): Promise<IdentityCapabilities> => ({ passwordReset }));

  app.get(ME_PATH, async (request): Promise<MeResponse> => {
    const context = await sessions.requirePrincipal(request);
    return { principal: context.principal, user: context.user, session: { id: context.sessionId, expiresAt: context.expiresAt.toISOString() } };
  });

  app.get(SESSIONS_PATH, async (request): Promise<SessionSummary[]> => {
    const context = await sessions.requirePrincipal(request);
    const rows = await db.select().from(schema.authSessions)
      .where(and(eq(schema.authSessions.userId, context.principal.id), gt(schema.authSessions.expiresAt, new Date())))
      .orderBy(schema.authSessions.createdAt);
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
    const deleted = await db.delete(schema.authSessions)
      .where(and(eq(schema.authSessions.id, request.params.id), eq(schema.authSessions.userId, context.principal.id)))
      .returning({ id: schema.authSessions.id });
    if (!deleted.length) return reply.code(404).send({ error: 'Session not found' });
    return reply.code(204).send();
  });

  app.post(REVOKE_OTHER_SESSIONS_PATH, async (request) => {
    const context = await sessions.requirePrincipal(request);
    const deleted = await db.delete(schema.authSessions)
      .where(and(eq(schema.authSessions.userId, context.principal.id), ne(schema.authSessions.id, context.sessionId)))
      .returning({ id: schema.authSessions.id });
    return { revoked: deleted.length };
  });

  return { ...sessions, passwordReset };
}
