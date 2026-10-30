import { fileRows, taskDiscussionRows, workRows, type Database, type Transaction } from '@flux/db';
import { lockAttachments, createTaskDiscussionUseCases, type FileStorage, type TaskDiscussionEventIntent, type TaskDiscussionPorts, type TaskDiscussionUnitOfWork } from '@flux/core';
import { policyWorkAccess } from './access.js';
import { transactionEventSession, type TransactionEventSession } from './transaction-events.js';
import { projectAuthorOwners } from '../conversation/author-owners.js';
import { messageReferences } from '../conversation/references.js';

/** Reusable composition inside the caller's existing transaction; no independent commit. */
export function taskDiscussionPorts(tx: Transaction, events: TaskDiscussionPorts['events'], storage?: FileStorage): TaskDiscussionPorts {
  return {
    authorOwners: { read: (projectId, workspaceId, agentIds) => projectAuthorOwners(tx, projectId, workspaceId, agentIds) },
    access: policyWorkAccess(tx), work: workRows(tx), discussion: taskDiscussionRows(tx),
    events,
    references: { assertReadable: (principal, workspaceId, references) => messageReferences(tx).assertReadable(principal, workspaceId, references),
      save: (messageId, workspaceId, references) => messageReferences(tx).save({ kind: 'project', id: messageId }, workspaceId, references),
      cards: (principal, workspaceId, messageIds) => messageReferences(tx).cards(principal, { kind: 'project', workspaceId }, messageIds) },
    ...(storage ? { attachments: { lock: async (projectId: string, author: { kind: 'human' | 'agent'; id: string }, ids: readonly string[]) =>
      (await lockAttachments(fileRows(tx), storage, projectId, author, ids, () => new Date())).map((row) => ({ id: row.id, name: row.name, size: row.size! })) } } : {}),
  };
}

/** Uses a composing caller's collector; this adapter never flushes independently. */
export function taskDiscussionInEventSession(tx: Transaction, session: TransactionEventSession) {
  const ports = taskDiscussionPorts(tx, session);
  const unit: TaskDiscussionUnitOfWork = { run: (action) => session.run(() => action(ports)) };
  return createTaskDiscussionUseCases(unit);
}
export function taskDiscussionInTransaction(tx: Transaction) {
  const session = transactionEventSession(tx);
  return { ...taskDiscussionInEventSession(tx, session),
    get eventIntents(): readonly TaskDiscussionEventIntent[] { return session.eventIntents as readonly TaskDiscussionEventIntent[]; },
    flushEvents: session.flushEvents };
}
export function taskDiscussionUnitOfWork(db: Database, storage?: FileStorage): TaskDiscussionUnitOfWork {
  return { run: (action) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const result = await session.run(() => action(taskDiscussionPorts(tx, session, storage)));
    await session.flushEvents();
    return result;
  }) };
}
export const taskDiscussionUseCases = (db: Database, storage?: FileStorage) => createTaskDiscussionUseCases(taskDiscussionUnitOfWork(db, storage));
