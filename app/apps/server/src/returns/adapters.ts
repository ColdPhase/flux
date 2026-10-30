import { returnRows, type DbExecutor, visibleFilter, accessReader, lockedWorkspacesOfRead, sql, type Database } from '@flux/db';
import {
  authorize,
  authorizeEvent,
  createReturnUseCases,
  enforce,
  evaluateProject,
  NotFoundError,
  WorkspaceLockedError,
  type ReturnAccess,
  type ReturnRepository,
} from '@flux/core';

// Adapters that connect the core return view (#106) to the access policy and the Drizzle rows.
// Core defines the ports (#46); every decision here comes from the single policy choke point.

/** Access through `authorizeEvent` (the stream's final check), `evaluateProject` and `visibleFilter`. */
export function policyReturnAccess(db: DbExecutor): ReturnAccess {
  const rows = returnRows(db);
  // F-030 (#717 review P2-2): a locked encrypted workspace of the caller is left out of Return entirely (its events are
  // not received), and a place inside one answers 423.
  const refuseLockedPlace = async (projectId: string) => {
    const locked = lockedWorkspacesOfRead();
    if (!locked.size) return;
    const [row] = (await db.execute(sql`SELECT workspace_id AS id FROM projects WHERE id = ${projectId}::uuid`)).rows as { id: string }[];
    if (row && locked.has(row.id)) throw new WorkspaceLockedError(row.id, locked.get(row.id)!);
  };
  return {
    async requirePlace(principal, place) {
      if (place.type === 'project') {
        enforce(await evaluateProject(principal, 'project.read', place.id, accessReader(db)), 'project');
        await refuseLockedPlace(place.id);
        return { projectId: place.id, conversationId: null };
      }
      // The conversation's project, whoever may read it; an invisible one is reported like a missing one.
      const projectId = await rows.conversationProject(place.id);
      if (!projectId || !(await authorize(principal, 'project.read', { type: 'project', id: projectId }, accessReader(db))).allowed)
        throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
      await refuseLockedPlace(projectId);
      return { projectId, conversationId: place.id };
    },
    canReceive: async (principal, event) => (event.workspaceId && lockedWorkspacesOfRead().has(event.workspaceId) ? false : authorizeEvent(principal, event, accessReader(db))),
    async visibleProjects(principal, workspaceId) {
      return rows.projectIdsWhere(workspaceId, await visibleFilter(principal, workspaceId, 'project', db));
    },
    async canWrite(principal, projectId) {
      return (await authorize(principal, 'project.write', { type: 'project', id: projectId }, accessReader(db))).allowed;
    },
  };
}

export function returnRepository(db: DbExecutor): ReturnRepository {
  return returnRows(db) as ReturnRepository;
}

/** The return use cases bound to a connection. */
export const returnUseCases = (db: Database) => createReturnUseCases({ access: policyReturnAccess(db), returns: returnRepository(db) });
