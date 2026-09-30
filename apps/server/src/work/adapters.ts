import { proactiveOutboxRows, workRows, type DbExecutor } from '@flux/db';
import {
  assertAuthorized,
  authorize,
  enforce,
  evaluateProject,
  recordEvent,
  visibleFilter,
  createWorkUseCases,
  COMPARISON_QUIET_WINDOW_MS,
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
  return { run: (work) => db.transaction((tx) => work(workPorts(tx))) };
}

/** The work use cases bound to a connection or transaction. */
export const workUseCases = (db: Database) => createWorkUseCases(workUnitOfWork(db));
