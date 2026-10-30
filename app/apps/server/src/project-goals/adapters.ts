import { projectGoalRows, type DbExecutor, accessReader, type Database } from '@flux/db';
import {
  createProjectGoalUseCases,
  enforce,
  evaluateProject,
  recordEvent,
  type ProjectGoalPorts,
  type ProjectGoalUnitOfWork,
} from '@flux/core';
import { eventPorts } from '../events.js';

// Adapters that connect the core project goal use cases (#520) to the access policy, the Drizzle rows and
// the event log. Core defines the ports (#46); every decision here comes from the single policy choke point.

function projectGoalPorts(tx: Database): ProjectGoalPorts {
  return {
    access: {
      async read(principal, projectId) {
        enforce(await evaluateProject(principal, 'project.read', projectId, accessReader(tx)), 'project');
      },
      async write(principal, projectId) {
        const { project } = enforce(await evaluateProject(principal, 'project.write', projectId, accessReader(tx), { lock: true }), 'project');
        return { workspaceId: project!.workspaceId };
      },
    },
    goals: projectGoalRows(tx as DbExecutor),
    events: { record: async (principal, workspaceId, kind, projectId, data) => { await recordEvent(eventPorts(tx), principal, workspaceId, kind, projectId, data); } },
  };
}

/** One transaction per use case; on an open transaction (an idempotency scope) it nests as a savepoint. */
export function projectGoalUnitOfWork(db: Database): ProjectGoalUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(projectGoalPorts(tx as unknown as Database))) };
}

/** The project goal use cases bound to a connection or transaction. */
export const projectGoalUseCases = (db: Database) => createProjectGoalUseCases(projectGoalUnitOfWork(db));
