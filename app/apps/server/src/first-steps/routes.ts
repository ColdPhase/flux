import type { FastifyInstance } from 'fastify';
import { ME_FIRST_STEPS_HIDE_PATH, ME_FIRST_STEPS_PATH, type FirstSteps } from '@flux/contracts';
import { hideFirstSteps, readFirstSteps } from '@flux/core';
import { firstStepRows, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { commandRunner, useDomainErrors } from '../http/commands.js';

interface Options { db: Database; sessions: SessionResolver }

/**
 * Home's first-steps card (founder decisions 2026-11-13, #1438): `GET /api/v1/me/first-steps` answers the signed-in person's steps left,
 * and `POST …/hide` hides the card for good. Only a person has one; an agent's token gets no steps and hides nothing.
 */
export async function firstStepRoutes(app: FastifyInstance, { db, sessions }: Options) {
  useDomainErrors(app);
  const { principal } = commandRunner(db, sessions);
  app.get(ME_FIRST_STEPS_PATH, async (request, reply) => {
    const actor = await principal(request);
    const steps: FirstSteps = actor.kind === 'human' ? await readFirstSteps(actor.id, firstStepRows(db)) : { steps: [], offerPush: false, everyoneSpaceId: null };
    return reply.header('cache-control', 'no-store').send(steps);
  });
  app.post(ME_FIRST_STEPS_HIDE_PATH, async (request, reply) => {
    const actor = await principal(request);
    if (actor.kind === 'human') await hideFirstSteps(actor.id, firstStepRows(db));
    return reply.code(204).send();
  });
}
