import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_CHECK_PATH, AGENT_RUNTIME_CLIENTS, AGENT_RUNTIME_CONSOLE_PATH, AGENT_RUNTIME_ERRORS, AGENT_RUNTIME_NOTICE_PATH,
  AGENT_RUNTIME_PATH, AGENT_RUNTIME_SIGN_OUT_PATH, CLAUDE_CODE_SIGN_IN_METHODS,
  type AgentRuntimeClient, type AgentRuntimeConsoleTicket, type ClaudeCodeSignInMethod,
} from '@flux/contracts';
import { agentRuntimeUseCases, InvalidInputError, type AgentRuntimeConfig, type Database } from '@flux/core';
import { agentRuntimeStore } from '@flux/db';
import { createRuntimeManagerClient, runtimeManagerPort } from '@flux/runtime-protocol';
import type { SessionResolver } from '../identity/index.js';
import { forbidden, UNAUTHENTICATED, useDomainErrors } from '../http/errors.js';
import { accountFingerprinter, ConsoleTickets, serveBrowserConsole } from './console.js';

/**
 * The owner's agent runtime (F-022 AIM-3). T3 #278: `GET /api/v1/agent-runtime`, `POST` and `DELETE
 * /api/v1/agent-runtime/binding`. T4 #279: the Claude Code sign-in console (`POST` and WebSocket at
 * `/api/v1/agent-runtime/console`), sign-out, a status check and dismissing the account-change notice.
 *
 * The session is the owner; no request names a slot, a binding or another person. The binding routes
 * take no input at all. The T4 routes take exactly `{client}` (and `method` for the console), from fixed
 * lists; any other field, a query parameter or an unknown value is refused. Nothing accepts a token, a
 * key, a session or a credential file. With FLUX_AGENT_RUNTIME empty the status says the instance has
 * not enabled it and the commands answer AGENT_RUNTIME_OFF.
 */
export async function agentRuntimeRoutes(app: FastifyInstance, { db, sessions, config, secret, publicOrigin }: {
  db: Database; sessions: SessionResolver; config: AgentRuntimeConfig; secret: string; publicOrigin: string;
}) {
  useDomainErrors(app);
  const store = agentRuntimeStore(db);
  const manager = config.manager ? runtimeManagerPort(createRuntimeManagerClient(config.manager)) : null;
  const runtime = agentRuntimeUseCases(config, store, manager, { accountFingerprint: accountFingerprinter(secret) });
  const tickets = new ConsoleTickets(secret);
  const consoles = new Map<string, () => void>();
  app.addHook('onClose', async () => { for (const end of [...consoles.values()]) end(); });
  // F-022 "Commercial Terms": Flux records the operator's statement and its date; it does not verify it.
  if (config.commercialTermsAgreedOn) await store.recordCommercialTerms(config.commercialTermsAgreedOn);

  const noQuery = (request: FastifyRequest) => {
    const query = request.query as Record<string, unknown> | undefined;
    if (query && Object.keys(query).length) throw new InvalidInputError('This request takes no parameters', 'AGENT_RUNTIME_NO_INPUT');
  };
  const owner = async (request: FastifyRequest) => {
    noQuery(request);
    const body = request.body as unknown;
    if (body !== undefined && body !== null && !(typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) {
      throw new InvalidInputError('This request takes no fields', 'AGENT_RUNTIME_NO_INPUT');
    }
    return (await sessions.requirePrincipal(request)).user.id;
  };
  /** Exactly the named fields, each from its fixed list. */
  const fields = <T extends Record<string, readonly string[]>>(request: FastifyRequest, allowed: T): { [K in keyof T]: T[K][number] } => {
    noQuery(request);
    const body = request.body as Record<string, unknown> | null | undefined;
    const valid = typeof body === 'object' && body !== null && !Array.isArray(body)
      && Object.keys(body).sort().join(',') === Object.keys(allowed).sort().join(',')
      && Object.entries(allowed).every(([key, values]) => typeof body[key] === 'string' && values.includes(body[key] as string));
    if (!valid) throw new InvalidInputError('This request takes exactly the program (and, for a sign-in, the method)', AGENT_RUNTIME_ERRORS.invalidInput);
    return body as { [K in keyof T]: T[K][number] };
  };
  const clientOf = (request: FastifyRequest) => fields(request, { client: AGENT_RUNTIME_CLIENTS }).client as AgentRuntimeClient;
  const noStore = { 'cache-control': 'no-store' };

  app.get(AGENT_RUNTIME_PATH, async (request, reply) => reply.headers(noStore).send(await runtime.status(await owner(request))));
  app.post(AGENT_RUNTIME_BINDING_PATH, async (request, reply) => reply.headers(noStore).send(await runtime.bind(await owner(request))));
  app.delete(AGENT_RUNTIME_BINDING_PATH, async (request, reply) => reply.code(202).headers(noStore).send(await runtime.remove(await owner(request))));

  // The console: a ticket for this owner and this session, for one method of the fixed list.
  app.post(AGENT_RUNTIME_CONSOLE_PATH, async (request, reply) => {
    const session = await sessions.requirePrincipal(request);
    const { client, method } = fields(request, { client: ['claude_code'] as const, method: CLAUDE_CODE_SIGN_IN_METHODS });
    // Checks the switch, the program and the slot now, so the person hears why before any terminal opens.
    await runtime.consoleTarget(session.user.id, client);
    const ticket: AgentRuntimeConsoleTicket = tickets.issue({ ownerUserId: session.user.id, client, method: method as ClaudeCodeSignInMethod }, session.sessionId);
    return reply.headers(noStore).send(ticket);
  });
  const attached = new WeakMap<FastifyRequest, { userId: string; sessionId: string }>();
  app.get(AGENT_RUNTIME_CONSOLE_PATH, {
    websocket: true,
    preValidation: async (request, reply) => {
      // Browsers always send Origin on a WebSocket upgrade; only the public origin may use the cookie.
      if (request.headers.origin !== publicOrigin) return reply.code(403).send(forbidden('ORIGIN_REJECTED'));
      const query = request.query as Record<string, unknown> | undefined;
      if (query && Object.keys(query).length) return reply.code(400).send({ error: 'This request takes no parameters', code: 'AGENT_RUNTIME_NO_INPUT' });
      const session = await sessions.resolveSession(request.headers);
      if (!session) return reply.code(401).send(UNAUTHENTICATED);
      if (!config.manager || !config.clients.length) return reply.code(409).send({ error: 'The agent runtime is off on this instance', code: AGENT_RUNTIME_ERRORS.off });
      attached.set(request, { userId: session.user.id, sessionId: session.sessionId });
    },
  }, (socket, request) => {
    const owner = attached.get(request);
    attached.delete(request);
    if (!owner || !config.manager) { socket.close(4401, 'Session ended'); return; }
    const headers = { cookie: request.headers.cookie };
    serveBrowserConsole(socket, owner, {
      runtime, tickets, manager: config.manager, open: consoles,
      sessionAlive: async () => (await sessions.resolveSession(headers))?.sessionId === owner.sessionId,
    });
  });

  app.post(AGENT_RUNTIME_SIGN_OUT_PATH, async (request, reply) => {
    const { user, sessionId } = await sessions.requirePrincipal(request);
    return reply.headers(noStore).send(await runtime.signOut(user.id, clientOf(request), sessionId));
  });
  app.post(AGENT_RUNTIME_CHECK_PATH, async (request, reply) => {
    const { user, sessionId } = await sessions.requirePrincipal(request);
    return reply.headers(noStore).send(await runtime.check(user.id, clientOf(request), sessionId));
  });
  app.post(AGENT_RUNTIME_NOTICE_PATH, async (request, reply) => {
    const { user } = await sessions.requirePrincipal(request);
    return reply.headers(noStore).send(await runtime.dismissAccountNotice(user.id, clientOf(request)));
  });
}
