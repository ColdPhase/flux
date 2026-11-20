import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { accessPorts, needsYouRows, notificationPreferenceRows, notificationRows, openRows, returnRows, memberFilter, accessReader, schema, type Database, type DbExecutor } from '@flux/db';
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
import { plainMessageText } from '@flux/contracts';
import { inboxAudience } from '../push/adapters.js';
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
  // Every notification that can be an item, however many ordinary ones are newer (sweep-34 C1), and for `notifying` the person's newest
  // unread ones, however many read ones are newer; the audience is read once for both.
  inbox: {
    async needs(userId, options) {
      const audience = await inboxAudience(db, userId);
      const rows = notificationRows(db);
      return { items: await rows.listNeeds(userId, audience, options), unreadNewest: await rows.unreadNewest(userId, audience, options.newest) };
    },
  },
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
  // How many messages each decision's discussion holds: a discussed decision says so on its card (round 15 look-1 P3-11).
  async discussionReplies(decisionIds) {
    if (!decisionIds.length) return new Map();
    const dd = schema.projectDecisionDiscussions;
    const pm = schema.projectMessages;
    const rows = await db.select({ decisionId: dd.decisionId, replies: sql<number>`count(${pm.id})::int` }).from(dd)
      .innerJoin(pm, and(eq(pm.conversationId, dd.conversationId), isNull(pm.removedAt))).where(inArray(dd.decisionId, decisionIds)).groupBy(dd.decisionId);
    return new Map(rows.filter((row) => row.replies > 0).map((row) => [row.decisionId, Number(row.replies)]));
  },
  // What the person asked, for an Inbox Reply: their own message in the conversation just before the answer. A space whose words are
  // sealed has no words here (an encrypted space's notices say none either), and nothing is read for it.
  async askedBefore(userId, answers) {
    const found = new Map<string, string>();
    const places = answers.flatMap(({ id, url }): { id: string; kind: 'space' | 'dm'; place: string; message: string }[] => {
      const space = /^\/projects\/[0-9a-f-]{36}\/conversations\/([0-9a-f-]{36})#message-([0-9a-f-]{36})$/i.exec(url ?? '');
      if (space) return [{ id, kind: 'space', place: space[1]!.toLowerCase(), message: space[2]!.toLowerCase() }];
      const dm = /^\/dm\/([0-9a-f-]{36})#message-([0-9a-f-]{36})$/i.exec(url ?? '');
      return dm ? [{ id, kind: 'dm', place: dm[1]!.toLowerCase(), message: dm[2]!.toLowerCase() }] : [];
    });
    const read = async (kind: 'space' | 'dm') => {
      const asked = places.filter((place) => place.kind === kind);
      if (!asked.length) return;
      const wanted = sql.join(asked.map((place) => sql`(${place.id}::text, ${place.place}::uuid, ${place.message}::uuid)`), sql`, `);
      const rows = kind === 'space'
        ? await db.execute<{ nid: string; body: string }>(sql`
            SELECT a.nid, m.body FROM (VALUES ${wanted}) AS a(nid, place, message)
            JOIN project_messages r ON r.id = a.message AND r.conversation_id = a.place
            JOIN workspaces w ON w.id = r.workspace_id AND NOT w.encrypted
            JOIN LATERAL (SELECT x.body FROM project_messages x WHERE x.conversation_id = r.conversation_id AND x.author_id = ${userId}
              AND x.sequence < r.sequence AND x.removed_at IS NULL AND x.body <> '' ORDER BY x.sequence DESC LIMIT 1) m ON true`)
        : await db.execute<{ nid: string; body: string }>(sql`
            SELECT a.nid, m.body FROM (VALUES ${wanted}) AS a(nid, place, message)
            JOIN dm_messages r ON r.id = a.message AND r.dm_id = a.place
            JOIN workspaces w ON w.id = r.workspace_id AND NOT w.encrypted
            JOIN LATERAL (SELECT x.body FROM dm_messages x WHERE x.dm_id = r.dm_id AND x.author_id = ${userId} AND x.kind = 'text'
              AND x.sequence < r.sequence AND x.removed_at IS NULL AND x.body <> '' ORDER BY x.sequence DESC LIMIT 1) m ON true`);
      for (const row of rows.rows) found.set(row.nid, plainMessageText(row.body));
    };
    await read('space'); await read('dm');
    return found;
  },
  // A call is on while it is available and someone is in it: its room is not empty (F-041).
  async runningCalls(sessionIds) {
    const ls = schema.liveSessions;
    const rows = await db.select({ id: ls.id }).from(ls).where(and(inArray(ls.id, sessionIds), eq(ls.state, 'available'), isNull(ls.emptySince)));
    return new Set(rows.map((row) => row.id));
  },
});
