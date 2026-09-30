import { taskDiscussionRows, workRows } from '@flux/db';
import { createTaskDiscussionUseCases, recordEvents, type Database, type TaskDiscussionEventIntent, type Transaction, type TaskDiscussionPorts, type TaskDiscussionUnitOfWork } from '@flux/core';
import { policyWorkAccess } from './adapters.js';

/** Reusable composition inside the caller's existing transaction; no independent commit. */
export function taskDiscussionPorts(tx: Transaction, events: TaskDiscussionPorts['events']): TaskDiscussionPorts {
  return {
    access: policyWorkAccess(tx), work: workRows(tx), discussion: taskDiscussionRows(tx),
    events,
  };
}

/** Prepare canonical content now; the caller finishes all other writes before final flush. */
function prepareTaskDiscussion(tx: Transaction) {
  const intents: TaskDiscussionEventIntent[] = [];
  let closed = false;
  let active = 0;
  let flushing: Promise<string[]> | undefined;
  const ports = taskDiscussionPorts(tx, { record: async (principal, workspaceId, kind, objectId, data) => {
    if (closed) throw new Error('Task discussion event session is closed');
    intents.push(Object.freeze({ principal: Object.freeze({ ...principal }), workspaceId, kind, objectId,
      data: Object.freeze({ ...data }) }));
  } });
  const unit: TaskDiscussionUnitOfWork = { run: async (action) => {
    if (closed) throw new Error('Task discussion event session is closed');
    active++;
    try { return await action(ports); } finally { active--; }
  } };
  return {
    unit,
    get eventIntents(): readonly TaskDiscussionEventIntent[] { return Object.freeze([...intents]); },
    flushEvents(): Promise<string[]> {
      if (flushing) return flushing;
      if (active) throw new Error('Await all task discussion commands before flushing events');
      closed = true;
      flushing = recordEvents(tx, intents);
      return flushing;
    },
  };
}
export function taskDiscussionInTransaction(tx: Transaction) {
  const session = prepareTaskDiscussion(tx);
  return { ...createTaskDiscussionUseCases(session.unit),
    get eventIntents() { return session.eventIntents; }, flushEvents: session.flushEvents };
}
export function taskDiscussionUnitOfWork(db: Database): TaskDiscussionUnitOfWork {
  return { run: (action) => db.transaction(async (tx) => {
    const session = prepareTaskDiscussion(tx);
    const result = await session.unit.run(action);
    await session.flushEvents();
    return result;
  }) };
}
export const taskDiscussionUseCases = (db: Database) => createTaskDiscussionUseCases(taskDiscussionUnitOfWork(db));
