import type { FastifyInstance } from 'fastify';
import { taskCoordinationCancelPath, taskCoordinationPacketPath, taskCoordinationPath, type CancelCoWorkRequestCommand, type TaskCoordination } from '@flux/contracts';
import { normalizeCoWorkCancel } from '@flux/core';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { cancelCoWorkRequest, readHandoffPacket, readTaskCoordination } from './cards.js';

/**
 * A task's coordination records for its people (#153 AC-2/AC-4; read by #400's request cards and outcome notices).
 * Whoever can read the task reads its cards and downloads a request's reference packet. Cancelling an open request is
 * the one action: a project manager, or the owner of the sender or recipient agent. Nothing here claims, acknowledges,
 * answers or defers a request.
 */
export async function coWorkRoutes(app: FastifyInstance, { db, sessions }: { db: Database; sessions: SessionResolver }) {
  app.get<{ Params: { workId: string } }>(taskCoordinationPath(':workId'), async (request, reply): Promise<TaskCoordination> => {
    const { principal } = await sessions.requirePrincipal(request);
    reply.header('cache-control', 'no-store');
    return readTaskCoordination(db, principal, request.params.workId);
  });

  app.get<{ Params: { workId: string; requestId: string } }>(taskCoordinationPacketPath(':workId', ':requestId'), async (request, reply) => {
    const { principal } = await sessions.requirePrincipal(request);
    const packet = await readHandoffPacket(db, principal, request.params.workId, request.params.requestId);
    return reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="flux-handoff-${packet.task.number}-${packet.request.id.slice(0, 8)}.json"`)
      .type('application/json; charset=utf-8').send(packet);
  });

  app.post<{ Params: { workId: string; requestId: string }; Body: CancelCoWorkRequestCommand }>(taskCoordinationCancelPath(':workId', ':requestId'), async (request, reply) => {
    // The body is validated by the domain rule, not by a schema that would silently strip an unknown field.
    const { principal } = await sessions.requirePrincipal(request);
    const command = normalizeCoWorkCancel(request.body);
    return reply.header('cache-control', 'no-store').send(await cancelCoWorkRequest(db, principal, request.params.workId, request.params.requestId, command));
  });
}
