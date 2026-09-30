import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { CoWorkEnqueueCommand, CoWorkRequestLimits, CoWorkRequestRecord, CoWorkInboxRecord, CoWorkSourceRef } from '@flux/contracts';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

const requests = schema.coworkRequests;
const lineages = schema.coworkRequestLineages;
const deliveries = schema.coworkDeliveryIntents;
const pending = ['queued', 'deferred', 'claimed'] as const;
type Address = { workspaceId: string; projectId: string; connectionId: string };
type Row = typeof requests.$inferSelect;
/** Internal only; public continuation must be encrypted or server-held and context-bound. */
interface CandidateCursor extends Address { at: Date; agingSeconds: number; score: number; createdAt: string; id: string }
function record(row: Row): CoWorkRequestRecord {
  const { fingerprint: _fingerprint, updatedAt: _updated, ...result } = row;
  void _fingerprint; void _updated;
  return result;
}
function addressed(address: Address) {
  return and(eq(requests.workspaceId, address.workspaceId), eq(requests.projectId, address.projectId),
    eq(requests.recipientConnectionId, address.connectionId));
}
const unit = schema.coworkUnits;
const projection = { request: requests, unitState: unit.state, unitGeneration: unit.generation,
  assignment: unit.assignmentConnectionId,
  // PostgreSQL has microseconds; JS Date has milliseconds. Cursor text must preserve
  // the exact stored tuple, otherwise the last row can repeat forever on the next page.
  cursorTime: sql<string>`${requests.createdAt}::text`,
  leaseExpired: sql<boolean>`${unit.leaseExpiresAt} IS NULL OR ${unit.leaseExpiresAt} <= clock_timestamp()`,
  requestExpired: sql<boolean>`${requests.expiresAt} <= clock_timestamp()` };
function inbox(row: { request: Row; unitState: string; unitGeneration: number; assignment: string; leaseExpired: boolean; requestExpired: boolean }): CoWorkInboxRecord {
  const request = record(row.request);
  const lost = request.state === 'claimed' && (row.unitState !== 'claimed' || row.leaseExpired
    || request.claimedGeneration !== row.unitGeneration || row.assignment !== request.recipientConnectionId);
  return { ...request, effectiveState: row.requestExpired ? 'expired' : lost ? 'queued' : request.state,
    readinessReason: row.requestExpired ? 'request_expired'
      : row.assignment !== request.recipientConnectionId ? 'assignment_changed'
      : row.unitState === 'completed' || row.unitState === 'stopped' ? 'unit_closed' : lost ? 'claim_lost' : null };
}
function pageLimit(limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid bounded inbox page');
  return limit;
}
/** Storage only. Caller owns current authorization, shared command ledger and outer transaction.
 * Prepared access→command→sorted connection slots→complete sorted tasks precede these locks.
 * Source/target/criteria authorization and actual author-separation are mandatory outside this adapter.
 */
export function coworkRequestRows(tx: DbExecutor) {
  return {
    async enqueue(sender: Address, input: CoWorkEnqueueCommand, fingerprint: string, limits: CoWorkRequestLimits) {
      const [unit] = await tx.select().from(schema.coworkUnits).where(and(eq(schema.coworkUnits.id, input.unitId),
        eq(schema.coworkUnits.workspaceId, sender.workspaceId), eq(schema.coworkUnits.projectId, sender.projectId),
        eq(schema.coworkUnits.assignmentConnectionId, input.recipientConnectionId)));
      const connections = await tx.select().from(schema.agentConnections).where(and(
        eq(schema.agentConnections.workspaceId, sender.workspaceId), isNull(schema.agentConnections.revokedAt),
        inArray(schema.agentConnections.id, [sender.connectionId, input.recipientConnectionId])));
      const origin = connections.find((row) => row.id === sender.connectionId);
      const recipient = connections.find((row) => row.id === input.recipientConnectionId);
      if (!unit || !origin || !recipient || (input.kind === 'review' && unit.role !== 'review')
        || (input.kind === 'fix' && unit.role !== 'execute')) return { status: 'unavailable' as const };
      const [parent] = input.parentRequestId ? await tx.select().from(requests).where(and(
        eq(requests.id, input.parentRequestId), eq(requests.workspaceId, sender.workspaceId), eq(requests.projectId, sender.projectId))) : [];
      if (input.parentRequestId && !parent) return { status: 'unavailable' as const };
      const root = and(eq(lineages.taskId, unit.lineageTaskId), eq(lineages.runId, unit.runId),
        parent ? eq(lineages.id, parent.lineageId) : sql`true`);
      const rootScope = and(root, eq(lineages.workspaceId, sender.workspaceId), eq(lineages.projectId, sender.projectId));
      let [lineage] = await tx.select().from(lineages).where(rootScope).for('update');
      if (!lineage) {
        if (unit.version !== input.expectedUnitVersion) return { status: 'stale' as const };
        if (parent) return { status: 'unavailable' as const };
        await tx.insert(lineages).values({ id: randomUUID(), workspaceId: sender.workspaceId, projectId: sender.projectId,
          taskId: unit.lineageTaskId, runId: unit.runId, ...limits }).onConflictDoNothing();
        [lineage] = await tx.select().from(lineages).where(rootScope).for('update');
      }
      if (!lineage) throw new Error('Canonical request lineage missing');
      const [existing] = await tx.select().from(requests).where(and(eq(requests.lineageId, lineage.id), eq(requests.intentKey, input.intentKey)));
      if (existing) {
        if (existing.fingerprint !== fingerprint) return { status: 'conflict' as const };
        const [delivery] = await tx.select().from(deliveries).where(eq(deliveries.requestId, existing.id));
        if (!delivery) throw new Error('Committed request missing delivery intent');
        return { status: 'existing' as const, request: record(existing), deliveryIntentId: delivery.id };
      }
      if (unit.version !== input.expectedUnitVersion) return { status: 'stale' as const };
      if (unit.state === 'completed' || unit.state === 'stopped') return { status: 'unavailable' as const };
      const depth = parent ? parent.depth + 1 : 0;
      const reviewRound = input.kind === 'review' ? lineage.reviewRequests + 1 : parent?.reviewRound ?? 0;
      // First ceilings cannot be raised; a newer narrower current policy also applies.
      if (depth > Math.min(lineage.maximumDepth, limits.maximumDepth)
        || lineage.createdRequests >= Math.min(lineage.maximumRequests, limits.maximumRequests)
        || (input.kind === 'review' && lineage.reviewRequests >= Math.min(lineage.maximumReviewRounds, limits.maximumReviewRounds)))
        return { status: 'budget_exhausted' as const };
      await tx.update(lineages).set({ createdRequests: lineage.createdRequests + 1,
        reviewRequests: lineage.reviewRequests + (input.kind === 'review' ? 1 : 0) }).where(eq(lineages.id, lineage.id));
      const [created] = await tx.insert(requests).values({ id: randomUUID(), lineageId: lineage.id,
        workspaceId: sender.workspaceId, projectId: sender.projectId, taskId: unit.taskId, unitId: unit.id,
        senderConnectionId: origin.id, recipientConnectionId: recipient.id, senderOwnerId: origin.ownerUserId, recipientOwnerId: recipient.ownerUserId,
        intentKey: input.intentKey, fingerprint, parentRequestId: input.parentRequestId, kind: input.kind,
        target: input.target, sourceRefs: input.sourceRefs, criteriaRefs: input.criteriaRefs, depth, reviewRound,
        priority: input.priority, peerUnblocking: input.peerUnblocking,
        expiresAt: sql`clock_timestamp() + (${input.lifetimeSeconds} * interval '1 second')`,
        createdAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).returning();
      const deliveryIntentId = randomUUID();
      await tx.insert(deliveries).values({ id: deliveryIntentId, requestId: created!.id, createdAt: sql`clock_timestamp()` });
      return { status: 'created' as const, request: record(created!), deliveryIntentId };
    },
    /** At-least-once transport ACK only. No claim, task state, deletion or model wake. */
    async acknowledge(recipient: Address, deliveryIntentId: string) {
      const result = await tx.execute<{ id: string }>(sql`
        UPDATE cowork_delivery_intents delivery SET acknowledged_at = COALESCE(delivery.acknowledged_at, clock_timestamp())
        FROM cowork_requests request WHERE delivery.id = ${deliveryIntentId} AND delivery.request_id = request.id
          AND request.workspace_id = ${recipient.workspaceId} AND request.project_id = ${recipient.projectId}
          AND request.recipient_connection_id = ${recipient.connectionId} RETURNING delivery.id`);
      return result.rows.length === 1;
    },
    async defer(recipient: Address, requestId: string, expectedVersion: number,
      reason: 'busy' | 'dependency' | 'offline' | 'capability' | 'policy',
      nextBoundary: 'after_step' | 'after_tests' | 'after_release' | 'on_dependency' | 'on_resume' | 'on_capability', dependencyRef: CoWorkSourceRef | null = null) {
      if (!['busy', 'dependency', 'offline', 'capability', 'policy'].includes(reason)
        || !['after_step', 'after_tests', 'after_release', 'on_dependency', 'on_resume', 'on_capability'].includes(nextBoundary))
        throw new Error('A concrete deferral reason/boundary is required');
      if ((reason === 'dependency' || nextBoundary === 'on_dependency') && !dependencyRef)
        throw new Error('The actual dependency reference is required');
      const [row] = await tx.update(requests).set({ state: 'deferred', reason, nextBoundary, dependencyRef, version: sql`${requests.version} + 1`, updatedAt: sql`clock_timestamp()` })
        .where(and(addressed(recipient), eq(requests.id, requestId), eq(requests.version, expectedVersion),
          inArray(requests.state, ['queued', 'deferred']), sql`${requests.expiresAt} > clock_timestamp()`)).returning();
      return row ? record(row) : null;
    },
    /** Internal keyset only; current source filtering and opaque cursor signing belong to the caller. */
    async pendingPage(recipient: Address, limit: number, after?: { createdAt: string; id: string }) {
      const afterCondition = after ? sql`(${requests.createdAt}, ${requests.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)` : sql`true`;
      const rows = await tx.select(projection).from(requests).innerJoin(unit, eq(unit.id, requests.unitId))
        .where(and(addressed(recipient), inArray(requests.state, pending), afterCondition))
        .orderBy(asc(requests.createdAt), asc(requests.id)).limit(pageLimit(limit));
      const last = rows.at(-1);
      return { records: rows.map(inbox), continuation: last ? { createdAt: last.cursorTime, id: last.request.id } : null };
    },
    /** Candidates are not authorized claims. The core checks current sources/grants and safe checkpoint readiness. */
    async readyCandidates(recipient: Address, limit: number, agingSeconds = 600, cursor?: CandidateCursor) {
      if (!Number.isSafeInteger(agingSeconds) || agingSeconds < 1 || agingSeconds > 3600) throw new Error('Invalid aging interval');
      if (cursor && (cursor.agingSeconds !== agingSeconds || cursor.workspaceId !== recipient.workspaceId
        || cursor.projectId !== recipient.projectId || cursor.connectionId !== recipient.connectionId))
        throw new Error('Internal inbox continuation does not match the scan');
      const time = await tx.execute<{ at: Date }>(sql`SELECT clock_timestamp() AS at`);
      const at = cursor?.at ?? new Date(time.rows[0]!.at);
      if (!Number.isFinite(at.getTime())) throw new Error('Invalid internal inbox continuation');
      const score = sql<number>`${requests.priority} + CASE WHEN ${requests.peerUnblocking} THEN 2 ELSE 0 END
        + LEAST(6, GREATEST(0, floor(extract(epoch FROM (${at}::timestamptz - ${requests.createdAt})) / ${agingSeconds})))`.mapWith(Number);
      const after = cursor ? or(sql`${score} < ${cursor.score}`, and(sql`${score} = ${cursor.score}`,
        sql`(${requests.createdAt}, ${requests.id}) > (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`)) : sql`true`;
      const rows = await tx.select({ ...projection, score }).from(requests).innerJoin(schema.coworkUnits, eq(schema.coworkUnits.id, requests.unitId))
        .where(and(addressed(recipient), inArray(requests.state, pending), gt(requests.expiresAt, sql`clock_timestamp()`),
          eq(schema.coworkUnits.assignmentConnectionId, recipient.connectionId), inArray(schema.coworkUnits.state, ['pending', 'paused', 'claimed']),
          sql`(${schema.coworkUnits.state} <> 'claimed' OR ${schema.coworkUnits.leaseExpiresAt} <= clock_timestamp())`, after))
        .orderBy(desc(score), asc(requests.createdAt), asc(requests.id)).limit(pageLimit(limit));
      const last = rows.at(-1);
      return { records: rows.map(inbox), continuation: last
        ? { ...recipient, at, agingSeconds, score: last.score, createdAt: last.cursorTime, id: last.request.id } : null };
    },
  };
}
