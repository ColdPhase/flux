import { dmRows, type DbExecutor } from '@flux/db';
import {
  createDmUseCases,
  policyDmAccess,
  recordEvent,
  visibleFilter,
  type Database,
  type DmPorts,
  type DmRepository,
  type DmUnitOfWork,
} from '@flux/core';

// Adapters that connect the core direct-message use cases to Drizzle, the access policy and the
// event log (issue #107; #46: core defines the ports, the server assembles them).

export function dmRepository(db: DbExecutor): DmRepository {
  const rows = dmRows(db);
  return {
    ...rows,
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listVisible(principal, workspaceId, page) {
      return rows.list(workspaceId, await visibleFilter(principal, workspaceId, 'dm', db), page);
    },
  };
}

function dmPorts(tx: DbExecutor): DmPorts {
  return {
    access: policyDmAccess(tx),
    dms: dmRepository(tx),
    events: { record: async (principal, workspaceId, kind, dmId, data) => { await recordEvent(tx, principal, workspaceId, kind, dmId, data); } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function dmUnitOfWork(db: Database): DmUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(dmPorts(tx))) };
}

/** The direct-message use cases bound to a connection or transaction. */
export const dmUseCases = (db: Database) => createDmUseCases(dmUnitOfWork(db));
