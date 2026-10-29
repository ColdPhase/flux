import { dmRows, schema, type DbExecutor, visibleFilter, accessReader } from '@flux/db';
import { eq, and } from 'drizzle-orm';
import {
  createDmUseCases,
  policyDmAccess,
  recordEvent,
  type Database,
  type DmPorts,
  type DmRepository,
  type DmTaskCopy,
  type DmUnitOfWork,
  type Transaction,
} from '@flux/core';
import { eventPorts } from '../events.js';
import { sketchPromotion } from '../sketches/adapters.js';
import { nativeWorkInTransaction } from '../work/adapters.js';
import { messageReferences } from '../conversation/references.js';

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

/**
 * The project side of an excerpt copy (#537), over the sketch promotion's target and audience reads and the
 * work use cases, so `project.write`, the project's people and task creation are the existing ones.
 */
function dmTaskCopy(tx: Transaction): DmTaskCopy {
  const promotion = sketchPromotion(tx);
  return {
    async targets(principal, workspaceId) { return (await promotion.targets(principal, workspaceId)).projects; },
    async audience(principal, workspaceId, projectId) {
      const { people, projectName } = await promotion.audience(principal, workspaceId, [], { kind: 'existing', projectId });
      return { people, projectName: projectName ?? '' };
    },
    async lockDestination(workspaceId, projectId) {
      // The rows a change of the audience locks first, FOR SHARE: the workspace (member changes), then the project (grants).
      await tx.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).for('share');
      await tx.select({ id: schema.projects.id }).from(schema.projects)
        .where(and(eq(schema.projects.id, projectId), eq(schema.projects.workspaceId, workspaceId))).for('share');
    },
    async createTask(principal, projectId, command) {
      const work = nativeWorkInTransaction(tx);
      const task = await work.createWork(principal, projectId, { title: command.title, outcome: command.outcome, clientCommandId: command.clientCommandId });
      await work.flushEvents();
      return task;
    },
  };
}

function dmPorts(tx: Transaction): DmPorts {
  return {
    access: policyDmAccess(accessReader(tx)),
    references: { assertReadable: (principal, workspaceId, references) => messageReferences(tx).assertReadable(principal, workspaceId, references),
      save: (messageId, workspaceId, references) => messageReferences(tx).save({ kind: 'dm', id: messageId }, workspaceId, references) },
    taskCopy: dmTaskCopy(tx),
    dms: dmRepository(tx),
    events: { record: async (principal, workspaceId, kind, dmId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, dmId, data); } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function dmUnitOfWork(db: Database): DmUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(dmPorts(tx))) };
}

/** The direct-message use cases bound to a connection or transaction. */
export const dmUseCases = (db: Database) => createDmUseCases(dmUnitOfWork(db));
