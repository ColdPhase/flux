import { searchRows, type DbExecutor, type SQL } from '@flux/db';
import {
  authorize,
  createSearchUseCases,
  visibleFilter,
  type Database,
  type Principal,
  type SearchAccess,
  type SearchAudience,
  type SearchAudienceType,
  type SearchCursors,
  type SearchRepository,
} from '@flux/core';

// Adapters that connect core search (#114) to the access policy and the Drizzle rows. Core
// defines the ports (#46); every audience here comes from the single policy choke point.

/**
 * The policy side of the audience registry: the list condition (`visibleFilter`) for each
 * audience type in one workspace, or whether the principal may read it at all. A new audience
 * type adds one entry here and one in `@flux/db`'s search rows.
 */
const POLICY_AUDIENCES: Record<SearchAudienceType, (principal: Principal, workspaceId: string, db: DbExecutor) => Promise<SQL | null | false>> = {
  project: (principal, workspaceId, db) => visibleFilter(principal, workspaceId, 'project', db),
  dm: (principal, workspaceId, db) => visibleFilter(principal, workspaceId, 'dm', db),
  sketch: (principal, workspaceId, db) => visibleFilter(principal, workspaceId, 'sketch', db),
  draft: (principal, workspaceId, db) => visibleFilter(principal, workspaceId, 'draft', db),
  // People are found by whoever may read the workspace's members.
  members: async (principal, workspaceId, db) =>
    (await authorize(principal, 'workspace.read_members', { type: 'workspace', id: workspaceId }, db)).allowed ? null : false,
};

/** Audiences through `visibleFilter` and `authorize`, read fresh for every search. */
export function policySearchAccess(db: DbExecutor): SearchAccess<SQL> {
  const rows = searchRows(db);
  return {
    async audiences(principal) {
      const workspaces = principal.kind === 'human' ? await rows.memberWorkspaces(principal.id)
        : principal.kind === 'agent' ? await rows.agentWorkspaces(principal.id) : [];
      const audiences: SearchAudience<SQL>[] = [];
      for (const workspaceId of workspaces) {
        for (const type of Object.keys(POLICY_AUDIENCES) as SearchAudienceType[]) {
          const condition = await POLICY_AUDIENCES[type](principal, workspaceId, db);
          if (condition !== false) audiences.push({ type, workspaceId, condition });
        }
      }
      return audiences;
    },
  };
}

export function searchRepository(db: DbExecutor): SearchRepository<SQL> {
  return searchRows(db);
}

/** The search use cases bound to a connection. */
export const searchUseCases = (db: Database, cursors: SearchCursors) =>
  createSearchUseCases({ access: policySearchAccess(db), rows: searchRepository(db), cursors });
