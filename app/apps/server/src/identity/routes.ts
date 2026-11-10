import type { FastifyInstance } from 'fastify';
import {
  IDENTITY_CAPABILITIES_PATH,
  ME_PATH,
  ME_PROBE_HEADER,
  ME_TIME_ZONE_PATH,
  REVOKE_OTHER_SESSIONS_PATH,
  SESSIONS_PATH,
  type ApiError,
  type IdentityCapabilities,
  type MeResponse,
  type SessionSummary,
  type SetTimeZone,
} from '@flux/contracts';
import { isTimeZone } from '@flux/core';
import type { SessionResolver } from './session.js';
import { securityEvent } from '../security-log.js';
import type { Devices } from './devices.js';

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

/** A person's own time zone, their browser's (#1168, C-57). `@flux/db`'s `personTimeZones` implements it; `set` writes only a different zone. */
export interface PersonTimeZones {
  get(userId: string): Promise<string>;
  set(userId: string, timeZone: string): Promise<void>;
}

/** Disconnects every local AI client of a person (#989): the connections, their runtime sessions and every OAuth token. Returns how many connections. */
export interface ClientDisconnector {
  disconnectClients(userId: string): Promise<number>;
}

export interface IdentityRouteOptions {
  sessions: SessionResolver;
  /** The browsers an account remembers: "Sign out all other devices" ends every other copy of the cookie (#1031). */
  devices: Devices;
  store: SessionStore;
  clients: ClientDisconnector;
  timeZones: PersonTimeZones;
  passwordReset: IdentityCapabilities['passwordReset'];
  signup: IdentityCapabilities['signup'];
  /** With a provider in SSO-only mode, the sign-in page offers no password form (#315). */
  ssoOnly: boolean;
  /** Prepare mode with a provider: existing password accounts may link it (#315). */
  linkable: boolean;
  /** Evaluated per request: the provider's reachability changes while Flux runs. */
  sso: () => Promise<IdentityCapabilities['sso']>;
  /** Evaluated per request: an admin can rename the company at any time. */
  company: () => Promise<string | null>;
}

/** Flux's own identity routes: capabilities, the current principal and session management. */
export function registerIdentityRoutes(app: FastifyInstance, { sessions, devices, store, clients, timeZones, passwordReset, signup, ssoOnly, linkable, sso, company }: IdentityRouteOptions) {
  app.get(IDENTITY_CAPABILITIES_PATH, async (): Promise<IdentityCapabilities> => ({ company: await company(), passwordReset, signup, ssoOnly, linkable, sso: await sso() }));

  app.get(ME_PATH, async (request, reply): Promise<MeResponse> => {
    if (request.headers[ME_PROBE_HEADER] === '1') {
      const found = await sessions.resolveSession(request.headers);
      if (!found) return reply.type('application/json').send('null') as never;
    }
    const context = await sessions.requirePrincipal(request);
    const timeZone = await timeZones.get(context.principal.id);
    return { principal: context.principal, user: { ...context.user, timeZone }, session: { id: context.sessionId, expiresAt: context.expiresAt.toISOString() } };
  });

  // The web app's browser zone, saved on the person when it is another one (#1168, C-57): no setting, nothing for the person to do.
  app.put<{ Body: SetTimeZone }>(ME_TIME_ZONE_PATH, { schema: { body: { type: 'object', required: ['timeZone'], additionalProperties: false,
    properties: { timeZone: { type: 'string', minLength: 1, maxLength: 64 } } } } }, async (request, reply) => {
    const context = await sessions.requirePrincipal(request);
    if (!isTimeZone(request.body.timeZone)) return reply.code(400).send({ error: 'timeZone must be an IANA time zone', code: 'INVALID_TIME_ZONE' } satisfies ApiError);
    await timeZones.set(context.principal.id, request.body.timeZone);
    return reply.code(204).send();
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
    securityEvent(request.log, { event: 'sessions_revoked', outcome: 'success', reason: 'one_session', userId: context.principal.id, count: 1, ip: request.ip });
    return reply.code(204).send();
  });

  app.post(REVOKE_OTHER_SESSIONS_PATH, async (request, reply) => {
    const context = await sessions.requirePrincipal(request);
    // Copies of the device cookie taken before now stop counting as this person's browser (#1031). A browser that already had a cookie for
    // this account keeps it, given again at the new generation (same device, so its own wait stays its own). One that has only a session
    // is given none: a session does not prove the password, and a cookie would give it a wait of its own to guess in (#990).
    // The check and the raise are one step on the generation that was seen: if another request raised it meanwhile (a reset, another tab),
    // that already ended the same cookies, and this answer gives none, so no cookie is ever written for a generation this request did not make (#1067).
    const cookie = cookieValue(request.headers.cookie, devices.cookie.name);
    const { device, seen } = await devices.check(cookie, context.user.email, context.principal.id);
    const raised = await devices.endAll(context.principal.id, { seen, sessionId: context.sessionId });
    if (device && raised !== null) reply.header('set-cookie', serializeDeviceCookie(devices, await devices.remember(cookie, context.user.email, raised)));
    // The other sessions go after the raise, which needs this one: two sign-outs at the same moment from two sessions would otherwise each delete
    // the other's session first, and neither would raise the generation.
    const revoked = await store.deleteOthers(context.principal.id, context.sessionId);
    // "Sign out everywhere" also ends what a local AI client holds: someone who had this account's session could have connected one (#989).
    // The person connects their own again with one click on the consent page.
    const disconnected = await clients.disconnectClients(context.principal.id);
    securityEvent(request.log, { event: 'sessions_revoked', outcome: 'success', reason: 'sign_out_everywhere', userId: context.principal.id, count: revoked, ip: request.ip });
    if (disconnected > 0) securityEvent(request.log, { event: 'client_disconnected', outcome: 'success', reason: 'sign_out_everywhere', userId: context.principal.id, count: disconnected, ip: request.ip });
    return { revoked, disconnected };
  });
}

const cookieValue = (header: string | undefined, name: string) =>
  header?.split(';').map((part) => part.trim().split(/=(.*)/s)).find(([key]) => key === name)?.[1];

/** The `Set-Cookie` line of the device cookie, as Better Auth writes the same cookie on a sign-in. */
function serializeDeviceCookie({ cookie }: Devices, value: string) {
  const { maxAge, secure } = cookie.options;
  return `${cookie.name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
