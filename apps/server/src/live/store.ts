import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema } from '@flux/db';
import {
  ConflictError,
  NotFoundError,
  RuleViolationError,
  enforce,
  evaluateProject,
  type Database,
  type LiveRepository,
  type LiveSessionRecord,
} from '@flux/core';
import type { LiveContextRef, LivePresentationRef } from '@flux/contracts';

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

/** Persistence adapter. The core use case owns admission; writes recheck locked project policy. */
export function liveSessionStore(db: Database): LiveRepository {
  const sessions = schema.liveSessions;
  const presentations = schema.livePresentations;
  return {
    async createOrGet(principal, projectId, context, clientSessionId) {
      return db.transaction(async (tx) => {
        const { project } = enforce(await evaluateProject(principal, 'project.read', projectId, tx, { lock: true }), 'project');
        const [inserted] = await tx.insert(sessions).values({
          id: randomUUID(), workspaceId: project!.workspaceId, projectId, ...contextColumns(context),
          createdBy: principal.id, clientSessionId,
          // Fresh random identity per generation; never encode the project or human ID.
          roomId: `live_${randomBytes(24).toString('base64url')}`,
        }).onConflictDoNothing({ target: [sessions.createdBy, sessions.clientSessionId] }).returning();
        if (inserted) return record(inserted);
        const [existing] = await tx.select().from(sessions).where(and(
          eq(sessions.createdBy, principal.id), eq(sessions.clientSessionId, clientSessionId),
        ));
        if (!existing || !sameContext(existing, projectId, context))
          throw new ConflictError('This clientSessionId was used for another context', 'IDEMPOTENCY_CONFLICT');
        return record(existing);
      });
    },

    async find(sessionId) {
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
      return row ? record(row) : null;
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
        const [inserted] = await tx.insert(presentations).values({
          id: randomUUID(), workspaceId: row.workspaceId, projectId: row.projectId,
          sessionId, generation: row.generation, createdBy: principal.id, clientEventId,
          refType: ref.type, refId: ref.id, refVersion: ref.version, selectedThoughtIds: ids,
        }).onConflictDoNothing({ target: [presentations.sessionId, presentations.createdBy, presentations.clientEventId] }).returning();
        if (inserted) return;
        const [existing] = await tx.select().from(presentations).where(and(
          eq(presentations.sessionId, sessionId), eq(presentations.createdBy, principal.id),
          eq(presentations.clientEventId, clientEventId),
        ));
        if (!existing || existing.refType !== ref.type || existing.refId !== ref.id ||
            existing.refVersion !== ref.version || JSON.stringify(existing.selectedThoughtIds) !== JSON.stringify(ids))
          throw new ConflictError('This clientEventId was used for another presentation', 'IDEMPOTENCY_CONFLICT');
        // The core checked the source object immediately before this call. Receivers must
        // reauthorize through the ordinary object API because a source can change later.
      });
    },
  };
}
