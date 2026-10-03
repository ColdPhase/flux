import { docRows, type DbExecutor } from '@flux/db';
import { createDocUseCases, recordEvent, visibleFilter, type Database, type DocPorts, type DocRepository, type DocUnitOfWork, type Transaction } from '@flux/core';
import { policyWorkAccess, workRepository } from '../work/adapters.js';
import type { TransactionEventSession } from '../work/transaction-events.js';
import { markdownRenderer } from './markdown.js';
import { eventPorts } from '../events.js';

// Adapters that connect the core doc use cases (#112) to the access policy, the Drizzle rows,
// the #101 link rows, the event log and the Markdown renderer. Core defines the ports (#46).

export function docRepository(tx: DbExecutor): DocRepository {
  const rows = docRows(tx);
  return {
    ...rows,
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listVisible(principal, workspaceId, page) {
      return rows.listVisible(workspaceId, await visibleFilter(principal, workspaceId, 'project', tx), page);
    },
  };
}

function docPorts(tx: DbExecutor, events?: DocPorts['events']): DocPorts {
  return {
    access: policyWorkAccess(tx),
    docs: docRepository(tx),
    work: workRepository(tx),
    events: events ?? { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, projectId, data); } },
    renderer: markdownRenderer,
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function docUnitOfWork(db: Database): DocUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(docPorts(tx))) };
}

export const docUseCases = (db: Database) => createDocUseCases(docUnitOfWork(db));

/**
 * The same doc commands inside a #152 standing-grant execution: the caller's transaction, its single final event
 * batch, and the agent as the real author. Only that composition accepts an agent principal.
 */
export function nativeDocsInEventSession(tx: Transaction, session: TransactionEventSession) {
  const ports = docPorts(tx, session);
  return createDocUseCases({ run: (action) => session.run(() => action(ports)) }, { agentAuthors: true });
}
