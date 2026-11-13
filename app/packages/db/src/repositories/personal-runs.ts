import { randomUUID } from 'node:crypto';
import { prepareReferencedTaskUse } from './task-targets.js';
import { fileRows, runPictureRows } from './files.js';
import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { docHeadings, type AgentChatMessage, type AgentMayDo, type AssistantSourceRef } from '@flux/contracts';
import * as schema from '../schema.js';
import { openRows } from '../sealing.js';
import type { DbExecutor } from './push.js';
import { personalRunWebReadRows } from './personal-run-web-reads.js';
import { apiKeySpendToday } from './api-key-spend.js';
import { lockAssistantOwner } from './assistant-lock.js';
import { companyGuestSql, isCompanyGuest } from './access.js';
import { personTimeZones } from './person-time-zone.js';

/**
 * Drizzle rows for personal assistant runs (issue #68, O-008): enablements, their per-workspace
 * agents, runs with their reservation and usage. They satisfy the
 * `PersonalRunRepository` port of `packages/core/src/personal-runs/ports.ts` structurally and make
 * no access decisions: the core use cases ask the access policy before reading any source.
 */

type Window = { limit: number; offset: number };
type RunRow = typeof schema.personalRuns.$inferSelect;
type SourceRef = AssistantSourceRef;
type NewRun = Pick<RunRow, 'id' | 'workspaceId' | 'projectId' | 'conversationId' | 'dmId' | 'dmThreadRootId' | 'ownerUserId' | 'agentId' | 'connectionId'
  | 'clientRunId' | 'requestFingerprint' | 'kind' | 'prompt' | 'targetSketchId' | 'targetThoughtId' | 'continuesRunId' | 'retryOfRunId'
  | 'reservedMicros' | 'provider' | 'model' | 'aiEpoch'> & { workId?: string | null; askedByRunId?: string | null; exchangeTurn?: number; engine?: RunRow['engine']; authority?: RunRow['authority']; backgroundLabel?: string | null;
    resumeAt?: Date | null; endReason?: RunRow['endReason']; planLimitResetsAt?: Date | null };
type RunChanges = Partial<Pick<RunRow, 'status' | 'stoppedAtStage' | 'stopRequestedAt' | 'stopRequestedBy' | 'costState' | 'chargedMicros' | 'inputTokens'
  | 'outputTokens' | 'answerBody' | 'answerTruncated' | 'committedAt' | 'dispatchedAt' | 'completedAt' | 'endReason' | 'planLimitResetsAt'
  | 'stopAcknowledgedAt' | 'answerRedacted' | 'resumeAt' | 'reservedMicros' | 'reservedAt' | 'largestRequestMicros' | 'shownAt' | 'dismissedAt'> & { answerSources: SourceRef[] }>;

const e = schema.assistantSettings;
const ag = schema.agents;
const r = schema.personalRuns;
const k = schema.agentConnections;
const IN_FLIGHT: ('queued' | 'reading' | 'dispatching')[] = ['queued', 'reading', 'dispatching'];
const FINISHED_WORK: 'done'[] = ['done'];

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
   * The per-owner lock of the one lock order (#921): the owner, ascending when there are several, before the space's task-graph
   * lock, before the task and run rows. It is `lockAssistantOwner`, a transaction-scoped advisory lock keyed by the owner, that
   * every writer of the owner's agents also takes first; it replaces the `personal_run_enablements` row of one setup per owner.
   */
  const lockOwner = (ownerUserId: string) => lockAssistantOwner(db, ownerUserId);

  /**
   * The AI setup of one of the owner's agents: the one named, else their first (Assistant, which answers `/ai`). A deleted agent has
   * none. `lock` takes the owner's lock (above) and then holds the agent's row until the unit of work ends, so the owner's requests
   * to their agents are serialized; the caller takes the task-graph lock after this call, never before. A guest of the company has none:
   * their agents are kept but refused until they are a member again (AG-2, C-50).
   */
  async function enablement(ownerUserId: string, options: { lock?: boolean; agentId?: string; workspaceId?: string } = {}) {
    if (options.lock) await lockOwner(ownerUserId);
    const query = db.select({ row: e }).from(e).innerJoin(ag, eq(ag.id, e.agentId))
      .where(and(eq(e.ownerUserId, ownerUserId), isNull(ag.revokedAt), options.agentId ? eq(e.agentId, options.agentId) : undefined,
        options.workspaceId ? eq(e.workspaceId, options.workspaceId) : undefined, sql`NOT ${companyGuestSql(e.ownerUserId)}`))
      .orderBy(asc(e.createdAt), asc(e.agentId)).limit(1);
    const [found] = options.lock ? await query.for('update', { of: e }) : await query;
    if (!found) return null;
    const { apiKeyId, model, ...row } = found.row;
    return { ...row, connectionId: apiKeyId, assistantModel: model };
  }

  async function findRun(id: string, options: { lock?: boolean; visibleToOwner?: boolean } = {}) {
    const query = db.select().from(r).where(and(eq(r.id, id), options.visibleToOwner ? sql`NOT ${companyGuestSql(r.ownerUserId)}` : undefined));
    const [row] = options.lock ? await query.for('update') : await query;
    return row ? toRun(row) : null;
  }

  async function pagedRuns(where: SQL, window: Window) {
    const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(r).where(where);
    const rows = await db.select().from(r).where(where)
      .orderBy(desc(r.createdAt), desc(r.id))
      .limit(window.limit).offset(window.offset);
    return { items: rows.map(toRun), total: counted?.total ?? 0 };
  }

  /**
   * What the run's Undo takes back (#919): the changes it made that have an undo plan, not the agent's own line in a task's thread (that is
   * deleted at the line, TA-3). `standing` still can be undone; `undone` already were.
   */
  async function undoableChanges(runIds: string[]) {
    const c = schema.assistantChanges;
    const counts = new Map<string, { standing: number; undone: number }>();
    if (!runIds.length) return counts;
    const rows = await db.select({ runId: c.runId, state: c.state, count: sql<number>`count(*)::int` }).from(c)
      .where(and(inArray(c.runId, runIds), inArray(c.state, ['applied', 'applied_after_wait', 'undone']), sql`jsonb_typeof(${c.receipt} -> 'undo') = 'object'`,
        sql`NOT (${c.receipt} #>> '{undo,plan,kind}' = 'removal' AND ${c.receipt} #>> '{undo,plan,thread}' = 'true')`))
      .groupBy(c.runId, c.state);
    for (const row of rows) {
      if (!row.runId) continue;
      const entry = counts.get(row.runId) ?? { standing: 0, undone: 0 };
      if (row.state === 'undone') entry.undone += row.count; else entry.standing += row.count;
      counts.set(row.runId, entry);
    }
    return counts;
  }

  return {
    enablement,
    lockOwner,

    /** The person's own time zone, their browser's (#1168, C-57; UTC until one has said): a schedule they ask for runs in it, and the brief's clock reads in it. */
    personTimeZone: (userId: string) => personTimeZones(db).get(userId),

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

    /** Whether the owner is a guest of the company now: their keys and plan sign-in are kept but not shown (C-50, #1059). */
    ownerIsGuest: (ownerUserId: string) => isCompanyGuest(db, ownerUserId),

    async workspaceEncrypted(workspaceId: string) {
      const [row] = await db.select({ encrypted: schema.workspaces.encrypted }).from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
      return row?.encrypted === true;
    },

    /** Working runs (any kind) and the owner's own queued requests: at most one of each (AST-6 queue). Queued background runs have their own limit. */
    async inFlightCount(ownerUserId: string) {
      const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(r).where(and(eq(r.ownerUserId, ownerUserId),
        or(inArray(r.status, ['reading', 'dispatching']), and(eq(r.status, 'queued'), eq(r.authority, 'owner_request')))));
      return row?.count ?? 0;
    },


    async workLabel(workId: string) {
      const w = schema.projectWorkItems;
      const [row] = await db.select({ number: w.number, title: w.title, projectId: w.projectId, projectName: schema.projects.name }).from(w)
        .innerJoin(schema.projects, eq(schema.projects.id, w.projectId)).where(eq(w.id, workId));
      return row ? { number: row.number, title: row.title, projectId: row.projectId, projectName: row.projectName } : null;
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

    webReads: (runId: string) => personalRunWebReadRows(db).forRun(runId),
    runPictures: (runId: string) => runPictureRows(db).forRun(runId),
    webSearches: (runId: string) => personalRunWebReadRows(db).searches(runId),
    addWebSearch: (runId: string, found: { queries: string[]; results: string[]; cited: string[] }) => personalRunWebReadRows(db).addSearch(runId, found),
    startWebSearch: (runId: string, query: string) => personalRunWebReadRows(db).startSearch(runId, query),
    settleWebSearch: (id: string, results: string[], queries?: string[]) => personalRunWebReadRows(db).settleSearch(id, results, queries),
    addPrivateText: (runId: string, kept: { body: string; addresses: string[] }) => personalRunWebReadRows(db).addPrivateText(runId, kept),
    privateTexts: async (runId: string) => {
      const rows = personalRunWebReadRows(db);
      return (await rows.privateTexts(runId, await rows.privateTextIds(runId))).map(({ body, addresses }) => ({ body, addresses }));
    },

    // A run in a direct message or a chat reads no task graph and holds no lock (#842); one in a space holds its graph after the owner's lock (#921).
    prepareTaskUse: async (projectId: string | null, conversationId: string | null, sources: readonly { type: string; id: string }[] = []) =>
      projectId === null ? { mark: async () => undefined }
        : prepareReferencedTaskUse(db, projectId, [...(conversationId ? [{ type: 'conversation', id: conversationId }] : []), ...sources]),

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

    /** The model gateway (#1441): the run whose unexpired gateway token has this SHA-256, or null. */
    async gatewayRunId(tokenHash: string): Promise<string | null> {
      const [row] = await db.select({ id: r.id }).from(r).where(and(eq(r.gatewayTokenHash, tokenHash), sql`${r.gatewayTokenExpiresAt} > now()`));
      return row?.id ?? null;
    },

    /** Stores a run's gateway token (its hash and expiry), replacing an earlier one; only while the run is in flight. */
    async armGateway(runId: string, tokenHash: string, expiresAt: Date): Promise<boolean> {
      const rows = await db.update(r).set({ gatewayTokenHash: tokenHash, gatewayTokenExpiresAt: expiresAt, updatedAt: new Date() })
        .where(and(eq(r.id, runId), inArray(r.status, ['reading', 'dispatching']))).returning({ id: r.id });
      return rows.length === 1;
    },

    /** Ends a run's gateway token: nothing finds the run by it again. */
    async closeGateway(runId: string): Promise<void> {
      await db.update(r).set({ gatewayTokenHash: null, gatewayTokenExpiresAt: null }).where(and(eq(r.id, runId), isNotNull(r.gatewayTokenHash)));
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

    /**
     * The owner's runs, newest first; `place` narrows them to one (#842): a conversation, a space's main conversation, a DM's main line, one of
     * its threads (#1016) or one agent's chat. A guest of the company has none to see: their runs are kept and listed again when they are a
     * member again (C-50).
     */
    listOwnRuns: (ownerUserId: string, window: Window, place?: { conversationId: string } | { spaceId: string } | { dmId: string; dmThreadRootId: string | null } | { chatAgentId: string }) =>
      pagedRuns(and(eq(r.ownerUserId, ownerUserId), sql`NOT ${companyGuestSql(sql`${ownerUserId}`)}`, !place ? undefined
        : 'conversationId' in place ? eq(r.conversationId, place.conversationId)
          : 'spaceId' in place ? and(eq(r.projectId, place.spaceId), isNull(r.conversationId))
            // A chat lists what its owner said and the answers to it; a schedule's run is none of that: its result is a line of the chat (#858).
            : 'dmId' in place ? and(eq(r.dmId, place.dmId), place.dmThreadRootId === null ? isNull(r.dmThreadRootId) : eq(r.dmThreadRootId, place.dmThreadRootId))
              : and(eq(r.agentId, place.chatAgentId), isNull(r.projectId), isNull(r.dmId), sql`${r.kind} <> 'scheduled'`))!, window),

    async names(userIds: string[]) {
      const unique = [...new Set(userIds)];
      if (!unique.length) return new Map<string, string>();
      const rows = await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, unique));
      return new Map(rows.map((row) => [row.id, row.name]));
    },

    /**
     * The company's people whose first name (lower case) is one of these (#1163): who could share an agent owner's first name in a space.
     * Rows only; whether each can read the space is the caller's question.
     */
    async namesakes(workspaceId: string, firstNames: string[]) {
      const unique = [...new Set(firstNames)];
      if (!unique.length) return [];
      const u = schema.authUsers;
      return db.select({ id: u.id, name: u.name }).from(schema.workspaceMembers).innerJoin(u, eq(u.id, schema.workspaceMembers.userId))
        .where(and(eq(schema.workspaceMembers.workspaceId, workspaceId), inArray(sql<string>`lower(split_part(btrim(${u.name}), ' ', 1))`, unique)));
    },

    /** The latest `limit` messages of one project conversation, oldest first. A message its author deleted (#1006) is not one a model reads. */
    async messages(conversationId: string, limit: number) {
      const m = schema.projectMessages;
      const rows = await db.select({ id: m.id, sequence: m.sequence, body: m.body, contributionKind: m.contributionKind,
        createdAt: m.createdAt, editedAt: m.editedAt, via: m.via,
        authorId: m.authorId, authorAgentId: m.authorAgentId, humanName: schema.authUsers.name, agentName: schema.agents.name, agentOwner: schema.agents.ownerUserId })
        .from(m).leftJoin(schema.authUsers, eq(schema.authUsers.id, m.authorId))
        .leftJoin(schema.agents, and(eq(schema.agents.workspaceId, m.workspaceId), eq(schema.agents.id, m.authorAgentId)))
        .where(and(eq(m.conversationId, conversationId), isNull(m.removedAt))).orderBy(desc(m.sequence)).limit(limit);
      const files = await fileRows(db).messageFiles(rows.map((row) => row.id));
      return rows.reverse().map(({ authorId, authorAgentId, humanName, agentName, agentOwner, contributionKind, editedAt, ...row }) => ({ ...row, edited: editedAt !== null,
        ...(contributionKind !== 'text' ? { contribution: { kind: contributionKind } } : {}),
        ...(files.get(row.id)?.length ? { files: files.get(row.id) } : {}),
        author: authorId !== null ? { kind: 'human' as const, id: authorId } : { kind: 'agent' as const, id: authorAgentId!, ...(agentOwner ? { ownerUserId: agentOwner } : {}) },
        authorName: authorId !== null ? humanName ?? 'Former member' : agentName ?? 'Agent' }));
    },

    /**
     * The latest `limit` calls of the place a run reads, oldest first (F-041 point 6): the space's own (a call at no task, map or page), or the
     * task's when the place is a task or its discussion; a thread has none. Identifiers and times only.
     */
    async calls(projectId: string, place: { conversationId: string | null; workId: string | null }, limit: number) {
      const s = schema.liveSessions;
      let workId = place.workId;
      if (workId === null && place.conversationId !== null) {
        const [discussion] = await db.select({ workId: schema.projectTaskDiscussions.workId }).from(schema.projectTaskDiscussions)
          .where(eq(schema.projectTaskDiscussions.conversationId, place.conversationId));
        if (!discussion) return [];
        workId = discussion.workId;
      }
      const at: SQL = workId !== null ? eq(s.workId, workId) : and(isNull(s.conversationId), isNull(s.workId), isNull(s.sketchId), isNull(s.docId))!;
      const rows = await db.select().from(s).where(and(eq(s.projectId, projectId), at)).orderBy(desc(s.createdAt), desc(s.id)).limit(limit);
      return rows.reverse().map((row) => ({ id: row.id, startedAt: row.createdAt, startedBy: row.createdBy, joinedBy: row.joinedBy,
        endedAt: row.state === 'available' || row.state === 'rotating' ? null : row.endedAt ?? row.updatedAt }));
    },

    /** The latest `limit` messages written in the people's conversations of a space, oldest first: what its main conversation says (#842). */
    async spaceMessages(projectId: string, limit: number) {
      const m = schema.projectMessages;
      const rows = await db.select({ id: m.id, sequence: m.sequence, body: m.body, contributionKind: m.contributionKind,
        createdAt: m.createdAt, editedAt: m.editedAt, via: m.via, conversationId: m.conversationId,
        authorId: m.authorId, authorAgentId: m.authorAgentId, humanName: schema.authUsers.name, agentName: schema.agents.name, agentOwner: schema.agents.ownerUserId })
        .from(m).innerJoin(schema.projectConversations, eq(schema.projectConversations.id, m.conversationId))
        .leftJoin(schema.authUsers, eq(schema.authUsers.id, m.authorId))
        .leftJoin(schema.agents, and(eq(schema.agents.workspaceId, m.workspaceId), eq(schema.agents.id, m.authorAgentId)))
        .where(and(eq(m.projectId, projectId), isNull(m.removedAt))).orderBy(desc(m.createdAt), desc(m.id)).limit(limit);
      // #1064, #1099: each message with the opening words of its thread (the conversation's first message, unless its author deleted it).
      // The body is sealed in an encrypted space (F-030 AC-5), so SQL never computes over it: the opening messages are read as rows,
      // opened through the sealing path, and cut here.
      const conversations = [...new Set(rows.map((row) => row.conversationId))];
      const openings = conversations.length ? await openRows(db, 'project_messages', await db.select({ id: m.id, workspaceId: m.workspaceId, conversationId: m.conversationId, body: m.body })
        .from(m).where(and(inArray(m.conversationId, conversations), eq(m.sequence, 1), isNull(m.removedAt)))) : [];
      const opening = new Map(openings.map((row) => [row.conversationId, row.body.slice(0, 120)]));
      return rows.reverse().map(({ authorId, authorAgentId, humanName, agentName, agentOwner, contributionKind, editedAt, ...row }, index) => ({ ...row, sequence: index + 1, edited: editedAt !== null,
        thread: opening.get(row.conversationId) ?? null,
        ...(contributionKind !== 'text' ? { contribution: { kind: contributionKind } } : {}),
        author: authorId !== null ? { kind: 'human' as const, id: authorId } : { kind: 'agent' as const, id: authorAgentId!, ...(agentOwner ? { ownerUserId: agentOwner } : {}) },
        authorName: authorId !== null ? humanName ?? 'Former member' : agentName ?? 'Agent' }));
    },

    /**
     * The latest `limit` messages of a direct message, oldest first (#842). The line "used AI here" is not one, nor is a message its author
     * deleted (#1006). With `threadRootId` (#1016) only that thread: its root and its replies.
     */
    async dmMessages(dmId: string, limit: number, threadRootId: string | null = null) {
      const m = schema.dmMessages;
      const rows = await db.select({ id: m.id, sequence: m.sequence, body: m.body, createdAt: m.createdAt, editedAt: m.editedAt, via: m.via, authorId: m.authorId, authorName: schema.authUsers.name })
        .from(m).innerJoin(schema.authUsers, eq(schema.authUsers.id, m.authorId))
        .where(and(eq(m.dmId, dmId), eq(m.kind, 'text'), isNull(m.removedAt), threadRootId === null ? undefined : or(eq(m.id, threadRootId), eq(m.threadRootId, threadRootId))))
        .orderBy(desc(m.sequence)).limit(limit);
      return rows.reverse().map(({ authorId, authorName, editedAt, ...row }) => ({ ...row, edited: editedAt !== null, author: { kind: 'human' as const, id: authorId }, authorName }));
    },

    /** The last `limit` exchanges of an agent's private chat before this run: what was asked and what it answered. */
    async chatTurns(agentId: string, beforeRunId: string, limit: number) {
      const rows = await db.select({ prompt: r.prompt, answer: r.answerBody }).from(r)
        .where(and(eq(r.agentId, agentId), isNull(r.projectId), isNull(r.dmId), eq(r.kind, 'ask'), isNotNull(r.committedAt), sql`${r.id} <> ${beforeRunId}`,
          sql`${r.createdAt} < (SELECT created_at FROM personal_runs WHERE id = ${beforeRunId})`)).orderBy(desc(r.createdAt), desc(r.id)).limit(limit);
      return rows.reverse().map((row) => ({ prompt: row.prompt, answer: row.answer ?? '' }));
    },

    /** Whether a message is a root of this DM, not a reply and not the line "used AI here": the only thing a thread hangs on (#1016). */
    async isDmThreadRoot(dmId: string, messageId: string) {
      const m = schema.dmMessages;
      const [row] = await db.select({ id: m.id }).from(m).where(and(eq(m.id, messageId), eq(m.dmId, dmId), eq(m.kind, 'text'), isNull(m.threadRootId)));
      return !!row;
    },

    /** The line both people of a DM see when AI is used in it. One per run: it takes the run's id as its own. It is no message to read. */
    async postDmAiLine(dmId: string, workspaceId: string, authorId: string, runId: string, company: string) {
      const [numbered] = await db.update(schema.dms).set({ nextSequence: sql`${schema.dms.nextSequence} + 1` }).where(eq(schema.dms.id, dmId)).returning({ nextSequence: schema.dms.nextSequence });
      await db.insert(schema.dmMessages).values({ id: runId, workspaceId, dmId, authorId, clientMessageId: randomUUID(), requestFingerprint: 'ai_used', sequence: numbered!.nextSequence - 1,
        body: company, kind: 'ai_used' }).onConflictDoNothing();
    },

    async postAgentChat(line: { agentId: string; runId: string | null; key: string; body: string; schedule?: AgentChatMessage['schedule'] }) {
      const t = schema.agentChatMessages;
      const [owner] = await db.select({ ownerUserId: e.ownerUserId, workspaceId: e.workspaceId }).from(e).innerJoin(ag, eq(ag.id, e.agentId)).where(and(eq(e.agentId, line.agentId), isNull(ag.revokedAt)));
      if (!owner) return null;
      const [made] = await db.insert(t).values({ id: randomUUID(), workspaceId: owner.workspaceId, agentId: line.agentId, ownerUserId: owner.ownerUserId, runId: line.runId, key: line.key, body: line.body,
        schedule: line.schedule ?? null }).onConflictDoNothing().returning();
      const [row] = made ? [made] : await db.select().from(t).where(and(eq(t.agentId, line.agentId), eq(t.key, line.key)));
      const counts = row?.runId ? (await undoableChanges([row.runId])).get(row.runId) : undefined;
      return row ? { message: { id: row.id, agentId: row.agentId, runId: row.runId, body: row.body, createdAt: row.createdAt.toISOString(), changes: counts?.standing ?? 0, undone: counts?.undone ?? 0, words: null, task: null,
        schedule: row.schedule ?? null }, created: !!made } : null;
    },

    async agentChatMessages(agentId: string, limit: number) {
      const t = schema.agentChatMessages;
      const rows = await db.select().from(t).where(eq(t.agentId, agentId)).orderBy(desc(t.createdAt), desc(t.id)).limit(limit);
      const counts = await undoableChanges([...new Set(rows.flatMap((row) => (row.runId ? [row.runId] : [])))]);
      // The agent's words and the task chip are the use case's to add: they need the reader's access.
      return rows.reverse().map((row) => ({ id: row.id, agentId: row.agentId, runId: row.runId, body: row.body, createdAt: row.createdAt.toISOString(),
        changes: row.runId ? counts.get(row.runId)?.standing ?? 0 : 0, undone: row.runId ? counts.get(row.runId)?.undone ?? 0 : 0, words: null, task: null, schedule: row.schedule ?? null }));
    },

    /** What came after the owner last opened a chat: the agent's answers (runs that ended in it) and its own lines. */
    async agentChatSummaries(ownerUserId: string) {
      const rows = await db.execute(sql`SELECT s.agent_id,
          (SELECT count(*)::int FROM agent_chat_messages m WHERE m.agent_id = s.agent_id AND m.created_at > COALESCE(r.read_at, '-infinity'))
          + (SELECT count(*)::int FROM personal_runs p WHERE p.agent_id = s.agent_id AND p.project_id IS NULL AND p.dm_id IS NULL AND p.kind = 'ask'
              AND p.completed_at IS NOT NULL AND p.completed_at > COALESCE(r.read_at, '-infinity')) AS unread,
          GREATEST((SELECT max(m.created_at) FROM agent_chat_messages m WHERE m.agent_id = s.agent_id),
            (SELECT max(p.completed_at) FROM personal_runs p WHERE p.agent_id = s.agent_id AND p.project_id IS NULL AND p.dm_id IS NULL AND p.kind = 'ask')) AS last_at
        FROM assistant_settings s JOIN agents a ON a.id = s.agent_id AND a.revoked_at IS NULL
        LEFT JOIN agent_chat_reads r ON r.agent_id = s.agent_id
        WHERE s.owner_user_id = ${ownerUserId} AND NOT ${companyGuestSql(sql`${ownerUserId}`)} ORDER BY s.created_at, s.agent_id`);
      return (rows.rows as { agent_id: string; unread: number; last_at: Date | string | null }[])
        .map((row) => ({ agentId: row.agent_id, unread: Number(row.unread), lastAt: row.last_at ? new Date(row.last_at).toISOString() : null }));
    },

    async agentChatReadAt(agentId: string) {
      const [row] = await db.select({ readAt: schema.agentChatReads.readAt }).from(schema.agentChatReads).where(eq(schema.agentChatReads.agentId, agentId));
      return row ? row.readAt.toISOString() : null;
    },

    async readAgentChat(agentId: string) {
      await db.execute(sql`INSERT INTO agent_chat_reads (agent_id, read_at) VALUES (${agentId}, now()) ON CONFLICT (agent_id) DO UPDATE SET read_at = now()`);
    },

    async locateDm(dmId: string) {
      const [row] = await db.select({ workspaceId: schema.dms.workspaceId }).from(schema.dms).where(eq(schema.dms.id, dmId));
      return row ?? null;
    },

    /** Unfinished work of the project, newest first. */
    async openWork(projectId: string, limit: number) {
      const w = schema.projectWorkItems;
      return db.select({ id: w.id, version: w.version, number: w.number, title: w.title, outcome: w.outcome, status: w.status }).from(w)
        .where(and(eq(w.projectId, projectId), notInArray(w.status, FINISHED_WORK), sql`${w.creationRevertedAt} IS NULL`))
        .orderBy(desc(w.createdAt), desc(w.id)).limit(limit);
    },

    /** The names of a run's place (#1064): the space, the task its conversation discusses, a DM's people. */
    async placeNames(place: { projectId: string | null; conversationId: string | null; dmId: string | null }) {
      const [space] = place.projectId === null ? [] : await db.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.id, place.projectId));
      const b = schema.projectTaskDiscussions;
      const w = schema.projectWorkItems;
      const [task] = place.conversationId === null ? [] : await db.select({ number: w.number, title: w.title }).from(b)
        .innerJoin(w, eq(w.id, b.workId)).where(eq(b.conversationId, place.conversationId));
      const people = place.dmId === null ? [] : await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.dmParticipants)
        .innerJoin(schema.authUsers, eq(schema.authUsers.id, schema.dmParticipants.userId)).where(eq(schema.dmParticipants.dmId, place.dmId))
        .orderBy(asc(schema.dmParticipants.joinedAt), asc(schema.authUsers.id));
      return { spaceName: space?.name ?? null, task: task ?? null, people };
    },

    /** A task as a run on it is told it (#1064): number, title, state, outcome, done-when, prerequisites, due day and blocker. */
    async taskBrief(workId: string) {
      const w = schema.projectWorkItems;
      const [row] = await db.select({ id: w.id, projectId: w.projectId, number: w.number, title: w.title, status: w.status, outcome: w.outcome,
        criteria: w.criteria, dueOn: w.dueOn, blocker: w.blocker }).from(w).where(eq(w.id, workId));
      if (!row) return null;
      const d = schema.projectTaskDependencies;
      const prerequisites = await db.select({ number: w.number, title: w.title, status: w.status }).from(d).innerJoin(w, eq(w.id, d.prerequisiteId))
        .where(and(eq(d.taskId, workId), eq(d.projectId, row.projectId))).orderBy(asc(w.number));
      return { ...row, criteria: row.criteria ?? [], prerequisites };
    },

    /**
     * The objects an answer's Flux marks name (C-62): pages, tasks, decisions and messages of the run's workspace, in the space when the run is in one. No access
     * decision (the use case asks the policy per space). Only a page cited by section is read whole, for its headings.
     */
    async cites(scope: { workspaceId: string; projectId: string | null }, refs: readonly { kind: 'doc' | 'task' | 'decision' | 'message'; id: string; section?: number }[]) {
      const found: { kind: 'doc' | 'task' | 'decision' | 'message'; id: string; projectId: string; title: string; conversationId?: string; revision?: number; version?: number; headings?: string[] }[] = [];
      const ids = (kind: string) => [...new Set(refs.filter((ref) => ref.kind === kind).map((ref) => ref.id))];
      const within = (column: AnyPgColumn) => (scope.projectId === null ? undefined : eq(column, scope.projectId));
      const docs = ids('doc');
      if (docs.length) {
        const m = schema.projectMaterials;
        const v = schema.projectMaterialVersions;
        const rows = await db.select({ id: m.id, projectId: m.projectId, version: v.version, title: v.title }).from(m)
          .innerJoin(v, and(eq(v.materialId, m.id), eq(v.version, m.currentVersion)))
          .where(and(eq(m.workspaceId, scope.workspaceId), eq(m.kind, 'doc'), inArray(m.id, docs), within(m.projectId)));
        // Only a page cited by section is read whole, for its headings.
        const sectioned = rows.filter((row) => refs.some((ref) => ref.kind === 'doc' && ref.id === row.id && ref.section));
        const bodies = new Map<string, string>();
        if (sectioned.length) {
          for (const row of await db.select({ id: m.id, body: v.body }).from(m).innerJoin(v, and(eq(v.materialId, m.id), eq(v.version, m.currentVersion)))
            .where(inArray(m.id, sectioned.map((item) => item.id)))) bodies.set(row.id, row.body);
        }
        for (const row of rows) found.push({ kind: 'doc', id: row.id, projectId: row.projectId, title: row.title, version: row.version, ...(bodies.has(row.id) ? { headings: docHeadings(bodies.get(row.id)!) } : {}) });
      }
      const tasks = ids('task');
      if (tasks.length) {
        const w = schema.projectWorkItems;
        for (const row of await db.select({ id: w.id, projectId: w.projectId, version: w.version, title: w.title }).from(w)
          .where(and(eq(w.workspaceId, scope.workspaceId), inArray(w.id, tasks), sql`${w.creationRevertedAt} IS NULL`, within(w.projectId))))
          found.push({ kind: 'task', id: row.id, projectId: row.projectId, title: row.title, revision: row.version });
      }
      const decisions = ids('decision');
      if (decisions.length) {
        const d = schema.projectDecisions;
        for (const row of await db.select({ id: d.id, projectId: d.projectId, title: d.title }).from(d).where(and(eq(d.workspaceId, scope.workspaceId), inArray(d.id, decisions), within(d.projectId))))
          found.push({ kind: 'decision', id: row.id, projectId: row.projectId, title: row.title });
      }
      const messages = ids('message');
      if (messages.length) {
        const m = schema.projectMessages;
        for (const row of await db.select({ id: m.id, projectId: m.projectId, conversationId: m.conversationId }).from(m)
          .where(and(eq(m.workspaceId, scope.workspaceId), inArray(m.id, messages), isNull(m.removedAt), within(m.projectId))))
          found.push({ kind: 'message', id: row.id, projectId: row.projectId, title: '', conversationId: row.conversationId });
      }
      return found;
    },

    /**
     * Keeps the objects a tool result of the run returned to be cited (C-62), each once, only while the run is in flight: a result that arrives as
     * the run ends finds it ended (the run's row is share-locked) and keeps nothing; 0074's trigger deletes them when it ends.
     */
    async addCites(runId: string, cites: readonly { kind: 'doc' | 'task' | 'decision' | 'message'; id: string }[]) {
      if (!cites.length) return;
      const kinds = cites.map((cite) => cite.kind);
      const ids = cites.map((cite) => cite.id);
      await db.execute(sql`INSERT INTO personal_run_cites (run_id, kind, object_id)
        SELECT r.id, c.kind, c.object_id FROM personal_runs r, unnest(${sql.param(kinds)}::text[], ${sql.param(ids)}::uuid[]) AS c(kind, object_id)
        WHERE r.id = ${runId} AND r.status IN ('reading', 'dispatching') FOR SHARE OF r
        ON CONFLICT DO NOTHING`);
    },

    /** The objects the run's tools returned to be cited (C-62), as `kind:id`. */
    async returnedCites(runId: string) {
      const c = schema.personalRunCites;
      return (await db.select({ kind: c.kind, id: c.objectId }).from(c).where(eq(c.runId, runId))).map((row) => `${row.kind}:${row.id}`);
    },

    async thought(sketchId: string, thoughtId: string) {
      const t = schema.sketchThoughts;
      const [row] = await db.select({ id: t.id, sketchId: t.sketchId, version: t.version, text: t.text,
        sketchScope: schema.sketches.scope, sketchProjectId: schema.sketches.projectId })
        .from(t).innerJoin(schema.sketches, eq(schema.sketches.id, t.sketchId))
        .where(and(eq(t.sketchId, sketchId), eq(t.id, thoughtId)));
      return row ?? null;
    },

    /** The agent's rights connection is live (not revoked with a deleted agent). */
    async assistantConnectionLive(ownerUserId: string, agentId: string) {
      const [row] = await db.select({ id: k.id }).from(e).innerJoin(k, eq(k.id, e.connectionId)).innerJoin(ag, eq(ag.id, e.agentId))
        .where(and(eq(e.ownerUserId, ownerUserId), eq(e.agentId, agentId), eq(k.computeSource, 'owner_assistant'), isNull(k.revokedAt), isNull(ag.revokedAt)));
      return Boolean(row);
    },

    /** The Ask me first (F-036 AG-3: one row on each agent's page) of this agent of the owner, or null when it is gone. */
    async assistantMayDo(ownerUserId: string, agentId: string): Promise<AgentMayDo | null> {
      const [row] = await db.select({ mayDo: k.mayDo }).from(e).innerJoin(k, eq(k.id, e.connectionId)).innerJoin(ag, eq(ag.id, e.agentId))
        .where(and(eq(e.ownerUserId, ownerUserId), eq(e.agentId, agentId), isNull(ag.revokedAt), isNull(k.revokedAt)));
      return row?.mayDo ?? null;
    },

    /** What the model is told besides the request (F-036 AG-1): the agent's saved instructions and what its owner asked it to remember. */
    async agentBrief(agentId: string) {
      const [row] = await db.select({ name: ag.name, instructions: e.instructions, colour: e.colour }).from(e).innerJoin(ag, eq(ag.id, e.agentId)).where(eq(e.agentId, agentId));
      if (!row) return null;
      const memory = await db.select({ body: schema.agentMemoryItems.body }).from(schema.agentMemoryItems).where(eq(schema.agentMemoryItems.agentId, agentId))
        .orderBy(asc(schema.agentMemoryItems.createdAt), asc(schema.agentMemoryItems.id));
      return { name: row.name, instructions: row.instructions, colour: row.colour, memory: memory.map((item) => item.body) };
    },
  };
}
