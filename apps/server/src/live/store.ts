import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@flux/db';
import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  enforce,
  evaluateProject,
  type Database,
  type Executor,
  type LiveRepository,
  type LiveSessionRecord,
} from '@flux/core';
import type { LiveContextRef, LivePresentationRef } from '@flux/contracts';
import { requireLiveContext, requireLivePresentationSource } from './access.js';

type SessionRow = typeof schema.liveSessions.$inferSelect;

function contextColumns(context: LiveContextRef) {
  return {
    conversationId: context.type === 'conversation' ? context.id : null,
    workId: context.type === 'work' ? context.id : null,
    sketchId: context.type === 'sketch' ? context.id : null,
  };
}

function sameContext(row: SessionRow, projectId: string, context: LiveContextRef) {
  if (row.projectId !== projectId) return false;
  switch (context.type) {
    case 'conversation': return row.conversationId === context.id;
    case 'work': return row.workId === context.id;
    case 'sketch': return row.sketchId === context.id;
  }
}

function record(row: SessionRow): LiveSessionRecord {
  const context: LiveContextRef = row.conversationId
    ? { type: 'conversation', id: row.conversationId }
    : row.workId ? { type: 'work', id: row.workId } : { type: 'sketch', id: row.sketchId! };
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
        const [inserted] = await tx.insert(sessions).values({
          id: randomUUID(), workspaceId: project!.workspaceId, projectId, ...contextColumns(context),
          createdBy: principal.id, clientSessionId,
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
        if (existing.state === 'ended') throw new RuleViolationError('This session has ended', 'LIVE_SESSION_ENDED');
        await ensureRoom(existing.roomId);
        return record(existing);
      });
    },

    async find(sessionId) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      return row ? record(row) : null;
    },

    async withAdmission(principal, sessionId, issue) {
      return db.transaction(async (tx) => {
        const [located] = await tx.select({ projectId: sessions.projectId }).from(sessions)
          .where(eq(sessions.id, sessionId));
        if (!located) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        const workspaceId = await lockAdmissionScope(tx, located.projectId);
        enforce(await evaluateProject(principal, 'project.read', located.projectId, tx, { lock: true }), 'project');
        await requireClearFence(tx, workspaceId, located.projectId);
        const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('share');
        if (!row || row.projectId !== located.projectId) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
        if (row.state === 'rotating') throw new RuleViolationError('Live media access is being refreshed', 'LIVE_SESSION_ROTATING');
        if (row.state === 'ended') throw new RuleViolationError('This session has ended', 'LIVE_SESSION_ENDED');
        return issue(record(row));
      });
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
  };
}
