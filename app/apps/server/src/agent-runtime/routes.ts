import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AGENT_RUNTIME_BINDING_PATH, AGENT_RUNTIME_PATH } from '@flux/contracts';
import { agentRuntimeUseCases, InvalidInputError, type AgentRuntimeConfig, type Database } from '@flux/core';
import { agentRuntimeStore } from '@flux/db';
import { createRuntimeManagerClient, runtimeManagerPort } from '@flux/runtime-protocol';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/errors.js';

/**
 * `GET /api/v1/agent-runtime`, `POST` and `DELETE /api/v1/agent-runtime/binding` (F-022 AIM-3, T3 #278).
 * The session is the owner; no request names a slot, a binding or another person. Any query parameter
 * or body field is refused, so no input can reach, start, inspect or sign in to someone else's slot.
 * With FLUX_AGENT_RUNTIME empty the status says the instance has not enabled it and the commands
 * answer AGENT_RUNTIME_OFF.
 */
export async function agentRuntimeRoutes(app: FastifyInstance, { db, sessions, config }: { db: Database; sessions: SessionResolver; config: AgentRuntimeConfig }) {
  useDomainErrors(app);
  const store = agentRuntimeStore(db);
  const manager = config.manager ? runtimeManagerPort(createRuntimeManagerClient(config.manager)) : null;
  const runtime = agentRuntimeUseCases(config, store, manager);
  // F-022 "Commercial Terms": Flux records the operator's statement and its date; it does not verify it.
  if (config.commercialTermsAgreedOn) await store.recordCommercialTerms(config.commercialTermsAgreedOn);

  const owner = async (request: FastifyRequest) => {
    const query = request.query as Record<string, unknown> | undefined;
    const body = request.body as unknown;
    if (query && Object.keys(query).length) throw new InvalidInputError('This request takes no parameters', 'AGENT_RUNTIME_NO_INPUT');
    if (body !== undefined && body !== null && !(typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 0)) {
      throw new InvalidInputError('This request takes no fields', 'AGENT_RUNTIME_NO_INPUT');
    }
    return (await sessions.requirePrincipal(request)).user.id;
  };
  app.get(AGENT_RUNTIME_PATH, async (request, reply) => reply.header('cache-control', 'no-store').send(await runtime.status(await owner(request))));
  app.post(AGENT_RUNTIME_BINDING_PATH, async (request, reply) => reply.header('cache-control', 'no-store').send(await runtime.bind(await owner(request))));
  app.delete(AGENT_RUNTIME_BINDING_PATH, async (request, reply) => reply.code(202).header('cache-control', 'no-store').send(await runtime.remove(await owner(request))));
}
