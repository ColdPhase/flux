import { assistantJoinRows, assistantJoinView, lockAssistantOwner } from '@flux/db';
import { ConflictError, NotFoundError, assertAuthorized, createNotification, evaluateProject, getProject,
  grantProject, isUuid, type Database, type Principal } from '@flux/core';
import type { PgBoss } from 'pg-boss';
import { notificationUnitOfWork, pgBossQueue } from '../push/adapters.js';
import { transactionEventSession } from '../work/transaction-events.js';
import { assistantRows } from './adapters.js';

const unavailable = () => new NotFoundError('Assistant join request', 'ASSISTANT_JOIN_REQUEST_NOT_FOUND');
const human = (principal: Principal, projectId: string) => {
  if (principal.kind !== 'human' || !isUuid(projectId)) throw unavailable();
};
export function assistantJoinUseCases(db: Database, boss: Pick<PgBoss, 'send'>) {
  return {
    request(principal: Principal, projectId: string) {
      human(principal, projectId);
      return db.transaction(async (tx) => {
        await lockAssistantOwner(tx, principal.id);
        const project = await getProject(principal, projectId, tx);
        await assertAuthorized(principal, 'project.read', { type: 'project', id: projectId }, tx, { lock: true });
        const rows = assistantJoinRows(tx);
        const identity = await rows.forOwner(principal.id, project.workspaceId);
        if (!identity) throw unavailable();
        if ((await evaluateProject({ kind: 'agent', id: identity.agentId }, 'project.read', projectId, tx, { lock: true })).allowed)
          throw new ConflictError('Your assistant is already a member here', 'ASSISTANT_ALREADY_JOINED');
        const request = await rows.open(principal.id, project.workspaceId, identity.connectionId, projectId);
        if (request.created) {
          const title = `${await rows.name(principal.id)}'s assistant asks to join`.slice(0, 200);
          for (const candidate of await rows.candidates(project.workspaceId)) {
            if (!(await evaluateProject({ kind: 'human', id: candidate.userId }, 'project.manage', projectId, tx, { lock: true })).allowed) continue;
            const notification = await createNotification(notificationUnitOfWork(tx, pgBossQueue(boss)), {
              userId: candidate.userId, source: { type: 'project', id: projectId }, title,
              body: 'The assistant requested contributor access to this project.', url: `/projects/${projectId}/agents`,
            });
            await rows.markQuestion(notification.id);
          }
        }
        return assistantJoinView(request.row, identity.agentId);
      });
    },
    respond(principal: Principal, projectId: string, requestId: string, allow: boolean) {
      human(principal, projectId);
      if (!isUuid(requestId)) throw unavailable();
      return db.transaction(async (tx) => {
        await assertAuthorized(principal, 'project.manage', { type: 'project', id: projectId }, tx);
        const rows = assistantJoinRows(tx);
        const candidate = await rows.peek(projectId, requestId);
        if (!candidate) throw unavailable();
        await lockAssistantOwner(tx, candidate.ownerUserId);
        await assertAuthorized(principal, 'project.manage', { type: 'project', id: projectId }, tx, { lock: true });
        const request = await rows.find(projectId, requestId);
        if (!request) throw unavailable();
        const identity = await rows.forOwner(request.ownerUserId, request.workspaceId);
        if (!identity || identity.connectionId !== request.connectionId) throw unavailable();
        if (request.state !== 'pending') return assistantJoinView(request, identity.agentId);
        if (!(await evaluateProject({ kind: 'human', id: request.ownerUserId }, 'project.read', projectId, tx, { lock: true })).allowed)
          throw new ConflictError('The owner no longer has access here', 'ASSISTANT_JOIN_REQUEST_STALE');
        const events = transactionEventSession(tx);
        await events.run(async () => {
          if (allow) {
            await grantProject(principal, projectId, { principal: { kind: 'agent', id: identity.agentId }, role: 'contributor' }, tx, events);
            await assistantRows(tx, events).addGrantedProject(identity.agentId, request.workspaceId, projectId);
          }
        });
        const closed = await rows.close(requestId, allow ? 'accepted' : 'declined');
        await events.flushEvents();
        return assistantJoinView(closed, identity.agentId);
      });
    },
  };
}
