import { personalRunRows, TaskUseRefusal, type DbExecutor } from '@flux/db';
import { ConflictError, RuleViolationError, policyPersonalRunAccess, recordEvent, type Database, type PersonalRunPorts, type PersonalRunUnitOfWork } from '@flux/core';

// Worker adapters for personal-run dispatch (#68, O-008; #46: the rules live in core, the worker
// composes the access policy, Drizzle rows and the event log).

function personalRunPorts(tx: DbExecutor): PersonalRunPorts {
  return {
    access: policyPersonalRunAccess(tx),
    runs: personalRunRows(tx),
    // The processor never queues: retries are new runs the owner starts through the API.
    queue: { enqueue: async () => { throw new Error('The worker does not queue personal runs'); } },
    events: { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(tx, principal, workspaceId, kind, projectId, data); } },
  };
}

export function personalRunWorkerUnitOfWork(db: Database): PersonalRunUnitOfWork {
  return { run: (work) => db.transaction(async (tx) => {
    try { return await work(personalRunPorts(tx)); }
    catch (error) {
      if (!(error instanceof TaskUseRefusal)) throw error;
      if (error.code === 'TASK_TARGET_NOT_FOUND') throw new RuleViolationError('A task target is unavailable', error.code);
      throw new ConflictError(error.code === 'TASK_CREATION_REVERTED'
        ? 'Task creation was undone; open its history' : 'Task references changed; retry from current details', error.code);
    }
  }) };
}
