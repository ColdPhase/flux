import { taskDiscussionRows, workRows } from '@flux/db';
import { createTaskDiscussionUseCases, recordEvent, type Database, type TaskDiscussionPorts, type TaskDiscussionUnitOfWork } from '@flux/core';
import { policyWorkAccess } from './adapters.js';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Reusable composition inside the caller's existing transaction; no independent commit. */
export function taskDiscussionPorts(tx: Tx): TaskDiscussionPorts {
  return {
    access: policyWorkAccess(tx), work: workRows(tx), discussion: taskDiscussionRows(tx),
    events: { record: async (principal, workspaceId, kind, projectId, data) => {
      await recordEvent(tx, principal, workspaceId, kind, projectId, data);
    } },
  };
}
export function taskDiscussionInTransaction(tx: Tx) {
  const unit: TaskDiscussionUnitOfWork = { run: (action) => action(taskDiscussionPorts(tx)) };
  return createTaskDiscussionUseCases(unit);
}
export function taskDiscussionUnitOfWork(db: Database): TaskDiscussionUnitOfWork {
  return { run: (action) => db.transaction((tx) => action(taskDiscussionPorts(tx))) };
}
export const taskDiscussionUseCases = (db: Database) => createTaskDiscussionUseCases(taskDiscussionUnitOfWork(db));
