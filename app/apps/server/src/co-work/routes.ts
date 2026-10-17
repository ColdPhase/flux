import type { FastifyInstance } from 'fastify';
import { taskCoordinationPath, type TaskCoordination, type TaskCoordinationRequest } from '@flux/contracts';
import { coworkReviewRows } from '@flux/db';
import type { Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { workUseCases } from '../work/adapters.js';

/**
 * A task's coordination records for its people (#153 AC-4; read by #400's request cards and outcome notices). Whoever
 * can read the task reads them; nothing here acts, claims or acknowledges.
 */
export async function coWorkRoutes(app: FastifyInstance, { db, sessions }: { db: Database; sessions: SessionResolver }) {
  app.get<{ Params: { workId: string } }>(taskCoordinationPath(':workId'), async (request): Promise<TaskCoordination> => {
    const { principal } = await sessions.requirePrincipal(request);
    const task = await workUseCases(db).getWork(principal, request.params.workId);
    const rows = await coworkReviewRows(db).task(task.workspaceId, task.projectId, task.id);
    return {
      taskId: task.id,
      requests: rows.requests.map((row) => ({ id: row.id, kind: row.kind as TaskCoordinationRequest['kind'],
        state: row.state as TaskCoordinationRequest['state'], reason: row.reason, target: row.target, responseRef: row.responseRef,
        sender: { connectionId: row.senderConnectionId, name: row.senderName },
        recipient: { connectionId: row.recipientConnectionId, name: row.recipientName }, createdAt: row.createdAt, updatedAt: row.updatedAt })),
      verdicts: rows.verdicts.map((row) => ({ requestId: row.requestId, verdict: row.verdict, target: row.target,
        criteriaRefs: row.criteriaRefs, evidenceRef: row.evidenceRef, current: row.current, createdAt: row.createdAt,
        reviewer: { connectionId: row.reviewerConnectionId, name: row.reviewerName },
        author: { connectionId: row.authorConnectionId, name: row.authorName } })),
    };
  });
}
