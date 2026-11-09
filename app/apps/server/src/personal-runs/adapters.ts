import { withTaskUseErrors } from '../work/task-use-errors.js';
import { fromDrizzle, type PgBoss } from 'pg-boss';
import { personalRunRows, withIdpStanding, sql, type DbExecutor, accessReader, type Database } from '@flux/db';
import {
  createPersonalRunUseCases,
  noPersonalConnections,
  PERSONAL_RUN_JOB,
  policyPersonalRunAccess,
  recordEvent,
  type PersonalConnectionLookup, type PersonalRuntimeAvailability,
  type PersonalRunPorts,
  type PersonalRunQueue,
  type PersonalRunUnitOfWork,
} from '@flux/core';
import { transactionEventSession } from '../work/transaction-events.js';
import { assistantRows } from '../assistant/adapters.js';
import { eventPorts } from '../events.js';

// Adapters that connect the personal-run use cases (#68, O-008) to the access policy, the
// Drizzle rows, the event log and pg-boss. Core defines the ports (#46); the server assembles
// them per transaction. The server never calls the provider; only the worker dispatches.

/** Queues a run's dispatch job inside the unit of work, so run, reservation and job commit together. */
export type PersonalRunQueueFactory = (tx: DbExecutor) => PersonalRunQueue;

export function pgBossPersonalRunQueue(boss: Pick<PgBoss, 'send'>): PersonalRunQueueFactory {
  return (tx) => ({
    async enqueue(runId) {
      const jobId = await boss.send(PERSONAL_RUN_JOB, { runId }, { db: fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql) });
      if (!jobId) throw new Error('Job enqueue failed');
    },
  });
}

export function personalRunPorts(tx: DbExecutor, queue: PersonalRunQueueFactory,
  events?: PersonalRunPorts['events'], session?: ReturnType<typeof transactionEventSession>): PersonalRunPorts {
  return {
    ...(session ? { assistants: assistantRows(tx) } : {}),
    access: withIdpStanding(policyPersonalRunAccess(accessReader(tx)), tx),
    runs: personalRunRows(tx),
    queue: queue(tx),
    events: events ?? { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, projectId, data); } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function personalRunUnitOfWork(db: Database, queue: PersonalRunQueueFactory): PersonalRunUnitOfWork {
  return { run: (work) => db.transaction(async (tx) => {
    const session = transactionEventSession(tx);
    const result = await session.run(() => withTaskUseErrors(() => work(personalRunPorts(tx, queue, session, session))));
    await session.flushEvents();
    return result;
  }) };
}

export interface PersonalRunComposition {
  queue: PersonalRunQueueFactory;
  /** #124 supplies the real lookup; until then nobody has a usable connection. */
  connections?: PersonalConnectionLookup;
  /** The instance operator's provider switch; off until the provider adapter lands. */
  providerEnabled?: boolean;
  /** The owner's own Claude Code in the agent runtime (F-022 AIM-3, #280); absent: no runtime assistant. */
  runtime?: PersonalRuntimeAvailability;
}

export function personalRunUseCases(db: Database, { queue, connections = noPersonalConnections, providerEnabled = false, runtime }: PersonalRunComposition) {
  return createPersonalRunUseCases({ uow: personalRunUnitOfWork(db, queue), connections, providerEnabled, ...(runtime ? { runtime } : {}) });
}
