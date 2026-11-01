import type { FastifyInstance } from 'fastify';
import { projectMessagePlacePath, type MessagePlace } from '@flux/contracts';
import { evaluateProject, InvalidInputError, isUuid, NotFoundError } from '@flux/core';
import { accessReader, messageReferenceRows, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';

interface Options { db: Database; sessions: SessionResolver }

/**
 * Where a project message lives (CW-2): its conversation, for a reader of its project. A map thought keeps only its source
 * message's id; "Open message" asks here and opens the thread at that message. Nothing of the message itself is returned,
 * and a message of another project is the same 404 as a missing one.
 */
export async function messagePlaceRoutes(app: FastifyInstance, { db, sessions }: Options) {
  app.get<{ Params: { projectId: string; messageId: string } }>(projectMessagePlacePath(':projectId', ':messageId'), async (request): Promise<MessagePlace> => {
    const { principal } = await sessions.requirePrincipal(request);
    const { projectId, messageId } = request.params;
    if (!isUuid(projectId)) throw new InvalidInputError('projectId must be a UUID');
    if (!isUuid(messageId)) throw new InvalidInputError('messageId must be a UUID');
    const evaluation = await evaluateProject(principal, 'project.read', projectId, accessReader(db));
    if (!evaluation.allowed || !evaluation.project) throw new NotFoundError('Message');
    const message = await messageReferenceRows(db).message(messageId, evaluation.project.workspaceId);
    if (!message || message.kind !== 'project' || message.projectId !== projectId) throw new NotFoundError('Message');
    return { projectId, conversationId: message.conversationId, messageId };
  });
}
