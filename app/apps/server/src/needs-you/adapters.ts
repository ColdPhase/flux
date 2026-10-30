import { accessPorts, needsYouRows, returnRows, visibleFilter, accessReader, type Database } from '@flux/db';
import {
  createNeedsYou,
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
      return returns.projectIdsWhere(workspaceId, await visibleFilter(principal, workspaceId, 'project', db));
    },
    async canAccept(principal, projectId) {
      return principal.kind === 'human' && (await evaluateProject(principal, 'project.write', projectId, accessReader(db))).allowed;
    },
    async accepters(projectId, limit) {
      const people: { id: string; name: string }[] = [];
      for (const member of await rows.workspaceMembersOfProject(projectId, 50)) {
        if (people.length >= limit) break;
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
  inbox: notificationRepository(db),
  work: workRepository(db),
});
