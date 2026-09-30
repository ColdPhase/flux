import { and, asc, desc, eq, inArray, isNotNull, notInArray, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle rows for personal assistant runs (issue #68, O-008): enablements, their per-workspace
 * agents, runs with their reservation and usage, and assistant proposals. They satisfy the
 * `PersonalRunRepository` port of `packages/core/src/personal-runs/ports.ts` structurally and make
 * no access decisions: the core use cases ask the access policy before reading any source.
 */

type Window = { limit: number; offset: number };
type EnablementRow = typeof schema.personalRunEnablements.$inferSelect;
type RunRow = typeof schema.personalRuns.$inferSelect;
type ProposalRow = typeof schema.assistantProposals.$inferSelect;
type SourceRef =
  | { type: 'message'; id: string; revision: number }
  | { type: 'work'; id: string; revision: number }
  | { type: 'thought'; id: string; sketchId: string; revision: number };
type NewEnablement = Omit<EnablementRow, 'status' | 'version' | 'consentedAt' | 'createdAt' | 'updatedAt'>;
type EnablementChanges = Partial<Pick<EnablementRow, 'perRunCents' | 'dailyCapCents' | 'timeZone' | 'status'>>;
type NewRun = Pick<RunRow, 'id' | 'workspaceId' | 'projectId' | 'conversationId' | 'ownerUserId' | 'agentId' | 'connectionId'
  | 'clientRunId' | 'requestFingerprint' | 'kind' | 'prompt' | 'targetSketchId' | 'targetThoughtId' | 'continuesRunId' | 'retryOfRunId'
  | 'reservedMicros' | 'model'>;
type RunChanges = Partial<Pick<RunRow, 'status' | 'stoppedAtStage' | 'stopRequestedAt' | 'costState' | 'chargedMicros' | 'inputTokens'
  | 'outputTokens' | 'answerBody' | 'answerTruncated' | 'committedAt' | 'dispatchedAt' | 'completedAt'> & { answerSources: SourceRef[] }>;
type NewProposal = Pick<ProposalRow, 'id' | 'workspaceId' | 'projectId' | 'runId' | 'ownerUserId' | 'fact' | 'interpretation'
  | 'resultTitle' | 'resultFinding' | 'resultEvidence' | 'finishesWorkId'>;
type ProposalChanges = Partial<Pick<ProposalRow, 'status' | 'decidedBy' | 'decidedAt' | 'resultId'>>;

const e = schema.personalRunEnablements;
const a = schema.personalRunAgents;
const r = schema.personalRuns;
const p = schema.assistantProposals;
const IN_FLIGHT: ('queued' | 'reading' | 'dispatching')[] = ['queued', 'reading', 'dispatching'];
const FINISHED_WORK: ('done' | 'not_pursued')[] = ['done', 'not_pursued'];

function toRun(row: RunRow) {
  const { answerSources, ...rest } = row;
  return { ...rest, answerSources: answerSources as SourceRef[] };
}

export function personalRunRows(db: DbExecutor) {
  async function enablement(ownerUserId: string, options: { lock?: boolean } = {}) {
    const query = db.select().from(e).where(eq(e.ownerUserId, ownerUserId));
    const [row] = options.lock ? await query.for('update') : await query;
    if (!row) return null;
    const agents = await db.select({ workspaceId: a.workspaceId, agentId: a.agentId }).from(a)
      .where(eq(a.ownerUserId, ownerUserId)).orderBy(asc(a.workspaceId));
    return { ...row, agents };
  }

  async function findRun(id: string, options: { lock?: boolean } = {}) {
    const query = db.select().from(r).where(eq(r.id, id));
    const [row] = options.lock ? await query.for('update') : await query;
    return row ? toRun(row) : null;
  }

  async function pagedRuns(where: SQL, order: 'newest' | 'committed', window: Window) {
    const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(r).where(where);
    const rows = await db.select().from(r).where(where)
      .orderBy(...(order === 'newest' ? [desc(r.createdAt), desc(r.id)] : [asc(r.committedAt), asc(r.id)]))
      .limit(window.limit).offset(window.offset);
    return { items: rows.map(toRun), total: counted?.total ?? 0 };
  }

  return {
    enablement,

    async insertEnablement(value: NewEnablement) {
      const [row] = await db.insert(e).values(value).onConflictDoNothing().returning();
      return row ? { ...row, agents: [] } : null;
    },

    async updateEnablement(ownerUserId: string, changes: EnablementChanges) {
      await db.update(e).set({ ...changes, version: sql`${e.version} + 1`, updatedAt: new Date() }).where(eq(e.ownerUserId, ownerUserId));
      return (await enablement(ownerUserId))!;
    },

    async deleteEnablement(ownerUserId: string) {
      return (await db.delete(e).where(eq(e.ownerUserId, ownerUserId)).returning({ ownerUserId: e.ownerUserId })).length > 0;
    },

    async selectAgent(ownerUserId: string, workspaceId: string, agentId: string) {
      await db.insert(a).values({ ownerUserId, workspaceId, agentId })
        .onConflictDoUpdate({ target: [a.ownerUserId, a.workspaceId], set: { agentId, createdAt: new Date() } });
    },

    /**
     * Charged micros of observed runs plus held reservations (in-flight and unknown runs) since
     * the start of the owner's local day; released runs cost nothing.
     */
    async spendToday(ownerUserId: string, timeZone: string, exceptRunId?: string) {
      const start = sql`(date_trunc('day', now() AT TIME ZONE ${timeZone}) AT TIME ZONE ${timeZone})`;
      const result = await db.execute(sql`SELECT
          COALESCE(sum(charged_micros) FILTER (WHERE cost_state = 'observed'), 0)::int AS charged,
          COALESCE(sum(reserved_micros) FILTER (WHERE cost_state IN ('reserved', 'unknown')), 0)::int AS reserved,
          (${start} + interval '1 day') AS resets_at
        FROM personal_runs
        WHERE owner_user_id = ${ownerUserId} AND created_at >= ${start}
          ${exceptRunId ? sql`AND id <> ${exceptRunId}` : sql``}`);
      const row = result.rows[0] as { charged: number; reserved: number; resets_at: Date | string };
      return { chargedMicros: Number(row.charged), reservedMicros: Number(row.reserved), resetsAt: new Date(row.resets_at) };
    },

    async locateConversation(conversationId: string) {
      const [row] = await db.select({ workspaceId: schema.projectConversations.workspaceId, projectId: schema.projectConversations.projectId })
        .from(schema.projectConversations).where(eq(schema.projectConversations.id, conversationId));
      return row ?? null;
    },

    async runByClientId(ownerUserId: string, clientRunId: string) {
      const [row] = await db.select().from(r).where(and(eq(r.ownerUserId, ownerUserId), eq(r.clientRunId, clientRunId)));
      return row ? toRun(row) : null;
    },

    findRun,

    async hasRunInFlight(ownerUserId: string) {
      const rows = await db.select({ id: r.id }).from(r).where(and(eq(r.ownerUserId, ownerUserId), inArray(r.status, IN_FLIGHT))).limit(1);
      return rows.length > 0;
    },

    async insertRun(run: NewRun) {
      const [row] = await db.insert(r).values(run).returning();
      return toRun(row!);
    },

    async updateRun(id: string, changes: RunChanges) {
      const [row] = await db.update(r).set({ ...changes, updatedAt: new Date() }).where(eq(r.id, id)).returning();
      return toRun(row!);
    },

    async endUndispatched(ownerUserId: string, status: 'paused' | 'revoked') {
      const rows = await db.update(r).set({ status, costState: 'released', chargedMicros: 0, completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(r.ownerUserId, ownerUserId), inArray(r.status, ['queued', 'reading']))).returning({ id: r.id });
      return rows.map((row) => row.id);
    },

    async endStale(ownerUserId: string, olderThanSeconds: number) {
      const stale = and(eq(r.ownerUserId, ownerUserId), sql`${r.updatedAt} < now() - (${olderThanSeconds}::int * interval '1 second')`);
      await db.update(r).set({ status: 'unavailable', costState: 'released', chargedMicros: 0, completedAt: new Date(), updatedAt: new Date() })
        .where(and(stale, inArray(r.status, ['queued', 'reading'])));
      await db.update(r).set({ status: 'provider_failed', costState: 'unknown', completedAt: new Date(), updatedAt: new Date() })
        .where(and(stale, eq(r.status, 'dispatching')));
    },

    listOwnRuns: (ownerUserId: string, window: Window) => pagedRuns(eq(r.ownerUserId, ownerUserId), 'newest', window),

    listAnswers: (conversationId: string, window: Window) =>
      pagedRuns(and(eq(r.conversationId, conversationId), isNotNull(r.committedAt))!, 'committed', window),

    async names(userIds: string[]) {
      const unique = [...new Set(userIds)];
      if (!unique.length) return new Map<string, string>();
      const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, unique));
      return new Map(rows.map((row) => [row.id, row.name]));
    },

    /** The latest `limit` messages of one project conversation, oldest first. */
    async messages(conversationId: string, limit: number) {
      const m = schema.projectMessages;
      const rows = await db.select({ id: m.id, sequence: m.sequence, body: m.body, authorName: schema.authUsers.name })
        .from(m).innerJoin(schema.authUsers, eq(schema.authUsers.id, m.authorId))
        .where(eq(m.conversationId, conversationId)).orderBy(desc(m.sequence)).limit(limit);
      return rows.reverse();
    },

    /** Unfinished, unparked work of the project, newest first. */
    async openWork(projectId: string, limit: number) {
      const w = schema.projectWorkItems;
      return db.select({ id: w.id, version: w.version, title: w.title, outcome: w.outcome, status: w.status }).from(w)
        .where(and(eq(w.projectId, projectId), notInArray(w.status, FINISHED_WORK), sql`${w.parkedByDecisionId} IS NULL`))
        .orderBy(desc(w.createdAt), desc(w.id)).limit(limit);
    },

    async thought(sketchId: string, thoughtId: string) {
      const t = schema.sketchThoughts;
      const [row] = await db.select({ id: t.id, sketchId: t.sketchId, version: t.version, text: t.text,
        sketchScope: schema.sketches.scope, sketchProjectId: schema.sketches.projectId })
        .from(t).innerJoin(schema.sketches, eq(schema.sketches.id, t.sketchId))
        .where(and(eq(t.sketchId, sketchId), eq(t.id, thoughtId)));
      return row ?? null;
    },

    async insertProposal(proposal: NewProposal) {
      const [row] = await db.insert(p).values({ ...proposal, changeType: 'result' }).returning();
      return row!;
    },

    async findProposal(id: string, options: { lock?: boolean } = {}) {
      const query = db.select().from(p).where(eq(p.id, id));
      const [row] = options.lock ? await query.for('update') : await query;
      return row ?? null;
    },

    async proposalOfRun(runId: string) {
      const [row] = await db.select().from(p).where(eq(p.runId, runId));
      return row ?? null;
    },

    async updateProposal(id: string, changes: ProposalChanges) {
      const [row] = await db.update(p).set({ ...changes, version: sql`${p.version} + 1`, updatedAt: new Date() }).where(eq(p.id, id)).returning();
      return row!;
    },

    async listProposals(projectId: string, window: Window) {
      const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(p).where(eq(p.projectId, projectId));
      const rows = await db.select().from(p).where(eq(p.projectId, projectId)).orderBy(desc(p.createdAt), desc(p.id)).limit(window.limit).offset(window.offset);
      return { items: rows, total: counted?.total ?? 0 };
    },
  };
}
