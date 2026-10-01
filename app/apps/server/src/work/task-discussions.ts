import { taskDiscussionRows, workRows } from '@flux/db';
import { createTaskDiscussionUseCases, type Database, type Transaction, type TaskDiscussionEventIntent, type TaskDiscussionPorts, type TaskDiscussionUnitOfWork } from '@flux/core';
import { policyWorkAccess } from './access.js';
import { transactionEventSession, type TransactionEventSession } from './transaction-events.js';

/** Reusable composition inside the caller's existing transaction; no independent commit. */
export function taskDiscussionPorts(tx: Transaction, events: TaskDiscussionPorts['events']): TaskDiscussionPorts {
  return {
    access: policyWorkAccess(tx), work: workRows(tx), discussion: taskDiscussionRows(tx),
    events,
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
export function taskDiscussionUnitOfWork(db: Database): TaskDiscussionUnitOfWork {
  return { run: (action) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const result = await session.run(() => action(taskDiscussionPorts(tx, session)));
    await session.flushEvents();
    return result;
  }) };
}
export const taskDiscussionUseCases = (db: Database) => createTaskDiscussionUseCases(taskDiscussionUnitOfWork(db));
