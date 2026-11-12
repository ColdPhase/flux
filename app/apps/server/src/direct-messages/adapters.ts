import { accessPorts, dmRows, messageChangeRows, needsYouRows, schema, toDmMessageRecord, type DbExecutor, visibleFilter, accessReader, type Database, type Transaction } from '@flux/db';
import { eq, and } from 'drizzle-orm';
import {
  createDmUseCases,
  getProject,
  listProjectPeople,
  listProjects,
  policyDmAccess,
  recordEvent,
  RuleViolationError,
  type DmPorts,
  type DmRepository,
  type DmTaskCopy,
  type DmUnitOfWork,
} from '@flux/core';
import { eventPorts } from '../events.js';
import { nativeWorkInTransaction } from '../work/adapters.js';
import { messageReferences } from '../conversation/references.js';

// Adapters that connect the core direct-message use cases to Drizzle, the access policy and the
// event log (issue #107; #46: core defines the ports, the server assembles them).

export function dmRepository(db: DbExecutor): DmRepository {
  const rows = dmRows(db);
  const changes = messageChangeRows(db);
  return {
    ...rows,
    /** An author's Edit or Delete (#1006): the row locked, the words sealed on the way in, everything that carried them removed. */
    async lockMessage(dmId, messageId) {
      const row = await changes.lockDm(dmId, messageId);
      return row ? toDmMessageRecord(row) : null;
    },
    async editMessage(message, body) { await changes.editDm(message, body); },
    async removeMessage(message) { await changes.removeDm(message); },
    /** The policy's own list condition (`visibleFilter`) is applied before the limit and in the total. */
    async listVisible(principal, workspaceId, page) {
      return rows.list(workspaceId, await visibleFilter(principal, workspaceId, 'dm', db), page);
    },
  };
}

/**
 * The project side of an excerpt copy (#537), over the project and work use cases, so `project.write`, the
 * project's people and task creation are the existing ones. The audience is people only: an agent is no reader of
 * its own, it reads with exactly its owner's rights (F-036 AG-1, AG-3), so naming the owner covers it.
 */
function dmTaskCopy(tx: Transaction): DmTaskCopy {
  return {
    async targets(principal, workspaceId) {
      const projects: { id: string; name: string }[] = [];
      for (let offset = 0; ; offset += 100) {
        const page = await listProjects(principal, workspaceId, { limit: 100, offset }, tx, accessPorts);
        projects.push(...page.items.filter((p) => p.access === 'contributor' || p.access === 'manager').map((p) => ({ id: p.id, name: p.name })));
        if (offset + page.items.length >= page.total || !page.items.length) break;
      }
      return projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    },
    async audience(principal, workspaceId, projectId) {
      const project = await getProject(principal, projectId, tx, accessPorts);
      if (project.workspaceId !== workspaceId) throw new RuleViolationError('The space belongs to another company', 'CROSS_WORKSPACE');
      const people = await listProjectPeople(principal, project.id, tx, accessPorts);
      return { people: people.filter((p) => p.kind === 'human').map((p) => ({ id: p.id, name: p.name, reason: 'project' as const })), projectName: project.name };
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
    // A reply answers what its author was asked or mentioned in this conversation (#1249), as in a space thread (#1170).
    inbox: { answerIn: (userId, dmId) => needsYouRows(tx as unknown as DbExecutor).answerInDm(userId, dmId) },
    events: { record: async (principal, workspaceId, kind, dmId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, dmId, data); } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function dmUnitOfWork(db: Database): DmUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(dmPorts(tx))) };
}

/** The direct-message use cases bound to a connection or transaction. */
export const dmUseCases = (db: Database) => createDmUseCases(dmUnitOfWork(db));
