import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { companyGuestSql } from './access.js';
import type { DbExecutor } from './push.js';
import { toDecisionRecord } from './work.js';
import { openRows } from '../sealing.js';

/**
 * Drizzle rows for the Inbox "Needs you" queue (#342). They satisfy the `NeedsYouRepository` port of
 * `packages/core/src/needs-you/ports.ts` structurally and make no access decisions: the core use case
 * passes only projects the policy lets the person read, and decides what they may accept.
 */

const s = schema.needsYouStates;
const d = schema.projectDecisions;
const n = schema.notifications;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function needsYouRows(db: DbExecutor) {
  /** Reads these notifications and marks them done, as Done in the Inbox does, so Undo (`restore`) brings them back; returns their Inbox keys. */
  const takeOut = async (userId: string, ids: string[]): Promise<string[]> => {
    if (!ids.length) return [];
    await db.update(n).set({ readAt: sql`now()` }).where(and(eq(n.userId, userId), inArray(n.id, ids), isNull(n.readAt)));
    const done = { state: 'done' as const, until: null, untilWorkId: null };
    await db.insert(s).values(ids.map((id) => ({ userId, itemKey: `note:${id}`, ...done }))).onConflictDoUpdate({
      target: [s.userId, s.itemKey], set: { ...done, updatedAt: sql`now()` },
    });
    return ids.map((id) => `note:${id}`);
  };
  return {
    async states(userId: string) {
      const rows = await db.select().from(s).where(eq(s.userId, userId));
      return rows.map((row) => ({ key: row.itemKey, state: row.state, until: row.until, untilWorkId: row.untilWorkId, updatedAt: row.updatedAt }));
    },

    async putState(userId: string, key: string, value: { state: 'done' | 'declined' | 'snoozed'; until: Date | null; untilWorkId: string | null }) {
      await db.insert(s).values({ userId, itemKey: key, ...value }).onConflictDoUpdate({
        target: [s.userId, s.itemKey], set: { ...value, updatedAt: sql`now()` },
      });
    },

    async deleteStates(userId: string, keys: string[]) {
      if (!keys.length) return;
      await db.delete(s).where(and(eq(s.userId, userId), inArray(s.itemKey, keys)));
    },

    /** Proposed decisions of these projects, newest first. */
    async proposedDecisions(projectIds: string[], limit: number) {
      if (!projectIds.length) return [];
      const rows = await openRows(db, 'project_decisions', await db.select().from(d).where(and(inArray(d.projectId, projectIds), eq(d.status, 'proposed'))).orderBy(desc(d.createdAt)).limit(limit));
      return rows.map(toDecisionRecord);
    },

    /** Open suggestions made by agents this person connected, in these (already readable) projects, newest first (#661). */
    async agentProposals(userId: string, projectIds: string[], limit: number) {
      if (!projectIds.length) return [];
      const p = schema.agentProposals;
      const v = schema.projectMaterialVersions;
      const rows = await db.select({ proposal: p, agentName: schema.agents.name, title: v.title }).from(p)
        .innerJoin(schema.agents, eq(schema.agents.id, p.agentId))
        .innerJoin(v, and(eq(v.materialId, p.sourceMaterialId), eq(v.version, p.sourceMaterialVersion)))
        // A guest of the company has no AI (C-50): what their agents suggested is kept, hidden here, and is back when they are a member again (#1095).
        .where(and(eq(p.ownerUserId, userId), eq(p.status, 'proposed'), inArray(p.projectId, projectIds), sql`NOT ${companyGuestSql(p.ownerUserId)}`))
        .orderBy(desc(p.createdAt)).limit(limit);
      return rows.map((row) => ({
        id: row.proposal.id, projectId: row.proposal.projectId, agentId: row.proposal.agentId, agentName: row.agentName,
        fact: row.proposal.fact, interpretation: row.proposal.interpretation, suggestedAction: row.proposal.suggestedAction,
        source: { materialId: row.proposal.sourceMaterialId, title: row.title, version: row.proposal.sourceMaterialVersion },
        createdAt: row.proposal.createdAt,
      }));
    },

    /** Agent questions asked of this person in these (already readable) projects: open ones, and those answered since `since` (S14, #763). */
    async agentQuestions(userId: string, projectIds: string[], since: Date, limit: number) {
      if (!projectIds.length) return [];
      const q = schema.agentQuestions;
      const rows = await db.select({ q, agentName: schema.agents.name }).from(q)
        .innerJoin(schema.agents, eq(schema.agents.id, q.agentId))
        .where(and(eq(q.askedUserId, userId), inArray(q.projectId, projectIds), or(isNull(q.answeredAt), gte(q.createdAt, since))))
        .orderBy(desc(q.createdAt), desc(q.id)).limit(limit);
      return rows.map(({ q: row, agentName }) => ({
        id: row.id, projectId: row.projectId, conversationId: row.conversationId, messageId: row.messageId, taskId: row.taskId,
        agent: { id: row.agentId, name: agentName }, question: row.question, options: row.options, createdAt: row.createdAt, answered: row.answeredAt !== null,
      }));
    },

    /**
     * A reply of the person in a conversation answers what they were asked or mentioned in there (#1170): their unread question and
     * mention notifications that open a message of this conversation are read and marked done, as Done in the Inbox does, so Undo
     * (`restore`) brings them back. An agent's question card is answered with its own answers and stays. Returns the Inbox keys it took out.
     */
    async answerIn(userId: string, projectId: string, conversationId: string): Promise<string[]> {
      const at = `/projects/${projectId.toLowerCase()}/conversations/${conversationId.toLowerCase()}#message-`;
      const rows = await db.select({ id: n.id, url: n.url }).from(n).where(and(eq(n.userId, userId), isNull(n.readAt), inArray(n.reason, ['question', 'mention']),
        eq(n.sourceType, 'project'), eq(n.sourceId, projectId), sql`starts_with(lower(${n.url}), ${at})`));
      if (!rows.length) return [];
      const messageOf = (url: string | null) => (url ?? '').slice(at.length).toLowerCase();
      const messages = [...new Set(rows.map((row) => messageOf(row.url)).filter((id) => UUID.test(id)))];
      const q = schema.agentQuestions;
      const cards = new Set(messages.length ? (await db.select({ messageId: q.messageId }).from(q)
        .where(and(eq(q.askedUserId, userId), inArray(q.messageId, messages)))).map((row) => row.messageId.toLowerCase()) : []);
      return takeOut(userId, rows.filter((row) => !cards.has(messageOf(row.url))).map((row) => row.id));
    },

    /**
     * A task the person makes from a message answers what that message asked or mentioned of them (personas-28): their unread question and
     * mention notifications of exactly those messages are read and marked done, as a reply in the conversation takes them. An agent's
     * question card is answered with its own answers and stays. Returns the Inbox keys it took out.
     */
    async answerWithTask(userId: string, projectId: string, messageIds: string[]): Promise<string[]> {
      const ids = [...new Set(messageIds.map((id) => id.toLowerCase()).filter((id) => UUID.test(id)))];
      if (!ids.length) return [];
      const q = schema.agentQuestions;
      const cards = new Set((await db.select({ messageId: q.messageId }).from(q).where(and(eq(q.askedUserId, userId), inArray(q.messageId, ids))))
        .map((row) => row.messageId.toLowerCase()));
      const open = ids.filter((id) => !cards.has(id));
      if (!open.length) return [];
      const rows = await db.select({ id: n.id }).from(n).where(and(eq(n.userId, userId), isNull(n.readAt), inArray(n.reason, ['question', 'mention']),
        eq(n.sourceType, 'project'), eq(n.sourceId, projectId), sql`starts_with(lower(${n.url}), ${`/projects/${projectId.toLowerCase()}/conversations/`})`,
        inArray(sql`lower(split_part(${n.url}, '#message-', 2))`, open)));
      return takeOut(userId, rows.map((row) => row.id));
    },

    /**
     * The same for a direct message (#1249): a message that names someone is a mention or a question there, as in a space thread, so the
     * person's reply in that conversation answers their unread ones, read and done as Done takes them. A DM has no agent question cards.
     */
    async answerInDm(userId: string, dmId: string): Promise<string[]> {
      const at = `/dm/${dmId.toLowerCase()}#message-`;
      const rows = await db.select({ id: n.id }).from(n).where(and(eq(n.userId, userId), isNull(n.readAt), inArray(n.reason, ['question', 'mention']),
        eq(n.sourceType, 'dm'), eq(n.sourceId, dmId), sql`starts_with(lower(${n.url}), ${at})`));
      return takeOut(userId, rows.map((row) => row.id));
    },

    /** Whether the person's own notification exists; read or unread is set on it. */
    async setNotificationRead(userId: string, id: string, read: boolean) {
      const rows = await db.update(n).set({ readAt: read ? sql`coalesce(${n.readAt}, now())` : null })
        .where(and(eq(n.userId, userId), eq(n.id, id))).returning({ id: n.id });
      return rows.length > 0;
    },

    /**
     * The people in the space, by name: candidates only; the policy decides who may act. They are the ones its decisions are asked of (their
     * Inbox lists the spaces they are in, `memberFilter`): everyone but a guest in a space for the whole company, else the people added to it.
     * A company admin outside a closed space is not asked, so "… can accept too" never names them (personas-27).
     */
    async workspaceMembersOfProject(projectId: string, limit: number) {
      const m = schema.workspaceMembers;
      const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.projects)
        .innerJoin(m, eq(m.workspaceId, schema.projects.workspaceId))
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, m.userId))
        .where(and(eq(schema.projects.id, projectId), or(and(eq(schema.projects.visibility, 'workspace'), sql`${m.role} <> 'guest'`),
          sql`EXISTS (SELECT 1 FROM project_grants g WHERE g.project_id = ${schema.projects.id} AND g.user_id = ${m.userId})`)))
        .orderBy(schema.authUsers.name).limit(limit);
      return rows;
    },

    /** Statuses of tasks by id, for "when it is done" snoozes. */
    async workStatuses(ids: string[]) {
      if (!ids.length) return new Map<string, string>();
      const rows = await db.select({ id: schema.projectWorkItems.id, status: schema.projectWorkItems.status }).from(schema.projectWorkItems)
        .where(inArray(schema.projectWorkItems.id, ids));
      return new Map(rows.map((row) => [row.id, row.status as string]));
    },
  };
}
