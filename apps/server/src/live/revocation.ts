import { randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { schema } from '@flux/db';
import { NotFoundError, ServiceUnavailableError, type Database, type LiveMedia } from '@flux/core';

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
export function liveRevocationCoordinator(db: Database, pool: Pool, media: LiveMedia) {
  async function locked<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(62061, hashtext($1))', [workspaceId]);
      return await work();
    } finally {
      try { await client.query('SELECT pg_advisory_unlock(62061, hashtext($1))', [workspaceId]); }
      finally { client.release(); }
    }
  }

  async function fence(scope: Scope): Promise<void> {
    await db.transaction(async (tx) => {
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

  async function retireAndFinish(scope: Scope): Promise<void> {
    const rows = await db.select({ roomId: schema.liveSessions.roomId }).from(schema.liveSessions)
      .where(and(sessionFilter(scope), eq(schema.liveSessions.state, 'rotating')));
    // DeleteRoom forcibly ejects active users. With room.auto_create=false, neither
    // original nor LiveKit-refreshed JWTs can resurrect the retired room.
    for (const row of rows) await media.deleteRoom(row.roomId);
    await db.transaction(async (tx) => {
      const current = await tx.select({ id: schema.liveSessions.id }).from(schema.liveSessions)
        .where(and(sessionFilter(scope), eq(schema.liveSessions.state, 'rotating'))).for('update');
      for (const row of current) {
        await tx.update(schema.liveSessions).set({
          roomId: `live_${randomBytes(24).toString('base64url')}`,
          generation: sql`${schema.liveSessions.generation} + 1`,
          state: 'available', updatedAt: new Date(),
        }).where(eq(schema.liveSessions.id, row.id));
      }
      await tx.delete(schema.liveAccessFences).where(eq(schema.liveAccessFences.scopeKey, key(scope)));
    });
  }

  async function recoverUnderLock(workspaceId: string): Promise<void> {
    const pending = await db.select().from(schema.liveAccessFences)
      .where(eq(schema.liveAccessFences.workspaceId, workspaceId))
      .orderBy(schema.liveAccessFences.createdAt, schema.liveAccessFences.scopeKey);
    for (const row of pending) await retireAndFinish({ workspaceId, projectId: row.projectId });
  }

  async function change<T>(scope: Scope, mutation: () => Promise<T>): Promise<T> {
    return locked(scope.workspaceId, async () => {
      await recoverUnderLock(scope.workspaceId);
      await fence(scope);
      // On failure the fence stays durable. A retry or startup reconciliation can
      // finish it; the access mutation has not yet run, so no cutoff is claimed.
      const rows = await db.select({ roomId: schema.liveSessions.roomId }).from(schema.liveSessions)
        .where(and(sessionFilter(scope), eq(schema.liveSessions.state, 'rotating')));
      for (const row of rows) await media.deleteRoom(row.roomId);
      let result: T;
      try { result = await mutation(); }
      catch (error) {
        // The mutation rolled back or failed validation. Restore admission only
        // with a fresh generation; never recreate a retired room ID.
        await retireAndFinish(scope);
        throw error;
      }
      await retireAndFinish(scope);
      return result;
    });
  }

  return {
    async withProjectChange<T>(projectId: string, mutation: () => Promise<T>): Promise<T> {
      const [project] = await db.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects)
        .where(eq(schema.projects.id, projectId));
      if (!project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      return change({ workspaceId: project.workspaceId, projectId }, mutation);
    },
    withWorkspaceChange<T>(workspaceId: string, mutation: () => Promise<T>): Promise<T> {
      return change({ workspaceId, projectId: null }, mutation);
    },
    async recoverPending(): Promise<void> {
      const pending = await db.select({ workspaceId: schema.liveAccessFences.workspaceId })
        .from(schema.liveAccessFences).groupBy(schema.liveAccessFences.workspaceId);
      for (const row of pending) await locked(row.workspaceId, () => recoverUnderLock(row.workspaceId));
    },
  };
}

export type LiveRevocationCoordinator = ReturnType<typeof liveRevocationCoordinator>;
