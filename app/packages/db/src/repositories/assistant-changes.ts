import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
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
  /** What started the run: the owner's request or one of their stored schedules or reactions (limits differ: 20 and 10). */
  authority: 'owner_request' | 'owner_schedule' | 'owner_reaction';
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
        completedAt: r.completedAt, authority: r.authority }).from(r).where(eq(r.id, runId)).for('update');
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
      const [row] = await db.select({ status: e.status, createdAt: e.createdAt, payer: e.consentPayerOrganization }).from(e).where(eq(e.ownerUserId, ownerUserId)).for('share');
      return row ?? null;
    },
    async byCommand(runId: string, clientCommandId: string): Promise<AssistantChangeRow | null> {
      const [row] = await db.select().from(c).where(and(eq(c.runId, runId), eq(c.clientCommandId, clientCommandId)));
      return row ?? null;
    },
    /** The size the `prepared_command` CHECK measures: the jsonb value's text. */
    async preparedBytes(command: unknown): Promise<number> {
      const row = await first<{ bytes: number }>(db, sql`SELECT octet_length((${JSON.stringify(command)}::jsonb)::text) AS bytes`);
      return Number(row?.bytes ?? Number.MAX_SAFE_INTEGER);
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
    /** The owner's latest changes across conversations, newest first (the assistant screen's Recent). */
    async recent(ownerUserId: string, limit: number): Promise<(AssistantChangeRow & { conversationId: string })[]> {
      const r = schema.personalRuns;
      const rows = await db.select({ change: c, conversationId: r.conversationId }).from(c).innerJoin(r, eq(r.id, c.runId))
        .where(eq(c.ownerUserId, ownerUserId)).orderBy(desc(c.createdAt), desc(c.id)).limit(limit);
      return rows.map((row) => ({ ...row.change, conversationId: row.conversationId }));
    },
    /** Every change of one conversation's runs, whoever owns them: the use case shows each viewer only what is theirs to see. */
    async forConversationAll(conversationId: string): Promise<(AssistantChangeRow & { conversationId: string })[]> {
      const r = schema.personalRuns;
      const rows = await db.select({ change: c, conversationId: r.conversationId }).from(c).innerJoin(r, eq(r.id, c.runId))
        .where(eq(r.conversationId, conversationId)).orderBy(asc(c.createdAt), asc(c.id)).limit(500);
      return rows.map((row) => ({ ...row.change, conversationId: row.conversationId }));
    },
    /** The project a conversation belongs to, for the read check before its message is shown. */
    async conversationPlace(conversationId: string): Promise<{ projectId: string; workspaceId: string } | null> {
      const [row] = await db.select({ projectId: schema.projectConversations.projectId, workspaceId: schema.projectConversations.workspaceId })
        .from(schema.projectConversations).where(eq(schema.projectConversations.id, conversationId));
      return row ?? null;
    },
    /** The people whose assistant is working in a conversation right now (reading or dispatching), by name: nothing else about the run. */
    async workingOwners(conversationId: string): Promise<{ ownerId: string; ownerName: string }[]> {
      const r = schema.personalRuns;
      const rows = await db.selectDistinct({ ownerId: r.ownerUserId, ownerName: schema.authUsers.name }).from(r)
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, r.ownerUserId))
        .where(and(eq(r.conversationId, conversationId), inArray(r.status, ['reading', 'dispatching']), sql`${r.stopRequestedAt} IS NULL`))
        .orderBy(asc(schema.authUsers.name));
      return rows;
    },
    /** What started each run: the owner's request, or a schedule or reaction of the owner (their limits differ). */
    async runAuthorities(runIds: string[]): Promise<Map<string, string>> {
      if (!runIds.length) return new Map();
      const r = schema.personalRuns;
      const rows = await db.select({ id: r.id, authority: r.authority }).from(r).where(inArray(r.id, runIds));
      return new Map(rows.map((row) => [row.id, row.authority]));
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
    /** A task with what Undo compares: done-when, who it waits for and its prerequisites (ascending). */
    async work(id: string) {
      const w = schema.projectWorkItems;
      const [row] = await db.select({ id: w.id, projectId: w.projectId, number: w.number, title: w.title, outcome: w.outcome, status: w.status,
        blocker: w.blocker, version: w.version, ownerUserId: w.ownerUserId, criteria: w.criteria, waitingForUserId: w.waitingForUserId,
        ownerAgentId: w.ownerAgentId, createdByKind: w.createdByKind, createdById: w.createdById }).from(w).where(eq(w.id, id));
      if (!row) return null;
      const d = schema.projectTaskDependencies;
      const dependencies = await db.select({ id: d.prerequisiteId }).from(d).where(and(eq(d.projectId, row.projectId), eq(d.taskId, id))).orderBy(asc(d.prerequisiteId));
      return { ...row, dependencyIds: dependencies.map((item) => item.id) };
    },
    async doc(id: string) {
      return first<{ id: string; projectId: string; title: string; body: string; state: 'draft' | 'published' | null; version: number; userId: string | null; agentId: string | null }>(db, sql`
        SELECT m.id, m.project_id AS "projectId", v.title, v.body, v.state, m.current_version AS version, m.created_by AS "userId", m.created_by_agent_id AS "agentId"
        FROM project_materials m JOIN project_material_versions v ON v.material_id = m.id AND v.version = m.current_version
        WHERE m.id = ${id} AND m.kind = 'doc'`);
    },
    /** One version of a page, to restore the earlier text as a new version (A4 Undo). */
    async docVersion(id: string, version: number) {
      return first<{ title: string; body: string; state: 'draft' | 'published' | null }>(db, sql`
        SELECT title, body, state FROM project_material_versions WHERE material_id = ${id} AND version = ${version}`);
    },
    /** How each run stands: working, ended, or stopped by its owner (the message header, A4). */
    async runStates(runIds: string[]): Promise<Map<string, { status: string; stopRequestedAt: Date | null }>> {
      if (!runIds.length) return new Map();
      const r = schema.personalRuns;
      const rows = await db.select({ id: r.id, status: r.status, stopRequestedAt: r.stopRequestedAt }).from(r).where(inArray(r.id, runIds));
      return new Map(rows.map((row) => [row.id, { status: row.status, stopRequestedAt: row.stopRequestedAt }]));
    },
    async map(id: string) {
      return first<{ id: string; title: string; version: number; userId: string | null; agentId: string | null }>(db, sql`
        SELECT id, title, version, created_by_user_id AS "userId", created_by_agent_id AS "agentId" FROM sketches WHERE id = ${id}`);
    },
    async thoughts(ids: string[]): Promise<{ id: string; sketchId: string; text: string; x: number; y: number; version: number; userId: string | null; agentId: string | null }[]> {
      if (!ids.length) return [];
      const t = schema.sketchThoughts;
      return db.select({ id: t.id, sketchId: t.sketchId, text: t.text, x: t.x, y: t.y, version: t.version, userId: t.createdByUserId, agentId: t.createdByAgentId }).from(t).where(inArray(t.id, ids));
    },
    async link(id: string): Promise<(ObjectMaker & { sketchId: string }) | null> {
      return first<ObjectMaker & { sketchId: string }>(db, sql`SELECT sketch_id AS "sketchId", created_by_user_id AS "userId", created_by_agent_id AS "agentId" FROM sketch_links WHERE id = ${id}`);
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
    /** Where each hand-off unit stands (state and how often it was claimed), for the row of the run's message. */
    async unitStates(ids: string[]): Promise<Map<string, { state: string; generation: number }>> {
      if (!ids.length) return new Map();
      const u = schema.coworkUnits;
      const rows = await db.select({ id: u.id, state: u.state, generation: u.generation }).from(u).where(inArray(u.id, ids));
      return new Map(rows.map((row) => [row.id, { state: row.state, generation: row.generation }]));
    },
    /** An agent connection, as a hand-off recipient: whose it is, what it is called to its owner and whether it works in the project. */
    async connection(id: string, projectId: string | null) {
      const k = schema.agentConnections;
      const [row] = await db.select({ id: k.id, ownerUserId: k.ownerUserId, computeSource: k.computeSource, revokedAt: k.revokedAt, name: k.name,
        clientDesignation: k.clientDesignation, scopes: k.scopes }).from(k).where(eq(k.id, id));
      if (!row) return null;
      const [selected] = projectId ? await db.select({ projectId: schema.agentConnectionProjects.projectId }).from(schema.agentConnectionProjects)
        .where(and(eq(schema.agentConnectionProjects.connectionId, id), eq(schema.agentConnectionProjects.projectId, projectId))) : [];
      const label = row.clientDesignation === 'codex' ? 'Codex' : row.clientDesignation === 'claude_code' ? 'Claude Code' : row.name;
      return { ...row, label, selected: !!selected && row.scopes.includes('flux.action.execute') };
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
