import { withTaskUseErrors } from '../work/task-use-errors.js';
import { docLiveVersions, docRows, type DbExecutor } from '@flux/db';
import { createDocUseCases, recordEvent, visibleFilter, type Database, type DocPorts, type DocTaskUseMemory, type DocRepository, type DocUnitOfWork, type Transaction } from '@flux/core';
import { policyWorkAccess, workRepository } from '../work/adapters.js';
import type { TransactionEventSession } from '../work/transaction-events.js';
import { prepareDocWrite } from './preparation.js';
import { markdownRenderer } from './markdown.js';

// Adapters that connect the core doc use cases (#112) to the access policy, the Drizzle rows,
// the #101 link rows, the event log and the Markdown renderer. Core defines the ports (#46).

export function docRepository(tx: DbExecutor, memory?: DocTaskUseMemory): DocRepository {
  const rows = docRows(tx, memory);
  return {
    ...rows,
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listVisible(principal, workspaceId, page) {
      return rows.listVisible(workspaceId, await visibleFilter(principal, workspaceId, 'project', tx), page);
    },
  };
}

export function docPorts(tx: DbExecutor, events?: DocPorts['events'], taskUseMemory?: DocTaskUseMemory): DocPorts {
  return {
    access: policyWorkAccess(tx),
    docs: docRepository(tx, taskUseMemory),
    live: docLiveVersions(tx),
    work: workRepository(tx, taskUseMemory),
    events: events ?? { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(tx, principal, workspaceId, kind, projectId, data); } },
    renderer: markdownRenderer,
    taskUseMemory,
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function docUnitOfWork(db: Database, taskUseMemory?: DocTaskUseMemory): DocUnitOfWork {
  return { run: (work) => db.transaction((tx) => withTaskUseErrors(() => work(docPorts(tx, undefined, taskUseMemory)))) };
}

export function docUseCases(db: Database, taskUseMemory?: DocTaskUseMemory) {
  const docs = createDocUseCases(docUnitOfWork(db, taskUseMemory));
  if (taskUseMemory) return docs;
  // Standalone composition owns its actual transaction. Enclosing idempotent/native
  // callers explicitly pass their outer owner instead of releasing at a savepoint.
  async function write<T>(context: unknown, action: (owned: typeof docs) => Promise<T>) {
    const preparation = await prepareDocWrite(context);
    try { return await action(createDocUseCases(docUnitOfWork(db, preparation.memory))); }
    finally { preparation.release(); }
  }
  return { ...docs,
    createDoc: (...args: Parameters<typeof docs.createDoc>) => write(args, owned => owned.createDoc(...args)),
    updateDoc: (...args: Parameters<typeof docs.updateDoc>) => write(args, owned => owned.updateDoc(...args)),
    addSection: (...args: Parameters<typeof docs.addSection>) => write(args, owned => owned.addSection(...args)),
    saveLiveVersion: (...args: Parameters<typeof docs.saveLiveVersion>) => write(args, owned => owned.saveLiveVersion(...args)),
  };
}

/**
 * The same doc commands inside a #152 standing-grant execution: the caller's transaction, its single final event
 * batch, and the agent as the real author. Only that composition accepts an agent principal.
 */
export function nativeDocsInEventSession(tx: Transaction, session: TransactionEventSession, taskUseMemory: DocTaskUseMemory) {
  const ports = docPorts(tx, session, taskUseMemory);
  return createDocUseCases({ run: (action) => session.run(() => action(ports)) }, { agentAuthors: true });
}
