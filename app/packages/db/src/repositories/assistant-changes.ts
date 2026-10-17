import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Rows of the assistant's change log (migration 0104, F-027 A3 #403) and the few facts its classification
 * reads: the run, the owner's settings and enablement, who made a target object, a live Wiki typist and who
 * last changed an object. These rows make no access decision; the server's executor does.
 */

const c = schema.assistantChanges;
export type AssistantChangeRow = typeof c.$inferSelect;
export type NewAssistantChangeRow = typeof c.$inferInsert;

export interface AssistantRunRow {
  id: string; workspaceId: string; projectId: string; conversationId: string; ownerUserId: string; agentId: string;
  status: string; stopRequestedAt: Date | null; engine: 'server' | 'runtime'; completedAt: Date | null;
}
/** Who made an object: a person or an agent; both null when unknown. */
export interface ObjectMaker { userId: string | null; agentId: string | null }

const first = async <T>(db: DbExecutor, query: ReturnType<typeof sql>) => ((await db.execute(query)).rows[0] as T | undefined) ?? null;

export function assistantChangeRows(db: DbExecutor) {
  return {
    /** The run row, held for this transaction: change counting and the run's state are decided under it. */
    async lockRun(runId: string): Promise<AssistantRunRow | null> {
      const r = schema.personalRuns;
      const [row] = await db.select({ id: r.id, workspaceId: r.workspaceId, projectId: r.projectId, conversationId: r.conversationId,
        ownerUserId: r.ownerUserId, agentId: r.agentId, status: r.status, stopRequestedAt: r.stopRequestedAt, engine: r.engine,
        completedAt: r.completedAt }).from(r).where(eq(r.id, runId)).for('update');
      return row ?? null;
    },
    async settings(ownerUserId: string, workspaceId: string) {
      const s = schema.assistantSettings;
      const [row] = await db.select({ approvalMode: s.approvalMode, changesPerRun: s.changesPerRun, connectionId: s.connectionId, agentId: s.agentId })
        .from(s).where(and(eq(s.ownerUserId, ownerUserId), eq(s.workspaceId, workspaceId))).for('share');
      return row ?? null;
    },
    async enablement(ownerUserId: string) {
      const e = schema.personalRunEnablements;
      const [row] = await db.select({ status: e.status, createdAt: e.createdAt }).from(e).where(eq(e.ownerUserId, ownerUserId)).for('share');
      return row ?? null;
    },
    async byCommand(runId: string, clientCommandId: string): Promise<AssistantChangeRow | null> {
      const [row] = await db.select().from(c).where(and(eq(c.runId, runId), eq(c.clientCommandId, clientCommandId)));
      return row ?? null;
    },
    async lock(id: string): Promise<AssistantChangeRow | null> {
      const [row] = await db.select().from(c).where(eq(c.id, id)).for('update');
      return row ?? null;
    },
    async find(id: string): Promise<AssistantChangeRow | null> {
      const [row] = await db.select().from(c).where(eq(c.id, id));
      return row ?? null;
    },
    async insert(row: NewAssistantChangeRow): Promise<AssistantChangeRow> {
      const [inserted] = await db.insert(c).values(row).returning();
      return inserted!;
    },
    /** Every decision bumps the row's version, so a stale Apply or Not now is a version conflict. */
    async update(id: string, patch: Partial<NewAssistantChangeRow>): Promise<AssistantChangeRow> {
      const [updated] = await db.update(c).set({ ...patch, version: sql`${c.version} + 1`, updatedAt: new Date() }).where(eq(c.id, id)).returning();
      return updated!;
    },
    /** Automatic changes the run has used: applied at once, or reserved by a live-Wiki deferral (AST-5 case 5). */
    async reserved(runId: string): Promise<number> {
      const row = await first<{ count: string }>(db, sql`SELECT count(*)::text AS count FROM assistant_changes WHERE run_id = ${runId}
        AND (state = 'applied' OR (state = 'waiting' AND wait_reason = 'live_wiki') OR authority = 'owner_deferred_change')`);
      return Number(row?.count ?? 0);
    },
    async forRun(runId: string): Promise<AssistantChangeRow[]> {
      return db.select().from(c).where(eq(c.runId, runId)).orderBy(asc(c.createdAt), asc(c.id));
    },
    async forConversation(ownerUserId: string, conversationId: string): Promise<(AssistantChangeRow & { conversationId: string })[]> {
      const r = schema.personalRuns;
      const rows = await db.select({ change: c, conversationId: r.conversationId }).from(c).innerJoin(r, eq(r.id, c.runId))
        .where(and(eq(c.ownerUserId, ownerUserId), eq(r.conversationId, conversationId))).orderBy(asc(c.createdAt), asc(c.id)).limit(500);
      return rows.map((row) => ({ ...row.change, conversationId: row.conversationId }));
    },
    async conversationOf(runId: string): Promise<string | null> {
      const [row] = await db.select({ id: schema.personalRuns.conversationId }).from(schema.personalRuns).where(eq(schema.personalRuns.id, runId));
      return row?.id ?? null;
    },
    /** A waiting change past its seven days becomes expired; its deadline is never extended. */
    async expire(now: Date, ownerUserId?: string): Promise<number> {
      const rows = await db.update(c).set({ state: 'expired', waitReason: null, version: sql`${c.version} + 1`, updatedAt: now })
        .where(and(eq(c.state, 'waiting'), sql`${c.expiresAt} <= ${now}`, ...(ownerUserId ? [eq(c.ownerUserId, ownerUserId)] : []))).returning({ id: c.id });
      return rows.length;
    },
    /** Live-Wiki deferrals to recheck, oldest first. */
    async deferred(limit: number): Promise<AssistantChangeRow[]> {
      return db.select().from(c).where(and(eq(c.state, 'waiting'), eq(c.waitReason, 'live_wiki'))).orderBy(asc(c.createdAt)).limit(limit);
    },
    /** The owner's undecided waiting changes that belong in Inbox now: promoted, or ten minutes past the run's end. */
    async inbox(ownerUserId: string, now: Date, afterMinutes: number): Promise<(AssistantChangeRow & { conversationId: string; completedAt: Date | null })[]> {
      const r = schema.personalRuns;
      const rows = await db.select({ change: c, conversationId: r.conversationId, completedAt: r.completedAt }).from(c).innerJoin(r, eq(r.id, c.runId))
        .where(and(eq(c.ownerUserId, ownerUserId), eq(c.state, 'waiting'), sql`${c.waitReason} <> 'live_wiki'`, sql`${c.sentAt} IS NULL`,
          sql`${c.expiresAt} > ${now}`,
          sql`(${c.inboxAt} <= ${now} OR ${r.completedAt} + make_interval(mins => ${afterMinutes}) <= ${now})`))
        .orderBy(asc(c.createdAt), asc(c.id)).limit(500);
      return rows.map((row) => ({ ...row.change, conversationId: row.conversationId, completedAt: row.completedAt }));
    },
    async promote(runId: string, now: Date): Promise<number> {
      const rows = await db.update(c).set({ inboxAt: now }).where(and(eq(c.runId, runId), eq(c.state, 'waiting'), sql`${c.inboxAt} IS NULL`)).returning({ id: c.id });
      return rows.length;
    },
    /** Another person's open live session on a page (F-021 presence): the typist, or null. */
    async liveTypist(docId: string, exceptUserId: string): Promise<{ id: string; name: string } | null> {
      return first<{ id: string; name: string }>(db, sql`SELECT u.id, u.name FROM doc_live_presence p JOIN auth_users u ON u.id = p.actor_id
        WHERE p.doc_id = ${docId} AND p.actor_id <> ${exceptUserId} AND p.expires_at > now() ORDER BY p.expires_at DESC LIMIT 1`);
    },
    async work(id: string) {
      const w = schema.projectWorkItems;
      const [row] = await db.select({ id: w.id, projectId: w.projectId, number: w.number, title: w.title, version: w.version, ownerUserId: w.ownerUserId,
        ownerAgentId: w.ownerAgentId, createdByKind: w.createdByKind, createdById: w.createdById }).from(w).where(eq(w.id, id));
      return row ?? null;
    },
    async doc(id: string) {
      return first<{ id: string; projectId: string; title: string; version: number; userId: string | null; agentId: string | null }>(db, sql`
        SELECT m.id, m.project_id AS "projectId", v.title, m.current_version AS version, m.created_by AS "userId", m.created_by_agent_id AS "agentId"
        FROM project_materials m JOIN project_material_versions v ON v.material_id = m.id AND v.version = m.current_version
        WHERE m.id = ${id} AND m.kind = 'doc'`);
    },
    async map(id: string) {
      return first<{ id: string; title: string; version: number; userId: string | null; agentId: string | null }>(db, sql`
        SELECT id, title, version, created_by_user_id AS "userId", created_by_agent_id AS "agentId" FROM sketches WHERE id = ${id}`);
    },
    async thoughts(ids: string[]): Promise<{ id: string; text: string; version: number; userId: string | null; agentId: string | null }[]> {
      if (!ids.length) return [];
      const t = schema.sketchThoughts;
      return db.select({ id: t.id, text: t.text, version: t.version, userId: t.createdByUserId, agentId: t.createdByAgentId }).from(t).where(inArray(t.id, ids));
    },
    async link(id: string): Promise<ObjectMaker | null> {
      return first<ObjectMaker>(db, sql`SELECT created_by_user_id AS "userId", created_by_agent_id AS "agentId" FROM sketch_links WHERE id = ${id}`);
    },
    /** Who last changed an object: a page's current version author, otherwise the latest event about it (a day back at most). */
    async lastActor(objectId: string): Promise<{ id: string; name: string } | null> {
      const author = await first<{ id: string; name: string }>(db, sql`SELECT COALESCE(u.id, a.id::text) AS id, COALESCE(u.name, a.name) AS name
        FROM project_materials m JOIN project_material_versions v ON v.material_id = m.id AND v.version = m.current_version
        LEFT JOIN auth_users u ON u.id = v.author_id LEFT JOIN agents a ON a.id = v.author_agent_id WHERE m.id = ${objectId}`);
      if (author?.name) return author;
      return first<{ id: string; name: string }>(db, sql`SELECT split_part(e.actor_id, ':', 2) AS id, COALESCE(u.name, a.name) AS name FROM events e
        LEFT JOIN auth_users u ON e.actor_id = 'human:' || u.id LEFT JOIN agents a ON e.actor_id = 'agent:' || a.id::text
        WHERE e.created_at > now() - interval '1 day' AND (e.object_id = ${objectId} OR e.data->>'workId' = ${objectId}::text OR e.data->>'docId' = ${objectId}::text
          OR e.data->>'thoughtId' = ${objectId}::text) AND COALESCE(u.name, a.name) IS NOT NULL ORDER BY e.seq DESC LIMIT 1`);
    },
    /** A page is yours only while every version of it is by you or your assistant ("Yours", F-027 Terms). */
    async docEditedByOthers(docId: string, ownerUserId: string, agentId: string): Promise<boolean> {
      const row = await first<{ others: boolean }>(db, sql`SELECT EXISTS (SELECT 1 FROM project_material_versions WHERE material_id = ${docId}
        AND NOT (author_id IS NOT DISTINCT FROM ${ownerUserId} AND author_agent_id IS NULL) AND NOT (author_agent_id IS NOT DISTINCT FROM ${agentId}::uuid)) AS others`);
      return !!row?.others;
    },
    /**
     * Turning a switch off or narrowing the projects invalidates the affected waiting changes in the same transaction
     * (F-027 R1): turning it on again never resurrects them.
     */
    async invalidateOutside(ownerUserId: string, workspaceId: string, stillAllowed: (tool: string, projectId: string) => boolean): Promise<number> {
      const waiting = await db.select({ id: c.id, tool: c.tool, projectId: c.projectId }).from(c)
        .where(and(eq(c.ownerUserId, ownerUserId), eq(c.workspaceId, workspaceId), eq(c.state, 'waiting'))).for('update');
      const affected = waiting.filter((row) => !stillAllowed(row.tool, row.projectId)).map((row) => row.id);
      if (affected.length) await db.update(c).set({ state: 'refused', waitReason: null, refusal: 'Your assistant\'s switches changed since. Ask again',
        version: sql`${c.version} + 1`, updatedAt: new Date() }).where(inArray(c.id, affected));
      return affected.length;
    },
    async names(ids: string[]): Promise<Map<string, string>> {
      const unique = [...new Set(ids.filter(Boolean))];
      if (!unique.length) return new Map();
      const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, unique));
      return new Map(rows.map((row) => [row.id, row.name]));
    },
    async markQuestion(notificationId: string): Promise<void> {
      await db.update(schema.notifications).set({ reason: 'question' }).where(eq(schema.notifications.id, notificationId));
    },
  };
}
export type AssistantChangeRows = ReturnType<typeof assistantChangeRows>;
