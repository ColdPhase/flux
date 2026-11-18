import type { FastifyInstance } from 'fastify';
import { ME_FIRST_STEPS_HIDE_PATH, ME_FIRST_STEPS_PATH, type AgentRuntimeClient, type FirstSteps } from '@flux/contracts';
import { clientAvailability, hideFirstSteps, readFirstSteps, type AgentRuntimeConfig } from '@flux/core';
import { firstStepRows, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, useDomainErrors } from '../http/commands.js';

interface Options { db: Database; sessions: SessionResolver; runtime: AgentRuntimeConfig }

/**
 * Home's first-steps card (founder decisions 2026-11-13, #1438): `GET /api/v1/me/first-steps` answers a new person's steps left (and marks
 * the card done the first time none is left), and `POST …/hide` hides the card for good. Only a person has one; an agent's token gets no
 * steps and hides nothing. The Connect AI step's line names the plans the operator's runtime offers (`plans`), read here so Home asks nothing more.
 */
export async function firstStepRoutes(app: FastifyInstance, { db, sessions, runtime }: Options) {
  useDomainErrors(app);
  const { principal } = commandRunner(db, sessions);
  // The runtime is on with a runtime manager and a program the operator turned on and this version runs (the status's `enabled` and `clients`).
  const states = clientAvailability(runtime);
  const offered: AgentRuntimeClient[] = runtime.manager ? (['claude_code', 'codex'] as const).filter((client) => states[client] === 'available') : [];
  app.get(ME_FIRST_STEPS_PATH, async (request, reply) => {
    const actor = await principal(request);
    const read = actor.kind === 'human' ? await readFirstSteps(actor.id, firstStepRows(db)) : { steps: [], joined: [], offerPush: false, firstSpaceId: null };
    const steps: FirstSteps = { ...read, plans: read.steps.includes('connect_ai') ? offered : [] };
    return reply.header('cache-control', 'no-store').send(steps);
  });
  app.post(ME_FIRST_STEPS_HIDE_PATH, async (request, reply) => {
    const actor = await principal(request);
    if (actor.kind === 'human') await hideFirstSteps(actor.id, firstStepRows(db));
    return reply.code(204).send();
  });
}
