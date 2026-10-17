import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { ObjectRef } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';
import { referencedTaskIds } from './task-targets.js';
import { taskUseRows } from './task-use.js';
import { taskGraphRows } from './task-graph.js';

/**
 * Drizzle rows for work items, decisions, results and their links (issues #101, #46). They
 * satisfy the `WorkRepository` port of `packages/core/src/work/ports.ts` structurally (this
 * package does not depend on core) and make no access decisions: the core use cases ask the
 * access policy first, and list filters come from the policy's `visibleFilter`.
 */

type Actor = { kind: 'human' | 'agent'; id: string };
type WorkRow = typeof schema.projectWorkItems.$inferSelect;
type DecisionRow = typeof schema.projectDecisions.$inferSelect;
type ResultRow = typeof schema.projectResults.$inferSelect;
type LinkRow = typeof schema.projectObjectLinks.$inferSelect;
type Ref = { type: 'message' | 'thought' | 'work' | 'decision' | 'result' | 'doc' | 'sketch'; id: string } | { type: 'material'; id: string; version: number };
type Window = { limit: number; offset: number };

const w = schema.projectWorkItems;
const d = schema.projectDecisions;
const r = schema.projectResults;
const l = schema.projectObjectLinks;

export function toWorkRecord(row: WorkRow) {
  return {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, number: row.number, title: row.title, outcome: row.outcome,
    status: row.status, blocker: row.blocker,
    waitingFor: row.waitingForUserId ? { kind: 'human' as const, id: row.waitingForUserId } : null,
    dueOn: row.dueOn,
    creationOrigin: row.creationOrigin, creationBaselineVersion: row.creationBaselineVersion, firstPersistedUseAt: row.firstPersistedUseAt,
    creationRevertedAt: row.creationRevertedAt, creationReversionNoticeId: row.creationReversionNoticeId,
    creationRevertedBy: row.creationRevertedByKind && row.creationRevertedById ? { kind: row.creationRevertedByKind, id: row.creationRevertedById } : null,
    owner: row.ownerUserId ? { kind: 'human' as const, id: row.ownerUserId } : row.ownerAgentId ? { kind: 'agent' as const, id: row.ownerAgentId } : null,
    parked: row.parkedByDecisionId && row.parkedAt ? { decisionId: row.parkedByDecisionId, at: row.parkedAt } : null,
    criteria: row.criteria,
    createdBy: { kind: row.createdByKind, id: row.createdById }, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export function toDecisionRecord(row: DecisionRow) {
  return {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, title: row.title, rationale: row.rationale, status: row.status,
    proposedBy: { kind: row.proposedByKind, id: row.proposedById }, decidedBy: row.decidedBy, decidedAt: row.decidedAt,
    supersedesId: row.supersedesId, supersededById: row.supersededById, supersededAt: row.supersededAt,
    version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}

export function toResultRecord(row: ResultRow) {
  return {
    id: row.id, workspaceId: row.workspaceId, projectId: row.projectId, title: row.title, finding: row.finding, evidence: row.evidence,
    createdBy: { kind: row.createdByKind, id: row.createdById }, createdAt: row.createdAt,
  };
}

function toLinkRecord(row: LinkRow) {
  return { id: row.id, projectId: row.projectId, role: row.role, fromType: row.fromType, fromId: row.fromId, toType: row.toType, toId: row.toId, toVersion: row.toVersion, createdAt: row.createdAt };
}

/** A message's opening words: its first line, at most 120 characters. */
function excerpt(body: string) {
  const line = body.trim().split('\n', 1)[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Sketches shared with the project; a private sketch's thoughts are never linkable to project work. */
function projectSketch(projectId: string) {
  return and(eq(schema.sketches.projectId, projectId), eq(schema.sketches.scope, 'project'));
}

function ownerColumns(owner: Actor | null | undefined) {
  if (owner === undefined) return {};
  return { ownerUserId: owner?.kind === 'human' ? owner.id : null, ownerAgentId: owner?.kind === 'agent' ? owner.id : null };
}

type ActivityRow = typeof schema.projectTaskActivity.$inferSelect;
const sameActor = (a: Actor | null, b: Actor | null) => a?.kind === b?.kind && a?.id === b?.id;

/** One entry for each of status, owner, due date and title that differs between the task before and after a change (#488). */
async function recordTaskActivity(db: DbExecutor, before: ReturnType<typeof toWorkRecord> | null, after: ReturnType<typeof toWorkRecord>, by: Actor, via?: 'github_rule') {
  if (!before) return;
  const entries: { kind: ActivityRow['kind']; detail: Record<string, unknown> }[] = [];
  if (before.status !== after.status) {
    // What a move into Blocked said: the reason and the person waited for; nothing for any other state.
    const blocked = after.status === 'blocked';
    entries.push({ kind: 'status', detail: { from: before.status, to: after.status, blocker: blocked ? after.blocker : null, waitingForUserId: blocked ? after.waitingFor?.id ?? null : null } });
  }
  if (!sameActor(before.owner, after.owner)) entries.push({ kind: 'owner', detail: { from: before.owner, to: after.owner } });
  if (before.dueOn !== after.dueOn) entries.push({ kind: 'due', detail: { from: before.dueOn, to: after.dueOn } });
  if (before.title !== after.title) entries.push({ kind: 'title', detail: { from: before.title, to: after.title } });
  for (const entry of entries) {
    // clock_timestamp() (not the transaction's now()) keeps entries of one change in order and entries of changes that wait
    // for the same task row in the order they committed.
    await db.insert(schema.projectTaskActivity).values({ id: randomUUID(), workspaceId: after.workspaceId, projectId: after.projectId, workId: after.id,
      kind: entry.kind, actorKind: by.kind, actorId: by.id, detail: via ? { ...entry.detail, automation: via } : entry.detail, createdAt: sql`clock_timestamp()` });
  }
}

function toActivityRecord(row: ActivityRow, position: string) {
  const detail = row.detail as { from: unknown; to: unknown; blocker?: string | null; waitingForUserId?: string | null; automation?: 'github_rule' };
  const common = { id: row.id, workId: row.workId, at: row.createdAt, position, by: { kind: row.actorKind, id: row.actorId } as Actor, automation: detail.automation ?? null };
  switch (row.kind) {
    case 'status': return { ...common, kind: 'status' as const, from: detail.from as WorkRow['status'], to: detail.to as WorkRow['status'], blocker: detail.blocker ?? null, waitingForUserId: detail.waitingForUserId ?? null };
    case 'owner': return { ...common, kind: 'owner' as const, from: detail.from as Actor | null, to: detail.to as Actor | null };
    case 'due': return { ...common, kind: 'due' as const, from: detail.from as string | null, to: detail.to as string | null };
    case 'title': return { ...common, kind: 'title' as const, from: detail.from as string, to: detail.to as string };
  }
}

async function paged<Row, T>(db: DbExecutor, table: typeof w | typeof d | typeof r, where: SQL, window: Window, map: (row: Row) => T) {
  const [counted] = await db.select({ total: sql<number>`count(*)::int` }).from(table).where(where);
  const rows = await db.select().from(table).where(where).orderBy(desc(table.createdAt), desc(table.id)).limit(window.limit).offset(window.offset);
  return { items: (rows as Row[]).map(map), total: counted?.total ?? 0 };
}

export function workRows(db: DbExecutor) {
  return {
    ...taskGraphRows(db),
    taskUseTargets: (refs: readonly { type: string; id: string }[]) => referencedTaskIds(db, refs),
    prepareTaskUse: taskUseRows(db).prepare,
    lockPreparedTaskUse: taskUseRows(db).lockPrepared,
    async creatorAgentOwner(agentId: string, options: { lock?: boolean } = {}) {
      const query = db.select({ ownerId: schema.agents.ownerUserId }).from(schema.agents).where(eq(schema.agents.id, agentId));
      const [row] = options.lock ? await query.for('share') : await query;
      return row?.ownerId ?? null;
    },
    async creationBaselineMatches(workId: string) {
      const [row] = await db.select({ matches: sql<boolean>`${w.creationBaseline} = jsonb_build_object(
        'title', ${w.title}, 'outcome', ${w.outcome}, 'status', ${w.status}, 'blocker', ${w.blocker},
        'criteria', ${w.criteria}, 'ownerUserId', ${w.ownerUserId}, 'ownerAgentId', ${w.ownerAgentId},
        'parkedByDecisionId', ${w.parkedByDecisionId}, 'parkedAt', ${w.parkedAt})` }).from(w).where(eq(w.id, workId));
      return row?.matches === true;
    },
    async recordCreationBaseline(work: ReturnType<typeof toWorkRecord>, proposalId?: string) {
      if (proposalId) {
        const p = schema.proactiveComparisonProposals;
        const [bound] = await db.select({ id: p.id }).from(p).where(and(eq(p.id, proposalId), eq(p.projectId, work.projectId), eq(p.status, 'used'), eq(p.usedWorkId, work.id)));
        if (!bound || work.createdBy.kind !== 'human') throw new Error('Trusted proposal-use origin must be committed in this transaction');
      }
      await db.update(w).set({ creationOrigin: proposalId ? 'ai_proposal' : work.createdBy.kind === 'agent' ? 'native_agent' : 'human',
        creationBaselineVersion: work.version, creationBaseline: sql`jsonb_build_object(
          'title', ${w.title}, 'outcome', ${w.outcome}, 'status', ${w.status}, 'blocker', ${w.blocker},
          'criteria', ${w.criteria}, 'ownerUserId', ${w.ownerUserId}, 'ownerAgentId', ${w.ownerAgentId},
          'parkedByDecisionId', ${w.parkedByDecisionId}, 'parkedAt', ${w.parkedAt})`, creationProposalId: proposalId ?? null }).where(and(eq(w.id, work.id), isNull(w.creationBaselineVersion)));
    },
    /** #238: the facts a reader's Undo eligibility is decided from, in one read; no lock and no use mark. */
    async creationUndoFacts(workId: string) {
      const dependencies = schema.projectTaskDependencies;
      const [row] = await db.select({ work: w,
        baselineMatches: sql<boolean>`COALESCE(${w.creationBaseline} = jsonb_build_object(
          'title', ${w.title}, 'outcome', ${w.outcome}, 'status', ${w.status}, 'blocker', ${w.blocker},
          'criteria', ${w.criteria}, 'ownerUserId', ${w.ownerUserId}, 'ownerAgentId', ${w.ownerAgentId},
          'parkedByDecisionId', ${w.parkedByDecisionId}, 'parkedAt', ${w.parkedAt}), false)`,
        prerequisites: sql<number>`(SELECT count(*)::int FROM ${dependencies} WHERE ${dependencies.taskId} = ${w.id})`,
        creatorAgentOwnerUserId: sql<string | null>`(SELECT ${schema.agents.ownerUserId} FROM ${schema.agents}
          WHERE ${w.createdByKind} = 'agent' AND ${schema.agents.id}::text = ${w.createdById})` }).from(w).where(eq(w.id, workId));
      if (!row) return null;
      const record = toWorkRecord(row.work);
      return { reverted: !!record.creationRevertedAt, origin: record.creationOrigin, baselineVersion: record.creationBaselineVersion,
        version: record.version, used: !!record.firstPersistedUseAt, baselineMatches: row.baselineMatches, prerequisites: Number(row.prerequisites),
        createdBy: record.createdBy, owner: record.owner, creatorAgentOwnerUserId: record.creationOrigin === 'native_agent' ? row.creatorAgentOwnerUserId : null };
    },
    async creationUndoReceipt(projectId: string, by: Actor, commandId: string) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`task-creation-undo:${projectId}:${by.kind}:${by.id}:${commandId}`}))`);
      const n = schema.taskCreationUndoReceipts;
      const [row] = await db.select().from(n).where(and(eq(n.projectId, projectId), eq(n.actorKind, by.kind), eq(n.actorId, by.id), eq(n.clientCommandId, commandId)));
      return row ? { workId: row.workId, fingerprint: row.requestFingerprint, noticeId: row.noticeId } : null;
    },
    async revertCreation(work: ReturnType<typeof toWorkRecord>, by: Actor, commandId: string, fingerprint: string) {
      const noticeId = randomUUID();
      const now = new Date();
      const [updated] = await db.update(w).set({ creationRevertedAt: now, creationRevertedByKind: by.kind, creationRevertedById: by.id,
        creationReversionNoticeId: noticeId, version: sql`${w.version} + 1`, updatedAt: now }).where(eq(w.id, work.id)).returning();
      await db.insert(schema.projectTaskNotices).values({ id: noticeId, workspaceId: work.workspaceId, projectId: work.projectId,
        workId: work.id, kind: 'task.creation_reverted', createdByKind: by.kind, createdById: by.id, sources: [], createdAt: now });
      await db.insert(schema.taskCreationUndoReceipts).values({ workspaceId: work.workspaceId, projectId: work.projectId, actorKind: by.kind,
        actorId: by.id, clientCommandId: commandId, requestFingerprint: fingerprint, workId: work.id, noticeId });
      return { work: toWorkRecord(updated!), noticeId };
    },
    async locate(type: 'work' | 'decision' | 'result', id: string) {
      const table = type === 'work' ? w : type === 'decision' ? d : r;
      const [row] = await db.select({ projectId: table.projectId }).from(table).where(eq(table.id, id));
      return row ?? null;
    },

    listWork: (projectId: string, window: Window) => paged(db, w, and(eq(w.projectId, projectId), isNull(w.creationRevertedAt))!, window, toWorkRecord),
    listDecisions: (projectId: string, window: Window) => paged(db, d, eq(d.projectId, projectId), window, toDecisionRecord),
    listResults: (projectId: string, window: Window) => paged(db, r, eq(r.projectId, projectId), window, toResultRecord),

    /** Blocked work that concerns `userId` (#550): theirs, waiting for them, or held by an agent they own. */
    async listBlockedFor(workspaceId: string, userId: string, visibleProjects: SQL, window: Window) {
      const where = and(
        eq(w.workspaceId, workspaceId), eq(w.status, 'blocked'), isNull(w.creationRevertedAt), isNull(w.parkedAt),
        or(eq(w.ownerUserId, userId), eq(w.waitingForUserId, userId),
          sql`${w.ownerAgentId} IN (SELECT ${schema.agents.id} FROM ${schema.agents} WHERE ${schema.agents.ownerUserId} = ${userId})`),
        sql`${w.projectId} IN (SELECT ${schema.projects.id} FROM ${schema.projects} WHERE ${visibleProjects})`,
      )!;
      return paged(db, w, where, window, toWorkRecord);
    },

    /** Unfinished, unparked work of `owner` in projects matching `visibleProjects` (a condition over `projects`). */
    async listAssigned(workspaceId: string, owner: Actor, visibleProjects: SQL, window: Window) {
      const where = and(
        eq(w.workspaceId, workspaceId),
        owner.kind === 'human' ? eq(w.ownerUserId, owner.id) : eq(w.ownerAgentId, owner.id),
        isNull(w.creationRevertedAt), notInArray(w.status, ['done', 'not_pursued']), isNull(w.parkedAt),
        sql`${w.projectId} IN (SELECT ${schema.projects.id} FROM ${schema.projects} WHERE ${visibleProjects})`,
      )!;
      return paged(db, w, where, window, toWorkRecord);
    },

    async findWork(id: string, options: { lock?: boolean } = {}) {
      const query = db.select().from(w).where(eq(w.id, id));
      const [row] = options.lock ? await query.for('update') : await query;
      return row ? toWorkRecord(row) : null;
    },
    async insertWork(work: { id: string; workspaceId: string; projectId: string; title: string; outcome: string; status: WorkRow['status']; blocker: string | null; waitingFor?: Actor | null; dueOn?: string | null; owner: Actor | null; createdBy: Actor; criteria?: string[]; clientCommandId?: string; requestFingerprint?: string }) {
      const [row] = await db.insert(w).values({
        id: work.id, workspaceId: work.workspaceId, projectId: work.projectId, title: work.title, outcome: work.outcome,
        status: work.status, blocker: work.blocker, waitingForUserId: work.waitingFor?.id ?? null, dueOn: work.dueOn ?? null, ...ownerColumns(work.owner), createdByKind: work.createdBy.kind, createdById: work.createdBy.id,
        criteria: work.criteria ?? [], clientCommandId: work.clientCommandId ?? null, requestFingerprint: work.requestFingerprint ?? null,
      }).returning();
      return toWorkRecord(row!);
    },
    /** The durable native-command lock, then the earlier receipt of this exact actor, project, operation and command. */
    async nativeCommand(projectId: string, by: Actor, operation: 'work.update' | 'result.create', commandId: string) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`native-command:${projectId}:${by.kind}:${by.id}:${operation}:${commandId}`}))`);
      const n = schema.nativeCommandReceipts;
      const [row] = await db.select().from(n).where(and(eq(n.projectId, projectId), eq(n.actorKind, by.kind), eq(n.actorId, by.id),
        eq(n.operation, operation), eq(n.clientCommandId, commandId)));
      if (!row) return null;
      const object = row.operation === 'work.update' ? { type: 'work' as const, id: row.workId!, version: row.workVersion! } : { type: 'result' as const, id: row.resultId! };
      return { operation: row.operation, commandId: row.clientCommandId, fingerprint: row.requestFingerprint, object, messageIds: row.messageIds };
    },
    async recordNativeCommand(scope: { workspaceId: string; projectId: string }, by: Actor,
      receipt: { operation: 'work.update' | 'result.create'; commandId: string; fingerprint: string;
        object: { type: 'work'; id: string; version: number } | { type: 'result'; id: string }; messageIds: string[] }) {
      await db.insert(schema.nativeCommandReceipts).values({ ...scope, actorKind: by.kind, actorId: by.id, operation: receipt.operation,
        clientCommandId: receipt.commandId, requestFingerprint: receipt.fingerprint,
        workId: receipt.object.type === 'work' ? receipt.object.id : null, workVersion: receipt.object.type === 'work' ? receipt.object.version : null,
        resultId: receipt.object.type === 'result' ? receipt.object.id : null, messageIds: receipt.messageIds });
    },
    async createdWork(projectId: string, by: Actor, commandId: string) {
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`work-create:${projectId}:${by.kind}:${by.id}:${commandId}`}))`);
      const [row] = await db.select().from(w).where(and(eq(w.projectId, projectId), eq(w.createdByKind, by.kind),
        eq(w.createdById, by.id), eq(w.clientCommandId, commandId)));
      return row ? { work: toWorkRecord(row), fingerprint: row.requestFingerprint! } : null;
    },
    async insertCreationNotice(work: ReturnType<typeof toWorkRecord>, sources: ObjectRef[]) {
      await db.insert(schema.projectTaskNotices).values({ id: randomUUID(), workspaceId: work.workspaceId,
        projectId: work.projectId, workId: work.id, kind: 'task.created', createdByKind: work.createdBy.kind,
        createdById: work.createdBy.id, sources, createdAt: work.createdAt });
    },
    async insertTaskUpdate(work: ReturnType<typeof toWorkRecord>, update: { kind: 'task.blocked' | 'task.unblocked'; by: Actor; waitingFor: Actor | null; reason: string | null }) {
      await db.insert(schema.projectTaskUpdates).values({ id: randomUUID(), workspaceId: work.workspaceId, projectId: work.projectId,
        workId: work.id, kind: update.kind, createdByKind: update.by.kind, createdById: update.by.id,
        waitingForUserId: update.waitingFor?.id ?? null, reason: update.reason });
    },
    /** Creation notices and blocked/unblocked lines (#550) as one stream, newest first. */
    async listTaskNotices(projectId: string, window: Window) {
      const n = schema.projectTaskNotices;
      const u = schema.projectTaskUpdates;
      const [count] = await db.select({ total: sql<number>`(SELECT count(*) FROM ${n} WHERE ${n.projectId} = ${projectId}) + (SELECT count(*) FROM ${u} WHERE ${u.projectId} = ${projectId})` }).from(sql`(SELECT 1) AS one`);
      const result = await db.execute(sql`
        SELECT e.*, w.title AS work_title, w.number AS work_number FROM (
          SELECT n.id, n.workspace_id, n.project_id, n.work_id, n.kind, n.created_by_kind, n.created_by_id, n.sources, NULL::text AS waiting_for_user_id, NULL::text AS reason, n.created_at
            FROM project_task_notices n WHERE n.project_id = ${projectId}
          UNION ALL
          SELECT u.id, u.workspace_id, u.project_id, u.work_id, u.kind, u.created_by_kind, u.created_by_id, '[]'::jsonb AS sources, u.waiting_for_user_id, u.reason, u.created_at
            FROM project_task_updates u WHERE u.project_id = ${projectId}
        ) e JOIN project_work_items w ON w.id = e.work_id AND w.project_id = e.project_id AND w.workspace_id = e.workspace_id
        ORDER BY e.created_at DESC, e.id DESC LIMIT ${window.limit} OFFSET ${window.offset}`);
      const rows = result.rows as { id: string; workspace_id: string; project_id: string; work_id: string; kind: 'task.created' | 'task.creation_reverted' | 'task.blocked' | 'task.unblocked';
        created_by_kind: 'human' | 'agent'; created_by_id: string; sources: import('@flux/contracts').ObjectRef[]; waiting_for_user_id: string | null; reason: string | null;
        created_at: Date | string; work_title: string; work_number: number }[];
      return { total: Number(count?.total ?? 0), items: rows.map((row) => ({ id: row.id,
        workspaceId: row.workspace_id, projectId: row.project_id, workId: row.work_id, workTitle: row.work_title, workNumber: row.work_number, kind: row.kind,
        createdBy: { kind: row.created_by_kind, id: row.created_by_id }, sources: row.sources,
        ...(row.kind === 'task.blocked' ? { waitingFor: row.waiting_for_user_id ? { kind: 'human' as const, id: row.waiting_for_user_id } : null, reason: row.reason } : {}),
        createdAt: new Date(row.created_at) })) };
    },
    async updateWork(id: string, changes: { title?: string; outcome?: string; status?: WorkRow['status']; blocker?: string | null; waitingFor?: Actor | null; dueOn?: string | null; owner?: Actor | null; parked?: { decisionId: string; at: Date } | null; criteria?: string[] },
      by: Actor, via?: 'github_rule') {
      // Every path that changes a task ends here, so this is the one place its activity (#488) is kept: the row as it was,
      // then the change, then one entry per field that really differs, all in the caller's transaction. The caller holds the row.
      const [previous] = await db.select().from(w).where(eq(w.id, id)).for('update');
      const [row] = await db.update(w).set({
        ...(changes.title !== undefined ? { title: changes.title } : {}),
        ...(changes.outcome !== undefined ? { outcome: changes.outcome } : {}),
        ...(changes.criteria !== undefined ? { criteria: changes.criteria } : {}),
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.blocker !== undefined ? { blocker: changes.blocker } : {}),
        // Whoever moves a task out of Blocked, a person or a GitHub rule, also ends the wait.
        ...(changes.waitingFor !== undefined ? { waitingForUserId: changes.waitingFor?.id ?? null }
          : changes.status !== undefined && changes.status !== 'blocked' ? { waitingForUserId: null } : {}),
        ...(changes.dueOn !== undefined ? { dueOn: changes.dueOn } : {}),
        ...ownerColumns(changes.owner),
        ...(changes.parked !== undefined ? { parkedByDecisionId: changes.parked?.decisionId ?? null, parkedAt: changes.parked?.at ?? null } : {}),
        version: sql`${w.version} + 1`, updatedAt: new Date(),
      }).where(eq(w.id, id)).returning();
      const next = toWorkRecord(row!);
      await recordTaskActivity(db, previous ? toWorkRecord(previous) : null, next, by, via);
      return next;
    },
    /** A task's activity (#488), newest first, by (time, id) so a page boundary never repeats or skips an entry. */
    async listTaskActivity(workId: string, window: { limit: number; before: { position: string; id: string } | null }) {
      const a = schema.projectTaskActivity;
      const position = sql<string>`to_char(${a.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
      const rows = await db.select({ row: a, position }).from(a)
        .where(and(eq(a.workId, workId), window.before ? sql`(${a.createdAt}, ${a.id}) < (${window.before.position}::timestamptz, ${window.before.id}::uuid)` : undefined))
        .orderBy(desc(a.createdAt), desc(a.id)).limit(window.limit + 1);
      return { hasMore: rows.length > window.limit, items: rows.slice(0, window.limit).map(({ row, position }) => toActivityRecord(row, position)) };
    },

    async findDecision(id: string, options: { lock?: boolean } = {}) {
      const query = db.select().from(d).where(eq(d.id, id));
      const [row] = options.lock ? await query.for('update') : await query;
      return row ? toDecisionRecord(row) : null;
    },
    async insertDecision(decision: { id: string; workspaceId: string; projectId: string; title: string; rationale: string; proposedBy: Actor; supersedesId: string | null }) {
      const [row] = await db.insert(d).values({
        id: decision.id, workspaceId: decision.workspaceId, projectId: decision.projectId, title: decision.title, rationale: decision.rationale,
        proposedByKind: decision.proposedBy.kind, proposedById: decision.proposedBy.id, supersedesId: decision.supersedesId,
      }).returning();
      return toDecisionRecord(row!);
    },
    async updateDecision(id: string, changes: { status?: DecisionRow['status']; decidedBy?: string | null; decidedAt?: Date | null; supersededById?: string | null; supersededAt?: Date | null }) {
      const [row] = await db.update(d).set({ ...changes, version: sql`${d.version} + 1`, updatedAt: new Date() }).where(eq(d.id, id)).returning();
      return toDecisionRecord(row!);
    },

    async findResult(id: string) {
      const [row] = await db.select().from(r).where(eq(r.id, id));
      return row ? toResultRecord(row) : null;
    },
    async insertResult(result: { id: string; workspaceId: string; projectId: string; title: string; finding: ResultRow['finding']; evidence: string; createdBy: Actor }) {
      const [row] = await db.insert(r).values({
        id: result.id, workspaceId: result.workspaceId, projectId: result.projectId, title: result.title, finding: result.finding,
        evidence: result.evidence, createdByKind: result.createdBy.kind, createdById: result.createdBy.id,
      }).returning();
      return toResultRecord(row!);
    },

    async links(ids: string[]) {
      if (!ids.length) return [];
      const rows = await db.select().from(l).where(or(inArray(l.fromId, ids), inArray(l.toId, ids))).orderBy(asc(l.createdAt), asc(l.id));
      return rows.map(toLinkRecord);
    },
    async insertLinks(links: { id: string; workspaceId: string; projectId: string; role: LinkRow['role']; from: { type: LinkRow['fromType']; id: string }; to: Ref; createdBy: Actor }[]) {
      if (!links.length) return [];
      const inserted = await db.insert(l).values(links.map((link) => ({
        id: link.id, workspaceId: link.workspaceId, projectId: link.projectId, role: link.role, fromType: link.from.type, fromId: link.from.id,
        toType: link.to.type, toId: link.to.id, toVersion: link.to.type === 'material' ? link.to.version : null,
        createdByKind: link.createdBy.kind, createdById: link.createdBy.id,
      }))).onConflictDoNothing().returning({ id: l.id });
      return inserted.map((row) => row.id);
    },

    async targetExists(projectId: string, ref: Ref) {
      let found: unknown[];
      switch (ref.type) {
        case 'message':
          found = await db.select({ id: schema.projectMessages.id }).from(schema.projectMessages)
            .where(and(eq(schema.projectMessages.projectId, projectId), eq(schema.projectMessages.id, ref.id)));
          break;
        case 'thought':
          found = await db.select({ id: schema.sketchThoughts.id }).from(schema.sketchThoughts)
            .innerJoin(schema.sketches, eq(schema.sketches.id, schema.sketchThoughts.sketchId))
            .where(and(projectSketch(projectId), eq(schema.sketchThoughts.id, ref.id)));
          break;
        case 'doc':
          found = await db.select({ id: schema.projectMaterials.id }).from(schema.projectMaterials)
            .where(and(eq(schema.projectMaterials.projectId, projectId), eq(schema.projectMaterials.id, ref.id), eq(schema.projectMaterials.kind, 'doc')));
          break;
        case 'sketch':
          found = await db.select({ id: schema.sketches.id }).from(schema.sketches).where(and(projectSketch(projectId), eq(schema.sketches.id, ref.id)));
          break;
        case 'material':
          found = await db.select({ id: schema.projectMaterialVersions.materialId }).from(schema.projectMaterialVersions)
            .where(and(eq(schema.projectMaterialVersions.projectId, projectId), eq(schema.projectMaterialVersions.materialId, ref.id), eq(schema.projectMaterialVersions.version, ref.version)));
          break;
        default: {
          const table = ref.type === 'work' ? w : ref.type === 'decision' ? d : r;
          found = await db.select({ id: table.id }).from(table).where(and(eq(table.projectId, projectId), eq(table.id, ref.id)));
        }
      }
      return found.length > 0;
    },

    /** Titles keyed like core's `refKey`: `<type>:<id>`, or `material:<id>:<version>`. */
    async titles(projectId: string, refs: Ref[]) {
      const titles = new Map<string, { title: string; conversationId?: string; sketchId?: string }>();
      const of = (type: Ref['type']) => [...new Set(refs.filter((ref) => ref.type === type).map((ref) => ref.id))];
      const messages = of('message');
      if (messages.length) {
        const m = schema.projectMessages;
        for (const row of await db.select({ id: m.id, body: m.body, conversationId: m.conversationId }).from(m).where(and(eq(m.projectId, projectId), inArray(m.id, messages))))
          titles.set(`message:${row.id}`, { title: excerpt(row.body), conversationId: row.conversationId });
      }
      const thoughts = of('thought');
      if (thoughts.length) {
        const t = schema.sketchThoughts;
        const rows = await db.select({ id: t.id, text: t.text, sketchId: t.sketchId }).from(t).innerJoin(schema.sketches, eq(schema.sketches.id, t.sketchId))
          .where(and(projectSketch(projectId), inArray(t.id, thoughts)));
        for (const row of rows) titles.set(`thought:${row.id}`, { title: excerpt(row.text), sketchId: row.sketchId });
      }
      const materials = refs.filter((ref): ref is Extract<Ref, { type: 'material' }> => ref.type === 'material');
      if (materials.length) {
        const v = schema.projectMaterialVersions;
        const rows = await db.select({ id: v.materialId, version: v.version, title: v.title }).from(v)
          .where(and(eq(v.projectId, projectId), inArray(v.materialId, [...new Set(materials.map((ref) => ref.id))])));
        for (const row of rows) titles.set(`material:${row.id}:${row.version}`, { title: row.title });
      }
      const docs = of('doc');
      if (docs.length) {
        const m = schema.projectMaterials;
        const v = schema.projectMaterialVersions;
        const rows = await db.select({ id: m.id, title: v.title }).from(m)
          .innerJoin(v, and(eq(v.materialId, m.id), eq(v.version, m.currentVersion)))
          .where(and(eq(m.projectId, projectId), eq(m.kind, 'doc'), inArray(m.id, docs)));
        for (const row of rows) titles.set(`doc:${row.id}`, { title: row.title });
      }
      const sketchIds = of('sketch');
      if (sketchIds.length) {
        for (const row of await db.select({ id: schema.sketches.id, title: schema.sketches.title }).from(schema.sketches).where(and(projectSketch(projectId), inArray(schema.sketches.id, sketchIds))))
          titles.set(`sketch:${row.id}`, { title: row.title, sketchId: row.id });
      }
      for (const [type, table] of [['work', w], ['decision', d], ['result', r]] as const) {
        const wanted = of(type);
        if (!wanted.length) continue;
        if (type === 'work') {
          for (const row of await db.select({ id: w.id, title: w.title, reverted: w.creationRevertedAt }).from(w).where(and(eq(w.projectId, projectId), inArray(w.id, wanted))))
            titles.set(`work:${row.id}`, { title: row.reverted ? `${row.title} · creation undone` : row.title });
        } else {
          for (const row of await db.select({ id: table.id, title: table.title }).from(table).where(and(eq(table.projectId, projectId), inArray(table.id, wanted))))
            titles.set(`${type}:${row.id}`, { title: row.title });
        }
      }
      return titles;
    },

    async names(refs: Actor[]) {
      const names = new Map<string, string>();
      const users = [...new Set(refs.filter((ref) => ref.kind === 'human').map((ref) => ref.id))];
      const agents = [...new Set(refs.filter((ref) => ref.kind === 'agent').map((ref) => ref.id))];
      if (users.length) {
        for (const row of await db.select({ id: schema.authUsers.id, name: schema.authUsers.name }).from(schema.authUsers).where(inArray(schema.authUsers.id, users)))
          names.set(`human:${row.id}`, row.name);
      }
      if (agents.length) {
        for (const row of await db.select({ id: schema.agents.id, name: schema.agents.name }).from(schema.agents).where(inArray(schema.agents.id, agents)))
          names.set(`agent:${row.id}`, row.name);
      }
      return names;
    },
  };
}
