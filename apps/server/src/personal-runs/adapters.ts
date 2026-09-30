import { fromDrizzle, type PgBoss } from 'pg-boss';
import { personalRunRows, sql, workRows, type DbExecutor } from '@flux/db';
import {
  createAssistantProposalUseCases,
  createPersonalRunUseCases,
  noPersonalConnections,
  PERSONAL_RUN_JOB,
  policyPersonalRunAccess,
  recordEvent,
  type Database,
  type PersonalConnectionLookup,
  type PersonalRunPorts,
  type PersonalRunQueue,
  type PersonalRunUnitOfWork,
  type ProposalUnitOfWork,
} from '@flux/core';
import { workUseCases } from '../work/adapters.js';

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

function personalRunPorts(tx: DbExecutor, queue: PersonalRunQueueFactory): PersonalRunPorts {
  return {
    access: policyPersonalRunAccess(tx),
    runs: personalRunRows(tx),
    queue: queue(tx),
    events: { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(tx, principal, workspaceId, kind, projectId, data); } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function personalRunUnitOfWork(db: Database, queue: PersonalRunQueueFactory): PersonalRunUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(personalRunPorts(tx, queue))) };
}

/** Accept records the result through the #101 work use case, in the accept's own transaction. */
export function proposalUnitOfWork(db: Database, queue: PersonalRunQueueFactory): ProposalUnitOfWork {
  return {
    run: (work) => db.transaction((tx) => {
      const rows = workRows(tx);
      return work({
        ...personalRunPorts(tx, queue),
        results: {
          async findWork(workId, options) {
            const item = await rows.findWork(workId, options);
            return item ? { id: item.id, projectId: item.projectId, version: item.version, ownerUserId: item.owner?.kind === 'human' ? item.owner.id : null } : null;
          },
          recordResult: (principal, projectId, command) => workUseCases(tx as unknown as Database).createResult(principal, projectId, command),
        },
      });
    }),
  };
}

export interface PersonalRunComposition {
  queue: PersonalRunQueueFactory;
  /** #124 supplies the real lookup; until then nobody has a usable connection. */
  connections?: PersonalConnectionLookup;
  /** The instance operator's provider switch; off until the provider adapter lands. */
  providerEnabled?: boolean;
}

export function personalRunUseCases(db: Database, { queue, connections = noPersonalConnections, providerEnabled = false }: PersonalRunComposition) {
  return createPersonalRunUseCases({ uow: personalRunUnitOfWork(db, queue), connections, providerEnabled });
}

export const assistantProposalUseCases = (db: Database, queue: PersonalRunQueueFactory) => createAssistantProposalUseCases(proposalUnitOfWork(db, queue));
