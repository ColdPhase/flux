import { searchRows, sealedSearchRows, type QueryVectors, type SearchExecutor, type SQL, visibleFilterOf, memberFilterOf, accessReader, loadActor, type AccessActor, type Database } from '@flux/db';
import {
  authorize,
  createSearchUseCases,
  type Principal,
  type SearchAccess,
  type SearchAudience,
  type SearchAudienceType,
  type SearchCursors,
  type SearchRepository,
  type SealedSearchRepository,
  type SearchRow,
} from '@flux/core';
import { agentOwnerNamesIn } from '../conversation/author-owners.js';

// Adapters that connect core search (#114) to the access policy and the Drizzle rows. Core
// defines the ports (#46); every audience here comes from the single policy choke point.

/**
 * The policy side of the audience registry: the list condition (`visibleFilter`) for each
 * audience type in one workspace, or whether the principal may read it at all. A new audience
 * type adds one entry here and one in `@flux/db`'s search rows. Each is decided from the actor's standing, read once per workspace for
 * all of them (#1429: four reads of the same standing before).
 */
const POLICY_AUDIENCES: Record<SearchAudienceType, (actor: AccessActor, db: Database) => Promise<SQL | null | false>> = {
  // F-037 (coordinator default): a company admin finds only what is in the spaces they were added to.
  project: async (actor) => memberFilterOf(actor, 'project'),
  dm: async (actor) => visibleFilterOf(actor, 'dm'),
  sketch: async (actor) => memberFilterOf(actor, 'sketch'),
  // People are found by whoever may read the workspace's members: the policy's own decision, from the same standing.
  members: async (actor, db) => (await authorize(actor.principal as Principal, 'workspace.read_members', { type: 'workspace', id: actor.workspaceId },
    { ...accessReader(db), loadActor: async () => actor })).allowed ? null : false,
};

/** Audiences through `visibleFilter` and `authorize`, read fresh for every search. */
export function policySearchAccess(db: Database): SearchAccess<SQL> {
  const rows = searchRows(db);
  return {
    async audiences(principal) {
      const workspaces = principal.kind === 'human' ? await rows.memberWorkspaces(principal.id)
        : principal.kind === 'agent' ? await rows.agentWorkspaces(principal.id) : [];
      const audiences: SearchAudience<SQL>[] = [];
      for (const workspaceId of workspaces) {
        const actor = await loadActor(principal, workspaceId, db);
        for (const type of Object.keys(POLICY_AUDIENCES) as SearchAudienceType[]) {
          const condition = await POLICY_AUDIENCES[type](actor, db);
          if (condition !== false) audiences.push({ type, workspaceId, condition });
        }
      }
      return audiences;
    },
  };
}

/** `vectors` is given while the optional embedding container is on (F-042, #1294): ranked search then fuses in the nearest vectors. */
export function searchRepository(db: SearchExecutor, vectors?: QueryVectors): SearchRepository<SQL> {
  return searchRows(db, vectors);
}

/** Encrypted workspaces answer from the in-memory index of this process (F-030 S2b). */
export function sealedSearchRepository(db: Database): SealedSearchRepository<SQL> {
  return sealedSearchRows(db);
}

/**
 * An agent author's owner as the row's space names them (`agentOwnerNamesIn`): by name while they can read the space, "Stefan Kowal (removed)"
 * once they left the company or were removed (#1424, 2026-11-17), and not at all when its readers cannot be told who it is. The same rule
 * for the plain rows and the encrypted workspaces' rows.
 */
async function withAgentOwners(db: Database, rows: SearchRow[]): Promise<SearchRow[]> {
  const spaces = new Map<string, { workspaceId: string; agents: Set<string> }>();
  for (const row of rows) {
    if (row.author?.kind !== 'agent' || !row.projectId) continue;
    const space = spaces.get(row.projectId) ?? { workspaceId: row.workspaceId, agents: new Set<string>() };
    space.agents.add(row.author.id);
    spaces.set(row.projectId, space);
  }
  for (const [projectId, space] of spaces) {
    const names = await agentOwnerNamesIn(db, projectId, space.workspaceId, [...space.agents]);
    for (const row of rows) if (row.projectId === projectId && row.author?.kind === 'agent') row.agentOwnerName = names.get(row.author.id) ?? null;
  }
  return rows;
}

/** The search use cases bound to a connection. */
export function searchUseCases(db: Database, cursors: SearchCursors, vectors?: QueryVectors) {
  const rows = searchRepository(db, vectors);
  const sealed = sealedSearchRepository(db);
  return createSearchUseCases({ access: policySearchAccess(db), cursors,
    rows: { ...rows, page: async (audiences, plan) => withAgentOwners(db, await rows.page(audiences, plan)),
      ranked: async (audiences, plan) => withAgentOwners(db, await rows.ranked(audiences, plan)) },
    sealed: { search: async (audiences, plan) => { const answer = await sealed.search(audiences, plan); await withAgentOwners(db, answer.rows); return answer; } } });
}
