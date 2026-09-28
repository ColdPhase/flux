import { proactiveOutboxRows, workRows, type DbExecutor } from '@flux/db';
import {
  assertAuthorized,
  authorize,
  enforce,
  evaluateProject,
  recordEvent,
  visibleFilter,
  createWorkUseCases,
  type Database,
  type WorkAccess,
  type WorkPorts,
  type WorkRepository,
  type WorkUnitOfWork,
} from '@flux/core';

// Adapters that connect the core work use cases (#101) to the access policy, the Drizzle rows
// and the event log. Core defines the ports (#46); the server assembles them per transaction.

/** Project access through the single policy choke point: `evaluateProject`/`authorize`. */
export function policyWorkAccess(tx: DbExecutor): WorkAccess {
  const db = tx;
  return {
    async requireProject(principal, action, projectId, options) {
      const checked = enforce(await evaluateProject(principal, action === 'write' ? 'project.write' : 'project.read', projectId, db, options), 'project');
      return { workspaceId: checked.project!.workspaceId };
    },
    requireWorkspace: (principal, workspaceId) => assertAuthorized(principal, 'workspace.read', { type: 'workspace', id: workspaceId }, db),
    async canRead(candidate, projectId) {
      return (await authorize(candidate, 'project.read', { type: 'project', id: projectId }, db)).allowed;
    },
  };
}

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

function workPorts(tx: DbExecutor): WorkPorts {
  return {
    access: policyWorkAccess(tx),
    work: workRepository(tx),
    events: { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(tx, principal, workspaceId, kind, projectId, data); } },
    backgroundComparison: { enqueueHumanNegative: (resultId, projectId, authorId) =>
      proactiveOutboxRows(tx).enqueueHumanNegative(resultId, projectId, authorId) },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function workUnitOfWork(db: Database): WorkUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(workPorts(tx))) };
}

/** The work use cases bound to a connection or transaction. */
export const workUseCases = (db: Database) => createWorkUseCases(workUnitOfWork(db));
