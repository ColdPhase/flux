import { taskDiscussionRows, workRows } from '@flux/db';
import { createTaskDiscussionUseCases, recordEvent, type Database, type TaskDiscussionUnitOfWork } from '@flux/core';
import { policyWorkAccess } from './adapters.js';

export function taskDiscussionUnitOfWork(db: Database): TaskDiscussionUnitOfWork {
  return { run: (action) => db.transaction((tx) => action({
    access: policyWorkAccess(tx), work: workRows(tx), discussion: taskDiscussionRows(tx),
    events: { record: async (principal, workspaceId, kind, projectId, data) => {
      await recordEvent(tx, principal, workspaceId, kind, projectId, data);
    } },
  })) };
}
export const taskDiscussionUseCases = (db: Database) => createTaskDiscussionUseCases(taskDiscussionUnitOfWork(db));
