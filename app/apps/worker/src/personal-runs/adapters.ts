import { assistantJobRows, personalRunRows, TaskUseRefusal, withIdpStanding, accessReader } from '@flux/db';
import {
  ConflictError, DomainError, RuleViolationError, policyPersonalRunAccess, prepareSchedule, recordEvent, scheduleWords, type Database, type PersonalRunPorts, type PersonalRunQueue,
  type PersonalRunUnitOfWork, type Transaction,
} from '@flux/core';
import { eventPorts } from '../events.js';

// Worker adapters for personal-run dispatch (#68, O-008; #46: the rules live in core, the worker
// composes the access policy, Drizzle rows and the event log).

/**
 * The personal-run ports inside `tx`. The processor never queues (retries are new runs the owner starts through the API); the
 * schedule tick passes a queue for the runs it starts. A request's schedule block prepares a schedule here, off, in a
 * savepoint of its own, so a refused one leaves the run's commit untouched (F-027 AST-7 "Set up by asking").
 */
export function personalRunPorts(tx: Transaction, queue?: PersonalRunQueue): PersonalRunPorts {
  const ports: PersonalRunPorts = {
    access: withIdpStanding(policyPersonalRunAccess(accessReader(tx)), tx),
    runs: personalRunRows(tx),
    queue: queue ?? { enqueue: async () => { throw new Error('The worker does not queue personal runs'); } },
    events: { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, projectId, data); } },
  };
  ports.schedules = {
    async prepare(ownerUserId, projectId, runId, request) {
      try {
        const enablement = await ports.runs.enablement(ownerUserId);
        if (!enablement) return { ok: false, message: 'your assistant is off' };
        const job = await tx.transaction((savepoint) => prepareSchedule({ ...personalRunPorts(savepoint, queue), jobs: assistantJobRows(savepoint),
          inbox: { tell: async () => { throw new Error('Nothing is told about a prepared schedule'); } } }, ownerUserId,
        { projectId, ...(request.title ? { title: request.title } : {}), text: request.text, schedule: request.schedule as never, timeZone: enablement.timeZone }, runId));
        return { ok: true, title: job.title, words: scheduleWords(job.schedule, job.timeZone) };
      } catch (error) {
        if (error instanceof DomainError) return { ok: false, message: error.message };
        throw error;
      }
    },
  };
  return ports;
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
