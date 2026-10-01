import { returnRows, type DbExecutor } from '@flux/db';
import {
  authorize,
  authorizeEvent,
  createReturnUseCases,
  enforce,
  evaluateProject,
  NotFoundError,
  visibleFilter,
  type Database,
  type ReturnAccess,
  type ReturnRepository,
} from '@flux/core';

// Adapters that connect the core return view (#106) to the access policy and the Drizzle rows.
// Core defines the ports (#46); every decision here comes from the single policy choke point.

/** Access through `authorizeEvent` (the stream's final check), `evaluateProject` and `visibleFilter`. */
export function policyReturnAccess(db: DbExecutor): ReturnAccess {
  const rows = returnRows(db);
  return {
    async requirePlace(principal, place) {
      if (place.type === 'project') {
        enforce(await evaluateProject(principal, 'project.read', place.id, db), 'project');
        return { projectId: place.id, conversationId: null };
      }
      // The conversation's project, whoever may read it; an invisible one is reported like a missing one.
      const projectId = await rows.conversationProject(place.id);
      if (!projectId || !(await authorize(principal, 'project.read', { type: 'project', id: projectId }, db)).allowed)
        throw new NotFoundError('Conversation', 'CONVERSATION_NOT_FOUND');
      return { projectId, conversationId: place.id };
    },
    canReceive: (principal, event) => authorizeEvent(principal, event, db),
    async visibleProjects(principal, workspaceId) {
      return rows.projectIdsWhere(workspaceId, await visibleFilter(principal, workspaceId, 'project', db));
    },
    async canWrite(principal, projectId) {
      return (await authorize(principal, 'project.write', { type: 'project', id: projectId }, db)).allowed;
    },
  };
}

export function returnRepository(db: DbExecutor): ReturnRepository {
  return returnRows(db) as ReturnRepository;
}

/** The return use cases bound to a connection. */
export const returnUseCases = (db: Database) => createReturnUseCases({ access: policyReturnAccess(db), returns: returnRepository(db) });
