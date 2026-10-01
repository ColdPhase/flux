import { proactiveOutboxRows, workRows, type DbExecutor } from '@flux/db';
import {
  visibleFilter,
  createWorkUseCases,
  COMPARISON_QUIET_WINDOW_MS,
  type Database,
  type WorkPorts,
  type WorkRepository,
  type WorkUnitOfWork,
  type Transaction,
} from '@flux/core';
import { taskDiscussionInEventSession } from './task-discussions.js';
import { transactionEventSession, type TransactionEventSession } from './transaction-events.js';
import { policyWorkAccess } from './access.js';
export { policyWorkAccess } from './access.js';

// Adapters that connect the core work use cases (#101) to the access policy, the Drizzle rows
// and the event log. Core defines the ports (#46); the server assembles them per transaction.

export function workRepository(tx: DbExecutor): WorkRepository {
  const rows = workRows(tx);
  return {
    ...rows,
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listAssignedVisible(principal, workspaceId, owner, page) {
      return rows.listAssigned(workspaceId, owner, await visibleFilter(principal, workspaceId, 'project', tx), page);
    },
  };
}

function workPorts(tx: DbExecutor, events: WorkPorts['events']): WorkPorts {
  return {
    access: policyWorkAccess(tx),
    work: workRepository(tx),
    events,
    backgroundComparison: { async enqueueHumanNegative(resultId, projectId, authorId) {
      const rows = proactiveOutboxRows(tx);
      const eligible: string[] = [];
      for (const rule of await rows.enabledRules(projectId)) {
        const owner = await evaluateProject({ kind: 'human', id: rule.ownerUserId }, 'project.write', projectId, tx, { lock: true });
        const agent = await evaluateProject({ kind: 'agent', id: rule.agentId }, 'project.write', projectId, tx, { lock: true });
        if (owner.allowed && agent.allowed && agent.actor?.agent?.ownerUserId === rule.ownerUserId) eligible.push(rule.id);
      }
      return rows.enqueueHumanNegative(resultId, projectId, authorId, eligible, new Date(Date.now() + COMPARISON_QUIET_WINDOW_MS));
    } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function workUnitOfWork(db: Database): WorkUnitOfWork {
  return { run: (work) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const result = await session.run(() => work(workPorts(tx, session)));
    await session.flushEvents();
    return result;
  }) };
}

/** Existing native commands share the composing caller's event lifetime. */
export function nativeWorkInEventSession(tx: Transaction, session: TransactionEventSession) {
  const ports = workPorts(tx, session);
  return { ...createWorkUseCases({ run: (action) => session.run(() => action(ports)) }),
    ...taskDiscussionInEventSession(tx, session) };
}

/** One caller-owned transaction, all native preparation, one final audience batch. */
export function nativeWorkInTransaction(tx: Transaction) {
  const session = transactionEventSession(tx);
  return { ...nativeWorkInEventSession(tx, session),
    get eventIntents() { return session.eventIntents; }, flushEvents: session.flushEvents };
}

/** The work use cases bound to a connection or transaction. */
export const workUseCases = (db: Database) => createWorkUseCases(workUnitOfWork(db));
