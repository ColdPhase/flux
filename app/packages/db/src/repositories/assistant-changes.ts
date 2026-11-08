import { AI_PROVIDERS } from '@flux/contracts';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import { connectionReaches } from './agent-reach.js';
import type { DbExecutor } from './push.js';

/**
 * Rows of the agent change log (migration 0104, F-027 A3 #403; F-036 #855) and the few facts its classification
 * reads: the run, the agent's "What it may do" and the owner's enablement, who made a target object and who last
 * changed an object. These rows make no access decision; the server's executor does.
 */

const c = schema.assistantChanges;
export type AssistantChangeRow = typeof c.$inferSelect;
export type NewAssistantChangeRow = typeof c.$inferInsert;
/**
 * What Approve all, Skip all and Undo act on (#859). A run's changes are one group. A local client has no run: what waits for its owner
 * is one group per client (one Inbox item, "Approve all"), and what it did is one group per change, so an Undo takes back that change
 * and never the client's earlier work.
 */
export const changeGroup = (row: Pick<AssistantChangeRow, 'id' | 'runId' | 'connectionId' | 'state'>): string =>
  row.runId ?? (row.state === 'waiting' ? row.connectionId! : row.id);
/** A change as the owner's views read it: with the conversation it shows in and the name of its agent. */
export type AssistantChangeInView = AssistantChangeRow & { conversationId: string; agentName: string };

export interface AssistantRunRow {
  id: string; workspaceId: string; projectId: string | null; conversationId: string | null; ownerUserId: string; agentId: string;
  status: string; stopRequestedAt: Date | null; engine: 'server' | 'runtime'; completedAt: Date | null;
  /** What started the run: the owner's request or one of their stored schedules. */
  authority: 'owner_request' | 'owner_schedule';
}
/** Who made an object: a person or an agent; both null when unknown. */
export interface ObjectMaker { userId: string | null; agentId: string | null }

const first = async <T>(db: DbExecutor, query: ReturnType<typeof sql>) => ((await db.execute(query)).rows[0] as T | undefined) ?? null;

export function assistantChangeRows(db: DbExecutor) {
  /** A change with its run's conversation (or the one a client's message went to) and its agent's name; the runs it joins may be absent. */
  const viewRows = async (where: ReturnType<typeof and>): Promise<AssistantChangeInView[]> => {
    const r = schema.personalRuns; const k = schema.agentConnections;
    const rows = await db.select({ change: c, conversationId: sql<string | null>`COALESCE(${r.conversationId}, ${c.conversationId})`, clientName: k.name })
      .from(c).leftJoin(r, eq(r.id, c.runId)).leftJoin(k, eq(k.id, c.connectionId)).where(where).orderBy(asc(c.createdAt), asc(c.id)).limit(500);
    return rows.map((row) => ({ ...row.change, conversationId: row.conversationId ?? '', agentName: row.clientName ?? 'Assistant' }));
  };
  const conversationMatch = (conversationId: string) =>
    sql`(${c.conversationId} = ${conversationId} OR ${c.runId} IN (SELECT id FROM personal_runs WHERE conversation_id = ${conversationId}))`;
  return {
    /** The run row, held for this transaction: change counting and the run's state are decided under it. */
    async lockRun(runId: string): Promise<AssistantRunRow | null> {
      const r = schema.personalRuns;
      const [row] = await db.select({ id: r.id, workspaceId: r.workspaceId, projectId: r.projectId, conversationId: r.conversationId,
        ownerUserId: r.ownerUserId, agentId: r.agentId, status: r.status, stopRequestedAt: r.stopRequestedAt, engine: r.engine,
        completedAt: r.completedAt, authority: r.authority }).from(r).where(eq(r.id, runId)).for('update');
      return row ?? null;
    },
    /** Who owns a run, whether or not it made changes: the asker's own view of a run with none (#842). */
    async runOwner(runId: string): Promise<string | null> {
      const [row] = await db.select({ ownerUserId: schema.personalRuns.ownerUserId }).from(schema.personalRuns).where(eq(schema.personalRuns.id, runId));
      return row?.ownerUserId ?? null;
    },
    /** A local client's connection with its "What it may do", held `FOR SHARE` like the assistant's, so a concurrent change of it waits (#859). */
    async lockClient(connectionId: string) {
      const k = schema.agentConnections;
      const [row] = await db.select({ id: k.id, ownerUserId: k.ownerUserId, workspaceId: k.workspaceId, agentId: k.agentId, mayDo: k.mayDo, revokedAt: k.revokedAt,
        computeSource: k.computeSource, name: k.name }).from(k).where(eq(k.id, connectionId)).for('share');
      return row ?? null;
    },
    /** The agent and its "What it may do" (F-036 AG-3), read with the connection row `FOR SHARE`, so a concurrent change of it waits. A deleted agent has none. */
    async settings(ownerUserId: string, agentId: string) {
      const s = schema.assistantSettings; const k = schema.agentConnections;
      const [row] = await db.select({ mayDo: k.mayDo, connectionId: s.connectionId, agentId: s.agentId })
        .from(s).innerJoin(k, eq(k.id, s.connectionId)).innerJoin(schema.agents, eq(schema.agents.id, s.agentId))
        .where(and(eq(s.ownerUserId, ownerUserId), eq(s.agentId, agentId), isNull(schema.agents.revokedAt))).for('share', { of: [s, k] });
      return row ?? null;
    },
    async enablement(ownerUserId: string, agentId: string) {
      const e = schema.assistantSettings;
      const [row] = await db.select({ createdAt: e.createdAt, engine: e.engine, provider: e.provider }).from(e)
        .innerJoin(schema.agents, eq(schema.agents.id, e.agentId))
        .where(and(eq(e.ownerUserId, ownerUserId), eq(e.agentId, agentId), isNull(schema.agents.revokedAt))).for('share', { of: e });
      if (!row) return null;
      // Who pays, as the change's receipt names it (#854): the plan of the CLI, or the API key's provider account.
      const payer = row.engine === 'runtime' ? (row.provider === 'openai' ? 'ChatGPT plan' : 'Claude plan') : `${AI_PROVIDERS[row.provider].label} API key`;
      return { createdAt: row.createdAt, payer };
    },
    async byCommand(runId: string, clientCommandId: string): Promise<AssistantChangeRow | null> {
      const [row] = await db.select().from(c).where(and(eq(c.runId, runId), eq(c.clientCommandId, clientCommandId)));
      return row ?? null;
    },
    async byConnectionCommand(connectionId: string, clientCommandId: string): Promise<AssistantChangeRow | null> {
      const [row] = await db.select().from(c).where(and(eq(c.connectionId, connectionId), eq(c.clientCommandId, clientCommandId)));
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
    /** Every decision bumps the row's version, so a stale Approve or Skip is a version conflict. */
    async update(id: string, patch: Partial<NewAssistantChangeRow>): Promise<AssistantChangeRow> {
      const [updated] = await db.update(c).set({ ...patch, version: sql`${c.version} + 1`, updatedAt: new Date() }).where(eq(c.id, id)).returning();
      return updated!;
    },
    /** Every change of one group (see `changeGroup`). */
    async forRun(groupId: string): Promise<AssistantChangeInView[]> {
      return viewRows(or(eq(c.runId, groupId), and(eq(c.connectionId, groupId), eq(c.state, 'waiting')), and(eq(c.id, groupId), sql`${c.runId} IS NULL`)));
    },
    /** One change as the owner's views read it. */
    async findInView(id: string): Promise<AssistantChangeInView | null> {
      return (await viewRows(eq(c.id, id)))[0] ?? null;
    },
    /** The owner's changes of one conversation: those of its runs, and a local client's own messages there. */
    async forConversation(ownerUserId: string, conversationId: string): Promise<AssistantChangeInView[]> {
      return viewRows(and(eq(c.ownerUserId, ownerUserId), conversationMatch(conversationId)));
    },
    /** Every change of one conversation's runs, whoever owns them: the use case shows each viewer only what is theirs to see. */
    async forConversationAll(conversationId: string): Promise<AssistantChangeInView[]> {
      return viewRows(conversationMatch(conversationId));
    },
    /** The project a conversation belongs to, for the read check before its message is shown. */
    async conversationPlace(conversationId: string): Promise<{ projectId: string; workspaceId: string } | null> {
      const [row] = await db.select({ projectId: schema.projectConversations.projectId, workspaceId: schema.projectConversations.workspaceId })
        .from(schema.projectConversations).where(eq(schema.projectConversations.id, conversationId));
      return row ?? null;
    },
    /** The conversation a group shows in: its run's, or none for a local client's group. */
    async conversationOf(groupId: string): Promise<string | null> {
      const [row] = await db.select({ id: schema.personalRuns.conversationId }).from(schema.personalRuns).where(eq(schema.personalRuns.id, groupId));
      return row?.id ?? null;
    },
    /** The owner's waiting changes, oldest first: the Inbox shows one item per run or per local client (F-036 AG-7), as soon as something waits. */
    async inbox(ownerUserId: string): Promise<AssistantChangeInView[]> {
      return viewRows(and(eq(c.ownerUserId, ownerUserId), eq(c.state, 'waiting')));
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
      return first<{ id: string; projectId: string; title: string; body: string; version: number; userId: string | null; agentId: string | null }>(db, sql`
        SELECT m.id, m.project_id AS "projectId", v.title, v.body, m.current_version AS version, m.created_by AS "userId", m.created_by_agent_id AS "agentId"
        FROM project_materials m JOIN project_material_versions v ON v.material_id = m.id AND v.version = m.current_version
        WHERE m.id = ${id} AND m.kind = 'doc'`);
    },
    /** One version of a page, to restore the earlier text as a new version (A4 Undo). */
    async docVersion(id: string, version: number) {
      return first<{ title: string; body: string }>(db, sql`
        SELECT title, body FROM project_material_versions WHERE material_id = ${id} AND version = ${version}`);
    },
    /** How each run stands: working, ended, or stopped by its owner (the message header, A4). */
    async runStates(runIds: string[]): Promise<Map<string, { status: string; stopRequestedAt: Date | null }>> {
      if (!runIds.length) return new Map();
      const r = schema.personalRuns;
      const rows = await db.select({ id: r.id, status: r.status, stopRequestedAt: r.stopRequestedAt }).from(r).where(inArray(r.id, runIds));
      return new Map(rows.map((row) => [row.id, { status: row.status, stopRequestedAt: row.stopRequestedAt }]));
    },
    async lockedMapSnapshot(id: string): Promise<string | null> {
      const row = await first<{ snapshot: string }>(db, sql`SELECT (version::text || ':' || updated_at::text) AS snapshot FROM sketches WHERE id=${id} FOR UPDATE`);
      return row?.snapshot ?? null;
    },
    async map(id: string) {
      return first<{ id: string; title: string; version: number; userId: string | null; agentId: string | null; editedBy: string[] }>(db, sql`
        SELECT id, title, version, created_by_user_id AS "userId", created_by_agent_id AS "agentId", edited_by AS "editedBy" FROM sketches WHERE id = ${id}`);
    },
    async thoughts(ids: string[]): Promise<{ id: string; sketchId: string; text: string; x: number; y: number; version: number; userId: string | null; agentId: string | null; editedBy: string[] }[]> {
      if (!ids.length) return [];
      const t = schema.sketchThoughts;
      return db.select({ id: t.id, sketchId: t.sketchId, text: t.text, x: t.x, y: t.y, version: t.version, userId: t.createdByUserId, agentId: t.createdByAgentId, editedBy: t.editedBy }).from(t).where(inArray(t.id, ids));
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
    /** Every agent of one person: what they made counts as the person's own ("Yours", F-036 Terms). */
    async agentIdsOf(ownerUserId: string): Promise<string[]> {
      return (await db.select({ id: schema.agents.id }).from(schema.agents).where(eq(schema.agents.ownerUserId, ownerUserId))).map((row) => row.id);
    },
    /** A page is yours only while every version of it is by you or your agents ("Yours", F-036 Terms). */
    async docEditedByOthers(docId: string, ownerUserId: string, agentIds: readonly string[]): Promise<boolean> {
      const v = schema.projectMaterialVersions;
      const versions = await db.select({ authorId: v.authorId, authorAgentId: v.authorAgentId }).from(v).where(eq(v.materialId, docId));
      return versions.some((row) => !(row.authorAgentId ? agentIds.includes(row.authorAgentId) : row.authorId === ownerUserId));
    },
    /** Where each hand-off unit stands (state and how often it was claimed), for the row of the run's message. */
    async unitStates(ids: string[]): Promise<Map<string, { state: string; generation: number }>> {
      if (!ids.length) return new Map();
      const u = schema.coworkUnits;
      const rows = await db.select({ id: u.id, state: u.state, generation: u.generation }).from(u).where(inArray(u.id, ids));
      return new Map(rows.map((row) => [row.id, { state: row.state, generation: row.generation }]));
    },
    /**
     * An agent connection, as a hand-off recipient: whose it is, what it is called to its owner and whether it takes work in this space
     * (not Only read, and its owner a non-guest member who can see the space with AI on there; `projectId` null asks only the first).
     */
    async connection(id: string, projectId: string | null = null) {
      const k = schema.agentConnections;
      const [row] = await db.select({ id: k.id, ownerUserId: k.ownerUserId, computeSource: k.computeSource, revokedAt: k.revokedAt, name: k.name,
        clientDesignation: k.clientDesignation, mayDo: k.mayDo }).from(k).where(eq(k.id, id));
      if (!row) return null;
      const label = row.clientDesignation === 'codex' ? 'Codex' : row.clientDesignation === 'claude_code' ? 'Claude Code' : row.name;
      return { ...row, label, usable: row.mayDo !== 'read' && (!projectId || await connectionReaches(db, row.id, projectId)) };
    },
    async names(ids: string[]): Promise<Map<string, string>> {
      const unique = [...new Set(ids.filter(Boolean))];
      if (!unique.length) return new Map();
      const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, unique));
      return new Map(rows.map((row) => [row.id, row.name]));
    },
  };
}
