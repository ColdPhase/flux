import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accessPorts, needsYouRows, notificationPreferenceRows, returnRows, memberFilter, accessReader, schema, type Database } from '@flux/db';
import {
  createNeedsYou,
  preferenceRepository,
  evaluateProject,
  listWorkspaces,
  type NeedsYouAccess,
  type NeedsYouAssistant,
} from '@flux/core';
import { notificationRepository } from '../push/adapters.js';
import { aiAllowedInProject } from '../access/ai-gate.js';
import { workRepository } from '../work/adapters.js';

// Adapters that connect the core "Needs you" queue (#342) to the access policy and the Drizzle rows.
// Core defines the ports (#46); every decision here comes from the single policy choke point.

export function policyNeedsYouAccess(db: Database): NeedsYouAccess {
  const rows = needsYouRows(db);
  const returns = returnRows(db);
  return {
    async workspaceIds(principal) {
      return (await listWorkspaces(principal, db, accessPorts)).map((workspace) => workspace.id);
    },
    async visibleProjects(principal, workspaceId) {
      return returns.projectIdsWhere(workspaceId, await memberFilter(principal, workspaceId, 'project', db));
    },
    async canAccept(principal, projectId) {
      return principal.kind === 'human' && (await evaluateProject(principal, 'project.write', projectId, accessReader(db))).allowed;
    },
    async accepters(projectId, limit) {
      const people: { id: string; name: string }[] = [];
      for (const member of await rows.workspaceMembersOfProject(projectId, 50)) {
        if (people.length >= limit) break;
        // One person once, however many membership rows reach them (#763).
        if (people.some((person) => person.id === member.id)) continue;
        if ((await evaluateProject({ kind: 'human', id: member.id }, 'project.write', projectId, accessReader(db))).allowed) people.push(member);
      }
      return people;
    },
    projectNames: (ids) => returns.projects(ids).then((map) => new Map([...map].map(([id, project]) => [id, project.name as string]))),
  };
}

/** The "Needs you" use cases bound to a connection. */
export const needsYouUseCases = (db: Database, assistant?: NeedsYouAssistant) => createNeedsYou({
  access: policyNeedsYouAccess(db),
  aiAllowed: (projectId) => aiAllowedInProject(db, projectId),
  ...(assistant ? { assistant } : {}),
  repository: needsYouRows(db),
  // The Inbox's rows say who they come from ("Question · Maja · Community garden sensors", #1424).
  inbox: { listReadable: async (userId, limit) => notificationRepository(db).listReadable(userId, limit, { from: true }) },
  level: async (userId) => (await preferenceRepository(notificationPreferenceRows(db)).get(userId)).level,
  work: workRepository(db),
  // A call is on while it is available and someone is in it: its room is not empty (F-041).
  async runningCalls(sessionIds) {
    const ls = schema.liveSessions;
    const rows = await db.select({ id: ls.id }).from(ls).where(and(inArray(ls.id, sessionIds), eq(ls.state, 'available'), isNull(ls.emptySince)));
    return new Set(rows.map((row) => row.id));
  },
});
