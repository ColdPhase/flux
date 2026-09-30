import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import {
  ConflictError,
  DomainError,
  NotFoundError,
  RuleViolationError,
  ServiceUnavailableError,
  enforce,
  evaluateProject,
  type Database,
  type Executor,
  type LiveRepository,
  type LiveSessionRecord,
} from '@flux/core';
import type { LiveContextRef, LivePresentation, LivePresentationRef } from '@flux/contracts';
import { requireLiveContext, requireLivePresentationSource } from './access.js';

type SessionRow = typeof schema.liveSessions.$inferSelect;
const MAX_PROJECT_SESSIONS = 8;
const MAX_CREATOR_SESSIONS = 3;
const PRESENTATION_BATCH = 100;
const MAX_PRESENTATION_SCAN = 500;

function contextColumns(context: LiveContextRef) {
  return {
    conversationId: context.type === 'conversation' ? context.id : null,
    workId: context.type === 'work' ? context.id : null,
    sketchId: context.type === 'sketch' ? context.id : null,
    docId: context.type === 'doc' ? context.id : null,
  };
}

function sameContext(row: SessionRow, projectId: string, context: LiveContextRef) {
  if (row.projectId !== projectId) return false;
  switch (context.type) {
    case 'conversation': return row.conversationId === context.id;
    case 'work': return row.workId === context.id;
    case 'sketch': return row.sketchId === context.id;
    case 'doc': return row.docId === context.id;
  }
}

function record(row: SessionRow): LiveSessionRecord {
  const context: LiveContextRef = row.conversationId
    ? { type: 'conversation', id: row.conversationId }
    : row.workId ? { type: 'work', id: row.workId }
      : row.sketchId ? { type: 'sketch', id: row.sketchId } : { type: 'doc', id: row.docId! };
  return {
    id: row.id,
    projectId: row.projectId,
    context,
    state: row.state,
    generation: row.generation,
    roomId: row.roomId,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

function selected(ref: LivePresentationRef): string[] {
  return ref.type === 'sketch' ? [...new Set(ref.selectedThoughtIds ?? [])].sort() : [];
}

type PresentationRow = typeof schema.livePresentations.$inferSelect;

function presentationRef(row: PresentationRow): LivePresentationRef {
  if (row.refType === 'sketch') return { type: 'sketch', id: row.refId,
    version: row.refVersion, selectedThoughtIds: row.selectedThoughtIds };
  return { type: row.refType, id: row.refId, version: row.refVersion };
}

function presentationView(row: PresentationRow): LivePresentation {
  return { id: row.id, generation: row.generation, createdBy: row.createdBy,
    ref: presentationRef(row), createdAt: row.createdAt.toISOString() };
}

/** The matching fence writer takes NO KEY UPDATE on these rows before commit. */
async function lockAdmissionScope(tx: Executor, projectId: string): Promise<string> {
  const [located] = await tx.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects)
    .where(eq(schema.projects.id, projectId));
  if (!located) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
  await tx.select({ id: schema.workspaces.id }).from(schema.workspaces)
    .where(eq(schema.workspaces.id, located.workspaceId)).for('share');
  await tx.select({ id: schema.projects.id }).from(schema.projects)
    .where(eq(schema.projects.id, projectId)).for('share');
  return located.workspaceId;
}

async function requireClearFence(tx: Executor, workspaceId: string, projectId: string): Promise<void> {
  const fenced = await tx.select({ scopeKey: schema.liveAccessFences.scopeKey }).from(schema.liveAccessFences)
    .where(inArray(schema.liveAccessFences.scopeKey, [`w:${workspaceId}`, `p:${projectId}`])).limit(1);
  if (fenced.length) throw new RuleViolationError('Live media access is being refreshed', 'LIVE_SESSION_ROTATING');
}

/** Persistence adapter. The core use case owns admission; writes recheck locked project policy. */
export function liveSessionStore(db: Database): LiveRepository {
  const sessions = schema.liveSessions;
  const presentations = schema.livePresentations;
  return {
    async createOrGet(principal, projectId, context, clientSessionId, ensureRoom) {
      return db.transaction(async (tx) => {
        const workspaceId = await lockAdmissionScope(tx, projectId);
        const { project } = enforce(await evaluateProject(principal, 'project.read', projectId, tx, { lock: true }), 'project');
        await requireClearFence(tx, workspaceId, projectId);
        await requireLiveContext(principal, context, projectId, tx, true);
        // One project lock serializes the count and insert across API replicas.
        // Resolve replay first: an existing key stays valid even at the cap.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(62062, hashtext(${projectId}))`);
        const [replay] = await tx.select().from(sessions).where(and(
          eq(sessions.createdBy, principal.id), eq(sessions.clientSessionId, clientSessionId),
        ));
        if (replay) {
          if (!sameContext(replay, projectId, context))
            throw new ConflictError('This clientSessionId was used for another context', 'IDEMPOTENCY_CONFLICT');
          if (replay.state === 'rotating') throw new RuleViolationError('Live media access is being refreshed', 'LIVE_SESSION_ROTATING');
          if (replay.state !== 'available') throw new RuleViolationError('This session has ended', 'LIVE_SESSION_ENDED');
          return record(replay);
        }
        const [counts] = await tx.select({
          project: sql<number>`count(*)::int`,
          creator: sql<number>`count(*) FILTER (WHERE ${sessions.createdBy} = ${principal.id})::int`,
        }).from(sessions).where(and(eq(sessions.projectId, projectId), ne(sessions.state, 'ended')));
        if ((counts?.project ?? 0) >= MAX_PROJECT_SESSIONS || (counts?.creator ?? 0) >= MAX_CREATOR_SESSIONS)
          throw new RuleViolationError('Too many active live sessions', 'LIVE_SESSION_LIMIT');
        const [inserted] = await tx.insert(sessions).values({
          id: randomUUID(), workspaceId: project!.workspaceId, projectId, ...contextColumns(context),
          createdBy: principal.id, clientSessionId, emptySince: new Date(),
          // Fresh random identity per generation; never encode the project or human ID.
          roomId: `live_${randomBytes(24).toString('base64url')}`,
        }).onConflictDoNothing({ target: [sessions.createdBy, sessions.clientSessionId] }).returning();
        if (inserted) {
          await ensureRoom(inserted.roomId);
          return record(inserted);
        }
        const [existing] = await tx.select().from(sessions).where(and(
          eq(sessions.createdBy, principal.id), eq(sessions.clientSessionId, clientSessionId),
        ));
        if (!existing || !sameContext(existing, projectId, context))
          throw new ConflictError('This clientSessionId was used for another context', 'IDEMPOTENCY_CONFLICT');
        if (existing.state === 'rotating') throw new RuleViolationError('Live media access is being refreshed', 'LIVE_SESSION_ROTATING');
        if (existing.state !== 'available') throw new RuleViolationError('This session has ended', 'LIVE_SESSION_ENDED');
        return record(existing);
      });
    },

    async find(sessionId) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      return row ? record(row) : null;
    },

    async withRead(principal, sessionId, read) {
      return db.transaction(async (tx) => {
        const [located] = await tx.select({ projectId: sessions.projectId }).from(sessions)
          .where(eq(sessions.id, sessionId));
        if (!located) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        await lockAdmissionScope(tx, located.projectId);
        enforce(await evaluateProject(principal, 'project.read', located.projectId, tx, { lock: true }), 'project');
        const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('share');
        if (!row || row.projectId !== located.projectId) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        const session = record(row);
        await requireLiveContext(principal, session.context, row.projectId, tx, true);
        return read(session);
      });
    },

    async withAdmission(principal, sessionId, issue, admission) {
      return db.transaction(async (tx) => {
        const [located] = await tx.select({ projectId: sessions.projectId }).from(sessions)
          .where(eq(sessions.id, sessionId));
        if (!located) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        const workspaceId = await lockAdmissionScope(tx, located.projectId);
        enforce(await evaluateProject(principal, 'project.read', located.projectId, tx, { lock: true }), 'project');
        await requireClearFence(tx, workspaceId, located.projectId);
        const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('no key update');
        if (!row || row.projectId !== located.projectId) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        if (row.state === 'rotating') throw new RuleViolationError('Live media access is being refreshed', 'LIVE_SESSION_ROTATING');
        if (row.state !== 'available') throw new RuleViolationError('This session has ended', 'LIVE_SESSION_ENDED');
        await requireLiveContext(principal, record(row).context, row.projectId, tx, true);
        if (admission) await tx.insert(schema.liveAdmissions).values({ id: admission.id, liveSessionId: row.id,
          userId: principal.id, authSessionId: admission.authSessionId });
        const result = await issue(record(row));
        // A freshly issued grant gets a full reconnect window. The next
        // authoritative empty observation starts its empty interval anew.
        await tx.update(sessions).set({ lastGrantAt: new Date(), emptySince: null, updatedAt: new Date() })
          .where(eq(sessions.id, sessionId));
        return result;
      });
    },

    async endAdmissions(sessionId, principal, authSessionId) {
      const admissions = schema.liveAdmissions;
      const rows = await db.update(admissions).set({ revokedAt: sql`coalesce(${admissions.revokedAt}, now())` })
        .where(and(eq(admissions.liveSessionId, sessionId), eq(admissions.userId, principal.id),
          eq(admissions.authSessionId, authSessionId)))
        .returning({ id: admissions.id });
      return rows.map((row) => row.id);
    },

    async present(sessionId, principal, ref, clientEventId) {
      await db.transaction(async (tx) => {
        const [located] = await tx.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, sessionId));
        if (!located) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        // Lock the exact membership, project and grant rows used by the policy decision.
        // Revocation either commits first and denies this write or waits for this commit.
        enforce(await evaluateProject(principal, 'project.read', located.projectId, tx, { lock: true }), 'project');
        const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('update');
        if (!row || row.projectId !== located.projectId) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        if (row.state !== 'available') throw new RuleViolationError('This session has ended', 'LIVE_SESSION_ENDED');
        await requireLiveContext(principal, record(row).context, row.projectId, tx, true);
        const ids = selected(ref);
        const [existing] = await tx.select().from(presentations).where(and(
          eq(presentations.sessionId, sessionId), eq(presentations.createdBy, principal.id),
          eq(presentations.clientEventId, clientEventId),
        ));
        if (existing) {
          if (existing.refType !== ref.type || existing.refId !== ref.id ||
              existing.refVersion !== ref.version || JSON.stringify(existing.selectedThoughtIds) !== JSON.stringify(ids))
            throw new ConflictError('This clientEventId was used for another presentation', 'IDEMPOTENCY_CONFLICT');
          return;
        }

        await requireLivePresentationSource(principal, row.projectId, ref, tx, true);
        const [inserted] = await tx.insert(presentations).values({
          id: randomUUID(), workspaceId: row.workspaceId, projectId: row.projectId,
          sessionId, generation: row.generation, createdBy: principal.id, clientEventId,
          refType: ref.type, refId: ref.id, refVersion: ref.version, selectedThoughtIds: ids,
        }).onConflictDoNothing({ target: [presentations.sessionId, presentations.createdBy, presentations.clientEventId] }).returning();
        if (inserted) return;
        const [raced] = await tx.select().from(presentations).where(and(
          eq(presentations.sessionId, sessionId), eq(presentations.createdBy, principal.id),
          eq(presentations.clientEventId, clientEventId),
        ));
        if (!raced || raced.refType !== ref.type || raced.refId !== ref.id ||
            raced.refVersion !== ref.version || JSON.stringify(raced.selectedThoughtIds) !== JSON.stringify(ids))
          throw new ConflictError('This clientEventId was used for another presentation', 'IDEMPOTENCY_CONFLICT');
        // The source was checked under this transaction. Receivers still reauthorize
        // through the ordinary object API because a source can change later.
      });
    },

    async pagePresentations(principal, sessionId, after, limit) {
      return db.transaction(async (tx) => {
        const [located] = await tx.select({ projectId: sessions.projectId }).from(sessions)
          .where(eq(sessions.id, sessionId));
        if (!located) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        const workspaceId = await lockAdmissionScope(tx, located.projectId);
        enforce(await evaluateProject(principal, 'project.read', located.projectId, tx, { lock: true }), 'project');
        await requireClearFence(tx, workspaceId, located.projectId);
        const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('share');
        if (!session || session.projectId !== located.projectId)
          throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        if (session.state !== 'available')
          throw new RuleViolationError('This session is not available', 'LIVE_SESSION_UNAVAILABLE');
        await requireLiveContext(principal, record(session).context, session.projectId, tx, true);

        if (after !== null) {
          const [cursor] = await tx.select().from(presentations).where(and(
            eq(presentations.id, after), eq(presentations.sessionId, sessionId),
            eq(presentations.generation, session.generation),
          ));
          if (!cursor) throw new NotFoundError('Live presentation', 'LIVE_PRESENTATION_NOT_FOUND');
          try { await requireLivePresentationSource(principal, session.projectId, presentationRef(cursor), tx, true); }
          catch (error) {
            if (error instanceof DomainError && error.status === 404)
              throw new NotFoundError('Live presentation', 'LIVE_PRESENTATION_NOT_FOUND');
            throw error;
          }
        }

        const visible: PresentationRow[] = [];
        let scanned = 0;
        let scannedAfter = after;
        while (scanned < MAX_PRESENTATION_SCAN) {
          const take = Math.min(PRESENTATION_BATCH, MAX_PRESENTATION_SCAN - scanned);
          // Resolve the cursor inside PostgreSQL: JS Date loses PostgreSQL's
          // microseconds and can otherwise repeat or skip same-millisecond rows.
          const position = scannedAfter === null ? undefined : sql`
            (${presentations.createdAt}, ${presentations.id}) >
            (SELECT created_at, id FROM live_presentations WHERE id = ${scannedAfter}::uuid)`;
          const rows = await tx.select().from(presentations).where(and(
            eq(presentations.sessionId, sessionId), eq(presentations.generation, session.generation), position,
          )).orderBy(asc(presentations.createdAt), asc(presentations.id)).limit(take);
          if (!rows.length) return { items: visible.map(presentationView), nextAfter: null };
          for (const row of rows) {
            scannedAfter = row.id;
            scanned++;
            try { await requireLivePresentationSource(principal, session.projectId, presentationRef(row), tx, true); }
            catch (error) {
              if (error instanceof DomainError && error.code === 'LIVE_SOURCE_NOT_FOUND') continue;
              throw error;
            }
            if (visible.length === limit)
              return { items: visible.map(presentationView), nextAfter: visible.at(-1)!.id };
            visible.push(row);
          }
          if (rows.length < take) return { items: visible.map(presentationView), nextAfter: null };
        }
        // A hidden tail cannot produce an observable continuation or count.
        throw new ServiceUnavailableError('Live presentations are temporarily unavailable', 'LIVE_PRESENTATIONS_UNAVAILABLE');
      });
    },
  };
}
