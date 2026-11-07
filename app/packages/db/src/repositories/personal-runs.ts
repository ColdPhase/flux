import { prepareReferencedTaskUse } from './task-targets.js';
import { fileRows } from './files.js';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { AgentMayDo } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { apiKeySpendToday } from './api-key-spend.js';

/**
 * Drizzle rows for personal assistant runs (issue #68, O-008): enablements, their per-workspace
 * agents, runs with their reservation and usage, and assistant proposals. They satisfy the
 * `PersonalRunRepository` port of `packages/core/src/personal-runs/ports.ts` structurally and make
 * no access decisions: the core use cases ask the access policy before reading any source.
 */

type Window = { limit: number; offset: number };
type RunRow = typeof schema.personalRuns.$inferSelect;
type ProposalRow = typeof schema.assistantProposals.$inferSelect;
type SourceRef =
  | { type: 'message'; id: string; revision: number }
  | { type: 'work'; id: string; revision: number }
  | { type: 'thought'; id: string; sketchId: string; revision: number };
type NewRun = Pick<RunRow, 'id' | 'workspaceId' | 'projectId' | 'conversationId' | 'ownerUserId' | 'agentId' | 'connectionId'
  | 'clientRunId' | 'requestFingerprint' | 'kind' | 'prompt' | 'targetSketchId' | 'targetThoughtId' | 'continuesRunId' | 'retryOfRunId'
  | 'reservedMicros' | 'provider' | 'model' | 'aiEpoch'> & { engine?: RunRow['engine']; silent?: boolean; authority?: RunRow['authority']; backgroundLabel?: string | null;
    resumeAt?: Date | null; endReason?: RunRow['endReason']; planLimitResetsAt?: Date | null };
type RunChanges = Partial<Pick<RunRow, 'status' | 'stoppedAtStage' | 'stopRequestedAt' | 'costState' | 'chargedMicros' | 'inputTokens'
  | 'outputTokens' | 'answerBody' | 'answerTruncated' | 'committedAt' | 'dispatchedAt' | 'completedAt' | 'endReason' | 'planLimitResetsAt'
  | 'stopAcknowledgedAt' | 'answerRedacted' | 'silent' | 'resumeAt' | 'reservedMicros' | 'reservedAt' | 'largestRequestMicros'> & { answerSources: SourceRef[] }>;
type NewProposal = Pick<ProposalRow, 'id' | 'workspaceId' | 'projectId' | 'runId' | 'ownerUserId' | 'fact' | 'interpretation'
  | 'resultTitle' | 'resultFinding' | 'resultEvidence' | 'finishesWorkId'>;
type ProposalChanges = Partial<Pick<ProposalRow, 'status' | 'decidedBy' | 'decidedAt' | 'resultId'>>;

const e = schema.assistantSettings;
const ag = schema.agents;
const r = schema.personalRuns;
const k = schema.agentConnections;
const p = schema.assistantProposals;
/** The same words as `nothingToChange` in core (a posting schedule never posts them). */
const NOTHING_TO_CHANGE = '^\\W*done\\W*\\s*nothing to change\\W*$';
const IN_FLIGHT: ('queued' | 'reading' | 'dispatching')[] = ['queued', 'reading', 'dispatching'];
const FINISHED_WORK: ('done' | 'not_pursued')[] = ['done', 'not_pursued'];

/**
 * A queued run left behind: not one paused until a limit resets (#854), not one waiting for room on the server (#860), and
 * not one waiting its turn behind the owner's working run, whose clock may be an hour (#843).
 */
const waitingTooLong = (olderThanSeconds: number) => sql`((personal_runs.resume_at IS NULL OR personal_runs.resume_at < now() - (${olderThanSeconds}::int * interval '1 second'))
  AND personal_runs.end_reason IS DISTINCT FROM 'no_room'
  AND NOT EXISTS (SELECT 1 FROM personal_runs w WHERE w.owner_user_id = personal_runs.owner_user_id AND w.status IN ('reading', 'dispatching')))`;

/** What a run lost with its worker keeps counted: what it had spent and the most one more request could have cost, never more than it held (#854). */
const lostReservation = sql<number>`LEAST(${r.reservedMicros}, ${r.chargedMicros} + COALESCE(${r.largestRequestMicros}, ${r.reservedMicros}))`;

function toRun(row: RunRow) {
  const { answerSources, ...rest } = row;
  return { ...rest, answerSources: answerSources as SourceRef[] };
}

export function personalRunRows(db: DbExecutor) {
  /**
   * The AI setup of one of the owner's agents: the one named, else their first (Assistant, which answers `/ai`). A deleted agent has
   * none. `lock` holds the agent's row until the unit of work ends: it serializes the owner's requests to that agent.
   */
  async function enablement(ownerUserId: string, options: { lock?: boolean; agentId?: string; workspaceId?: string } = {}) {
    const query = db.select({ row: e }).from(e).innerJoin(ag, eq(ag.id, e.agentId))
      .where(and(eq(e.ownerUserId, ownerUserId), isNull(ag.revokedAt), options.agentId ? eq(e.agentId, options.agentId) : undefined,
        options.workspaceId ? eq(e.workspaceId, options.workspaceId) : undefined))
      .orderBy(asc(e.createdAt), asc(e.agentId)).limit(1);
    const [found] = options.lock ? await query.for('update', { of: e }) : await query;
    if (!found) return null;
    const { apiKeyId, model, ...row } = found.row;
    return { ...row, connectionId: apiKeyId, assistantModel: model };
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
    async needsCurrentGithubFacts(runId: string) {
      return (await db.execute(sql`SELECT e.id FROM assistant_reaction_events e JOIN assistant_reactions r ON r.id=e.reaction_id WHERE e.run_id=${runId} AND e.event='pr_ready' LIMIT 1`)).rows.length > 0;
    },

    /** The person's own time zone (their notification settings'; UTC when unset): a schedule they ask for runs in it. */
    async personTimeZone(userId: string) {
      const [row] = await db.select({ zone: schema.notificationPreferences.timeZone }).from(schema.notificationPreferences)
        .where(eq(schema.notificationPreferences.userId, userId));
      return row?.zone ?? 'UTC';
    },

    /** Today's use of an API key's one daily budget (#854), in the key's time zone; the key's own budget is passed in. */
    keySpend: (connection: { id: string; dailyBudgetCents: number; timeZone: string }, exceptRunId?: string) =>
      apiKeySpendToday(db, connection.id, exceptRunId, { dailyBudgetCents: connection.dailyBudgetCents, timeZone: connection.timeZone }),

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

    /** Working runs (any kind) and the owner's own queued requests: at most one of each (AST-6 queue). Queued background runs have their own limit. */
    async inFlightCount(ownerUserId: string) {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(r).where(and(eq(r.ownerUserId, ownerUserId),
        or(inArray(r.status, ['reading', 'dispatching']), and(eq(r.status, 'queued'), eq(r.authority, 'owner_request')))));
      return row?.count ?? 0;
    },

    async changeCount(runId: string) {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.assistantChanges).where(eq(schema.assistantChanges.runId, runId));
      return row?.count ?? 0;
    },

    /**
     * Another run of this owner holds the lane (reading or dispatching), or this queued background run would jump an owner's
     * own queued request: the owner's requests go before background runs (AST-6 queue).
     */
    async laneBusy(ownerUserId: string, exceptRunId: string) {
      const busy = await db.select({ id: r.id }).from(r).where(and(eq(r.ownerUserId, ownerUserId), inArray(r.status, ['reading', 'dispatching']), sql`${r.id} <> ${exceptRunId}`)).limit(1);
      if (busy.length) return true;
      const [self] = await db.select({ authority: r.authority }).from(r).where(eq(r.id, exceptRunId));
      if (!self || self.authority === 'owner_request') return false;
      // A paused request of the owner's holds nothing back until it can start.
      return (await db.select({ id: r.id }).from(r).where(and(eq(r.ownerUserId, ownerUserId), eq(r.status, 'queued'), eq(r.authority, 'owner_request'),
        sql`(${r.resumeAt} IS NULL OR ${r.resumeAt} <= now())`)).limit(1)).length > 0;
    },

    /**
     * Whether the runtime has room for one more agent (#860): fewer runs at work than it reported it can hold. It holds a lock
     * until the transaction ends, so the caller's claim counts before the next caller reads. Before any report: room, and the
     * run ends in its own words if the runtime is not there.
     */
    async roomForRuntimeRun() {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-runtime-room'))`);
      const rows = await db.execute(sql`SELECT
        (SELECT count(*)::int FROM personal_runs WHERE engine = 'runtime' AND status IN ('reading', 'dispatching')) AS running,
        (SELECT sum(capacity)::int FROM agent_runtime_slots WHERE state = 'ready') AS capacity`);
      const { running, capacity } = rows.rows[0] as { running: number; capacity: number | null };
      return capacity === null || running < capacity;
    },

    /** The run holding this owner's lane, if any: what a queued request is waiting behind. */
    async workingOf(ownerUserId: string) {
      const [row] = await db.select().from(r).where(and(eq(r.ownerUserId, ownerUserId), inArray(r.status, ['reading', 'dispatching']))).orderBy(asc(r.createdAt)).limit(1);
      return row ? toRun(row) : null;
    },

    /** Queued runs whose owner's lane is free, each owner's requests first, and whoever waited longest first: the next starts when the one before it ends. */
    async startableQueued(limit: number) {
      // Heads waiting for room stay out of the list until there is room, so they never crowd out a run on an API key.
      const room = sql`(SELECT count(*) FROM personal_runs w WHERE w.engine = 'runtime' AND w.status IN ('reading', 'dispatching'))
        < COALESCE((SELECT sum(capacity) FROM agent_runtime_slots WHERE state = 'ready'), 2147483647)`;
      const rows = await db.execute(sql`SELECT id FROM (SELECT DISTINCT ON (q.owner_user_id) q.id, q.created_at, q.end_reason FROM personal_runs q WHERE q.status = 'queued'
        AND (q.resume_at IS NULL OR q.resume_at <= now())
        AND NOT EXISTS (SELECT 1 FROM personal_runs a WHERE a.owner_user_id = q.owner_user_id AND a.status IN ('reading', 'dispatching'))
        ORDER BY q.owner_user_id, (q.authority <> 'owner_request'), q.created_at, q.id) next
        WHERE next.end_reason IS DISTINCT FROM 'no_room' OR ${room} ORDER BY created_at, id LIMIT ${limit}`);
      return (rows.rows as { id: string }[]).map((row) => row.id);
    },

    prepareTaskUse: (projectId: string, conversationId: string, sources: readonly { type: string; id: string }[] = []) =>
      prepareReferencedTaskUse(db, projectId, [{ type: 'conversation', id: conversationId }, ...sources]),

    async insertRun(run: NewRun) {
      const [row] = await db.insert(r).values(run).returning();
      return toRun(row!);
    },

    async updateRun(id: string, changes: RunChanges) {
      const [row] = await db.update(r).set({ ...changes, updatedAt: new Date() }).where(eq(r.id, id)).returning();
      return toRun(row!);
    },

    async endUndispatched(ownerUserId: string, status: 'revoked', agentId?: string) {
      const rows = await db.update(r).set({ status, costState: 'released', chargedMicros: 0, completedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(r.ownerUserId, ownerUserId), agentId ? eq(r.agentId, agentId) : undefined, inArray(r.status, ['queued', 'reading']))).returning();
      return rows.map(toRun);
    },

    async endStale(ownerUserId: string, olderThanSeconds: number) {
      const stale = and(eq(r.ownerUserId, ownerUserId), sql`${r.updatedAt} < now() - (${olderThanSeconds}::int * interval '1 second')`);
      const undispatched = await db.update(r).set({ status: 'unavailable', costState: 'released', chargedMicros: 0, completedAt: new Date(), updatedAt: new Date() })
        .where(and(stale, or(eq(r.status, 'reading'), and(eq(r.status, 'queued'), waitingTooLong(olderThanSeconds))))).returning();
      // A runtime run whose worker vanished may have changed things through its token: its end is unknown, never rerun.
      const lost = await db.update(r).set({ status: 'provider_failed', costState: 'unknown', chargedMicros: 0, reservedMicros: lostReservation, completedAt: new Date(), updatedAt: new Date(),
        endReason: sql`CASE WHEN ${r.engine} = 'runtime' THEN 'unknown' ELSE ${r.endReason} END` })
        .where(and(stale, eq(r.status, 'dispatching'))).returning();
      return [...undispatched, ...lost].map(toRun);
    },

    async endLostRuntime(running: readonly string[], olderThanSeconds: number, limit: number) {
      const rows = await db.update(r).set({
        status: sql`CASE WHEN ${r.status} = 'dispatching' THEN 'provider_failed' ELSE 'unavailable' END`,
        costState: sql`CASE WHEN ${r.status} = 'dispatching' THEN 'unknown' ELSE 'released' END`,
        endReason: sql`CASE WHEN ${r.status} = 'dispatching' THEN 'unknown' ELSE ${r.endReason} END`,
        chargedMicros: 0, completedAt: new Date(), updatedAt: new Date(),
      }).where(sql`${r.id} IN (SELECT id FROM personal_runs WHERE engine = 'runtime' AND status IN ('reading', 'dispatching')
        AND updated_at < now() - (${olderThanSeconds}::int * interval '1 second') AND id <> ALL(${sql.param([...running])}::uuid[])
        ORDER BY updated_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)`).returning();
      return rows.map(toRun);
    },

    async lockLane(ownerUserId: string) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('personal-run-lane'), hashtext(${ownerUserId}))`);
    },

    async endStaleAny(olderThanSeconds: number, limit: number) {
      // One globally bounded batch across all states. Replicas skip each other's locked rows.
      const rows = await db.update(r).set({
        status: sql`CASE WHEN ${r.status} = 'dispatching' THEN 'provider_failed' ELSE 'unavailable' END`,
        costState: sql`CASE WHEN ${r.status} = 'dispatching' THEN 'unknown' ELSE 'released' END`,
        endReason: sql`CASE WHEN ${r.status} = 'dispatching' AND ${r.engine} = 'runtime' THEN 'unknown' ELSE ${r.endReason} END`,
        reservedMicros: sql`CASE WHEN ${r.status} = 'dispatching' THEN ${lostReservation} ELSE ${r.reservedMicros} END`,
        chargedMicros: 0, completedAt: new Date(), updatedAt: new Date(),
      }).where(sql`${r.id} IN (SELECT id FROM personal_runs WHERE status IN (${sql.join(IN_FLIGHT.map((state) => sql`${state}`), sql`, `)})
        AND updated_at < now() - (${olderThanSeconds}::int * interval '1 second')
        AND (status <> 'queued' OR ${waitingTooLong(olderThanSeconds)})
        ORDER BY updated_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)`).returning();
      return rows.map(toRun);
    },

    listOwnRuns: (ownerUserId: string, window: Window) => pagedRuns(eq(r.ownerUserId, ownerUserId), 'newest', window),

    // A schedule that posts never posts "Done: nothing to change" (AST-7.11); a silent background run is never listed.
    listAnswers: (conversationId: string, window: Window) =>
      pagedRuns(and(eq(r.conversationId, conversationId), isNotNull(r.committedAt), eq(r.silent, false),
        sql`NOT (${r.kind} = 'scheduled' AND ${r.answerBody} ~* ${NOTHING_TO_CHANGE})`)!, 'committed', window),

    async jobOfRun(runId: string) {
      const [row] = await db.select({ id: schema.assistantJobs.id, title: schema.assistantJobs.title }).from(schema.assistantJobRuns)
        .innerJoin(schema.assistantJobs, eq(schema.assistantJobs.id, schema.assistantJobRuns.jobId)).where(eq(schema.assistantJobRuns.runId, runId)).limit(1);
      return row ?? null;
    },

    async names(userIds: string[]) {
      const unique = [...new Set(userIds)];
      if (!unique.length) return new Map<string, string>();
      const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, unique));
      return new Map(rows.map((row) => [row.id, row.name]));
    },

    /** The latest `limit` messages of one project conversation, oldest first. */
    async messages(conversationId: string, limit: number) {
      const m = schema.projectMessages;
      const rows = await db.select({ id: m.id, sequence: m.sequence, body: m.body, contributionKind: m.contributionKind, resultId: m.resultId,
        authorId: m.authorId, authorAgentId: m.authorAgentId, humanName: schema.authUsers.name, agentName: schema.agents.name })
        .from(m).leftJoin(schema.authUsers, eq(schema.authUsers.id, m.authorId))
        .leftJoin(schema.agents, and(eq(schema.agents.workspaceId, m.workspaceId), eq(schema.agents.id, m.authorAgentId)))
        .where(eq(m.conversationId, conversationId)).orderBy(desc(m.sequence)).limit(limit);
      const files = await fileRows(db).messageFiles(rows.map((row) => row.id));
      return rows.reverse().map(({ authorId, authorAgentId, humanName, agentName, contributionKind, resultId, ...row }) => ({ ...row,
        ...(contributionKind === 'result' ? { contribution: { kind: 'result' as const, resultId: resultId! } }
          : contributionKind !== 'text' ? { contribution: { kind: contributionKind } } : {}),
        ...(files.get(row.id)?.length ? { files: files.get(row.id) } : {}),
        author: authorId !== null ? { kind: 'human' as const, id: authorId } : { kind: 'agent' as const, id: authorAgentId! },
        authorName: authorId !== null ? humanName ?? 'Former member' : agentName ?? 'Agent' }));
    },

    /** Unfinished, unparked work of the project, newest first. */
    async openWork(projectId: string, limit: number) {
      const w = schema.projectWorkItems;
      return db.select({ id: w.id, version: w.version, title: w.title, outcome: w.outcome, status: w.status }).from(w)
        .where(and(eq(w.projectId, projectId), notInArray(w.status, FINISHED_WORK), sql`${w.creationRevertedAt} IS NULL`, sql`${w.parkedByDecisionId} IS NULL`))
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

    /** The agent's rights connection is live (not revoked with a deleted agent). */
    async assistantConnectionLive(ownerUserId: string, agentId: string) {
      const [row] = await db.select({ id: k.id }).from(e).innerJoin(k, eq(k.id, e.connectionId)).innerJoin(ag, eq(ag.id, e.agentId))
        .where(and(eq(e.ownerUserId, ownerUserId), eq(e.agentId, agentId), eq(k.computeSource, 'owner_assistant'), isNull(k.revokedAt), isNull(ag.revokedAt)));
      return Boolean(row);
    },

    /** The "What it may do" (F-036 AG-3) of the owner's first agent here, or null without one. */
    async assistantMayDo(ownerUserId: string, workspaceId: string): Promise<AgentMayDo | null> {
      const [row] = await db.select({ mayDo: k.mayDo }).from(e).innerJoin(k, eq(k.id, e.connectionId)).innerJoin(ag, eq(ag.id, e.agentId))
        .where(and(eq(e.ownerUserId, ownerUserId), eq(e.workspaceId, workspaceId), isNull(ag.revokedAt), isNull(k.revokedAt)))
        .orderBy(asc(e.createdAt), asc(e.agentId)).limit(1);
      return row?.mayDo ?? null;
    },

    /** What the model is told besides the request (F-036 AG-1): the agent's saved instructions and what its owner asked it to remember. */
    async agentBrief(agentId: string) {
      const [row] = await db.select({ name: ag.name, instructions: e.instructions }).from(e).innerJoin(ag, eq(ag.id, e.agentId)).where(eq(e.agentId, agentId));
      if (!row) return null;
      const memory = await db.select({ body: schema.agentMemoryItems.body }).from(schema.agentMemoryItems).where(eq(schema.agentMemoryItems.agentId, agentId))
        .orderBy(asc(schema.agentMemoryItems.createdAt), asc(schema.agentMemoryItems.id));
      return { name: row.name, instructions: row.instructions, memory: memory.map((item) => item.body) };
    },

    async listProposals(projectId: string, window: Window) {
      const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(p).where(eq(p.projectId, projectId));
      const rows = await db.select().from(p).where(eq(p.projectId, projectId)).orderBy(desc(p.createdAt), desc(p.id)).limit(window.limit).offset(window.offset);
      return { items: rows, total: counted?.total ?? 0 };
    },
  };
}
