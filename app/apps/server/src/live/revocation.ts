import { randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { holdingSessionLock, schema, type Database } from '@flux/db';
import { NotFoundError, ServiceUnavailableError, type LiveMedia } from '@flux/core';
import type { LiveLifecycle } from './lifecycle.js';

type Scope = { workspaceId: string; projectId: string | null };
const key = (scope: Scope) => scope.projectId ? `p:${scope.projectId}` : `w:${scope.workspaceId}`;
const sessionFilter = (scope: Scope) => scope.projectId
  ? eq(schema.liveSessions.projectId, scope.projectId)
  : eq(schema.liveSessions.workspaceId, scope.workspaceId);

/**
 * No-media API replicas still serialize access changes with admission on media-enabled
 * replicas. The core mutation (and its idempotency transaction) runs under the same
 * SQL guard lock as the absence check, so a room cannot appear in between.
 */
export async function withNoMediaAccessChange<T>(db: Database, scope: Scope,
  mutation: (connection: Database) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (scope.projectId) {
      await tx.select({ id: schema.projects.id }).from(schema.projects)
        .where(eq(schema.projects.id, scope.projectId)).for('no key update');
    } else {
      await tx.select({ id: schema.workspaces.id }).from(schema.workspaces)
        .where(eq(schema.workspaces.id, scope.workspaceId)).for('no key update');
    }
    const [active] = await tx.select({ id: schema.liveSessions.id }).from(schema.liveSessions)
      .where(and(sessionFilter(scope), ne(schema.liveSessions.state, 'ended'))).limit(1);
    if (active) throw new ServiceUnavailableError(
      'Live media is not configured; access cannot change while a live session exists', 'LIVE_MEDIA_UNAVAILABLE');
    return mutation(tx as unknown as Database);
  });
}

/**
 * A durable fence precedes every external DeleteRoom call and access mutation.
 * The workspace advisory lock coordinates API replicas and startup recovery; the
 * SQL fence keeps admission closed across process crashes and SFU failures.
 */
export function liveRevocationCoordinator(db: Database, pool: Pool, media: LiveMedia,
  lifecycle?: Pick<LiveLifecycle, 'recoverWorkspaceUnderLock'>) {
  /**
   * `work` also gets `held`, a handle on the lock's own connection (#961). A lock whose connection dies is gone and the next holder may be
   * working: `work` stops at its next step (#916), and a transaction on `held` that the loss cuts off is rolled back, so this
   * coordinator's own writes never commit after the lock is gone. (A `pg_advisory_xact_lock` in a transaction on another connection
   * would wait for the session lock this very coordinator holds, so the writes go through the lock's connection instead.) The caller's
   * `mutation` is its own transaction on another connection: it is not started after the loss, and one already running commits once.
   */
  async function locked<T>(workspaceId: string, work: (signal: AbortSignal, held: Database) => Promise<T>): Promise<T> {
    return holdingSessionLock(pool, { acquire: { text: 'SELECT pg_advisory_lock(62061, hashtext($1))', values: [workspaceId] },
      release: { text: 'SELECT pg_advisory_unlock(62061, hashtext($1))', values: [workspaceId] } },
    (signal, connection) => work(signal, drizzle({ client: connection, schema })));
  }

  async function fence(scope: Scope, held: Database): Promise<void> {
    await held.transaction(async (tx) => {
      if (scope.projectId) {
        await tx.select({ id: schema.projects.id }).from(schema.projects)
          .where(and(eq(schema.projects.id, scope.projectId), eq(schema.projects.workspaceId, scope.workspaceId)))
          .for('no key update');
      } else {
        await tx.select({ id: schema.workspaces.id }).from(schema.workspaces)
          .where(eq(schema.workspaces.id, scope.workspaceId)).for('no key update');
      }
      await tx.insert(schema.liveAccessFences).values({
        scopeKey: key(scope), workspaceId: scope.workspaceId, projectId: scope.projectId,
      }).onConflictDoNothing();
      await tx.update(schema.liveSessions).set({ state: 'rotating', updatedAt: new Date() })
        .where(and(sessionFilter(scope), eq(schema.liveSessions.state, 'available')));
    });
  }

  async function retireAndFinish(scope: Scope, held: Database): Promise<void> {
    const rows = await db.select({ id: schema.liveSessions.id, roomId: schema.liveSessions.roomId }).from(schema.liveSessions)
      .where(and(sessionFilter(scope), eq(schema.liveSessions.state, 'rotating')));
    // DeleteRoom forcibly ejects active users. With room.auto_create=false, neither
    // original nor LiveKit-refreshed JWTs can resurrect the retired room.
    for (const row of rows) await media.deleteRoom(row.roomId);
    const replacement = new Map<string, string>();
    for (const row of rows) {
      const roomId = `live_${randomBytes(24).toString('base64url')}`;
      await media.ensureRoom(roomId);
      replacement.set(row.id, roomId);
    }
    await held.transaction(async (tx) => {
      const current = await tx.select({ id: schema.liveSessions.id }).from(schema.liveSessions)
        .where(and(sessionFilter(scope), eq(schema.liveSessions.state, 'rotating'))).for('update');
      for (const row of current) {
        await tx.update(schema.liveSessions).set({
          roomId: replacement.get(row.id)!,
          generation: sql`${schema.liveSessions.generation} + 1`,
          state: 'available', emptySince: new Date(), connectedOnce: false,
          lastGrantAt: null, endedAt: null, updatedAt: new Date(),
        }).where(eq(schema.liveSessions.id, row.id));
      }
      await tx.delete(schema.liveAccessFences).where(eq(schema.liveAccessFences.scopeKey, key(scope)));
    });
  }

  async function recoverUnderLock(workspaceId: string, held: Database): Promise<void> {
    const pending = await db.select().from(schema.liveAccessFences)
      .where(eq(schema.liveAccessFences.workspaceId, workspaceId))
      .orderBy(schema.liveAccessFences.createdAt, schema.liveAccessFences.scopeKey);
    for (const row of pending) await retireAndFinish({ workspaceId, projectId: row.projectId }, held);
  }

  async function recoverMissingRoom(sessionId: string): Promise<void> {
    const [located] = await db.select({ workspaceId: schema.liveSessions.workspaceId,
      projectId: schema.liveSessions.projectId }).from(schema.liveSessions)
      .where(eq(schema.liveSessions.id, sessionId));
    if (!located) throw new NotFoundError('Live session', 'LIVE_SESSION_NOT_FOUND');
    await locked(located.workspaceId, async (signal, held) => {
      await lifecycle?.recoverWorkspaceUnderLock(located.workspaceId);
      signal.throwIfAborted();
      await recoverUnderLock(located.workspaceId, held);
      signal.throwIfAborted();
      const missing = await held.transaction(async (tx) => {
        // Admission takes these guards in the same order. The SFU check stays
        // under the project guard, so a concurrent grant mutation cannot pass
        // between proof of room loss and the durable admission fence.
        await tx.select({ id: schema.workspaces.id }).from(schema.workspaces)
          .where(eq(schema.workspaces.id, located.workspaceId)).for('share');
        await tx.select({ id: schema.projects.id }).from(schema.projects)
          .where(eq(schema.projects.id, located.projectId)).for('no key update');
        const [current] = await tx.select().from(schema.liveSessions)
          .where(eq(schema.liveSessions.id, sessionId)).for('update');
        if (!current || current.state !== 'available') return false;
        try { await media.requireRoom(current.roomId); return false; }
        catch (error) {
          if (!(error instanceof ServiceUnavailableError) || error.code !== 'LIVE_ROOM_GONE') throw error;
        }
        await tx.insert(schema.liveAccessFences).values({
          scopeKey: `p:${current.projectId}`, workspaceId: current.workspaceId,
          projectId: current.projectId,
        }).onConflictDoNothing();
        await tx.update(schema.liveSessions).set({ state: 'rotating', updatedAt: new Date() })
          .where(eq(schema.liveSessions.id, sessionId));
        return true;
      });
      signal.throwIfAborted();
      if (missing) await retireAndFinish({ workspaceId: located.workspaceId, projectId: located.projectId }, held);
    });
  }

  async function change<T>(scope: Scope, mutation: () => Promise<T>): Promise<T> {
    return locked(scope.workspaceId, async (signal, held) => {
      await lifecycle?.recoverWorkspaceUnderLock(scope.workspaceId);
      signal.throwIfAborted();
      await recoverUnderLock(scope.workspaceId, held);
      // From here every step is one the lock protects: if its connection is lost, the next holder may be doing them (#916).
      signal.throwIfAborted();
      await fence(scope, held);
      // On failure the fence stays durable. A retry or startup reconciliation can
      // finish it; the access mutation has not yet run, so no cutoff is claimed.
      const rows = await db.select({ roomId: schema.liveSessions.roomId }).from(schema.liveSessions)
        .where(and(sessionFilter(scope), eq(schema.liveSessions.state, 'rotating')));
      for (const row of rows) { signal.throwIfAborted(); await media.deleteRoom(row.roomId); }
      signal.throwIfAborted();
      let result: T;
      try { result = await mutation(); }
      catch (error) {
        // The mutation rolled back or failed validation. Restore admission only
        // with a fresh generation; never recreate a retired room ID.
        signal.throwIfAborted();
        await retireAndFinish(scope, held);
        throw error;
      }
      signal.throwIfAborted();
      await retireAndFinish(scope, held);
      return result;
    });
  }

  return {
    recoverMissingRoom,
    async withProjectChange<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
      const [project] = await db.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects)
        .where(eq(schema.projects.id, projectId));
      if (!project) throw new NotFoundError('Space', 'PROJECT_NOT_FOUND');
      return change({ workspaceId: project.workspaceId, projectId }, mutation);
    },
    withWorkspaceChange<T>(workspaceId: string, mutation: () => Promise<T>): Promise<T> {
      return change({ workspaceId, projectId: null }, mutation);
    },
    async recoverPending(): Promise<void> {
      const pending = await db.select({ workspaceId: schema.liveAccessFences.workspaceId })
        .from(schema.liveAccessFences).groupBy(schema.liveAccessFences.workspaceId);
      for (const row of pending) await locked(row.workspaceId, async (signal, held) => {
        await lifecycle?.recoverWorkspaceUnderLock(row.workspaceId);
        signal.throwIfAborted();
        await recoverUnderLock(row.workspaceId, held);
      });
    },
  };
}

export type LiveRevocationCoordinator = ReturnType<typeof liveRevocationCoordinator>;
