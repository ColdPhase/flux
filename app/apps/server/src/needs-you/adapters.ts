import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accessPorts, needsYouRows, notificationPreferenceRows, openRows, returnRows, memberFilter, accessReader, schema, type Database, type DbExecutor } from '@flux/db';
import {
  createNeedsYou,
  preferenceRepository,
  evaluateProject,
  listWorkspaces,
  ConflictError,
  VersionConflictError,
  type NeedsYouAccess,
  type NeedsYouAssistant,
  type NeedsYouTasks,
} from '@flux/core';
import { notificationRepository } from '../push/adapters.js';
import { aiAllowedInProject } from '../access/ai-gate.js';
import { workRepository, workUseCases } from '../work/adapters.js';

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

/**
 * The task changes of the Inbox's Done and of its Undo (personas-33), each the work use case with all its checks, lines and events. A task
 * changed since the Done is a conflict the Inbox says in its own words.
 */
export function needsYouTasks(db: Database): NeedsYouTasks {
  const work = workUseCases(db);
  const changedSince = (error: unknown) => error instanceof VersionConflictError
    ? new ConflictError('This task changed since. Open it to look again.', 'NEEDS_YOU_TASK_CHANGED') : error;
  return {
    finish: (principal, workId, version) => work.updateWork(principal, workId, { status: 'done' }, version),
    waitDone: (principal, workId, version) => work.resolveWaiting(principal, workId, version),
    async putBack(principal, restore, since) {
      try {
        if (restore.wait) { await work.undoWaitingDone(principal, restore.workId, restore.version, since); return; }
        if (restore.to === 'open') { await work.updateWork(principal, restore.workId, { status: 'open', restore: true }, restore.version); return; }
        const blocker = await work.reasonLeftBlockedWith(principal, restore.workId);
        await work.updateWork(principal, restore.workId, { status: 'blocked', ...(blocker ? { blocker } : {}),
          ...(restore.waitingForUserId ? { waitingFor: { kind: 'human' as const, id: restore.waitingForUserId } } : {}),
          ...(restore.waitingOn ? { waitingOn: restore.waitingOn } : {}), restore: true }, restore.version);
      } catch (error) { throw changedSince(error); }
    },
  };
}

/** The "Needs you" use cases bound to a connection. */
export const needsYouUseCases = (db: Database, assistant?: NeedsYouAssistant) => createNeedsYou({
  access: policyNeedsYouAccess(db),
  tasks: needsYouTasks(db),
  aiAllowed: (projectId) => aiAllowedInProject(db, projectId),
  ...(assistant ? { assistant } : {}),
  repository: needsYouRows(db),
  // The Inbox's rows say who they come from ("Question · Maja · Community garden sensors", #1424).
  inbox: { listReadable: async (userId, limit) => notificationRepository(db).listReadable(userId, limit, { from: true }) },
  level: async (userId) => (await preferenceRepository(notificationPreferenceRows(db)).get(userId)).level,
  work: workRepository(db),
  // The decisions these conversations are the discussions of (#1424), with their titles opened for the reader's Inbox.
  async decisionsDiscussed(conversationIds) {
    const pd = schema.projectDecisions;
    const dd = schema.projectDecisionDiscussions;
    const rows = await openRows(db as unknown as DbExecutor, 'project_decisions', await db.select({ id: pd.id, workspaceId: pd.workspaceId, title: pd.title, conversationId: dd.conversationId })
      .from(dd).innerJoin(pd, eq(pd.id, dd.decisionId)).where(inArray(dd.conversationId, conversationIds)));
    return new Map(rows.map((row) => [row.conversationId, { decisionId: row.id, title: row.title }]));
  },
  // A call is on while it is available and someone is in it: its room is not empty (F-041).
  async runningCalls(sessionIds) {
    const ls = schema.liveSessions;
    const rows = await db.select({ id: ls.id }).from(ls).where(and(inArray(ls.id, sessionIds), eq(ls.state, 'available'), isNull(ls.emptySince)));
    return new Set(rows.map((row) => row.id));
  },
});
