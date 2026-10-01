import { and, asc, eq, gt, inArray, lt, lte, or } from 'drizzle-orm';
import type { Pool } from 'pg';
import { schema } from '@flux/db';
import type { Database, LiveMedia } from '@flux/core';

const NEVER_JOINED_GRACE_MS = 300_000;
const DEPARTED_GRACE_MS = 90_000;

export type LiveReconcileResult = 'occupied' | 'empty' | 'ending' | 'ended' | 'unknown' | 'stale';

/**
 * Reconciles durable Flux state against authoritative SFU presence. Webhooks are
 * hints only; this also runs on a bounded timer and during startup recovery.
 */
export function liveLifecycle(db: Database, pool: Pool,
  media: Pick<LiveMedia, 'occupancy' | 'deleteRoom'>,
  now: () => Date = () => new Date()) {
  const sessions = schema.liveSessions;
  let sweepAfter: { updatedAt: Date; id: string } | null = null;

  // This is the same workspace advisory key and lock order as access revocation.
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

  async function finishEndingLocked(sessionId: string): Promise<LiveReconcileResult> {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!row || row.state === 'ended') return 'ended';
    if (row.state !== 'ending') return 'stale';
    // DeleteRoom confirms the old room is absent. Keep the durable ending fence
    // if the SFU cannot confirm; recovery will retry after a crash or outage.
    await media.deleteRoom(row.roomId);
    await db.transaction(async (tx) => {
      await tx.select({ id: schema.projects.id }).from(schema.projects)
        .where(eq(schema.projects.id, row.projectId)).for('no key update');
      const [current] = await tx.select().from(sessions)
        .where(eq(sessions.id, sessionId)).for('update');
      if (!current || current.state !== 'ending' || current.roomId !== row.roomId || current.generation !== row.generation)
        return;
      await tx.update(sessions).set({ state: 'ended', endedAt: now(), updatedAt: now() })
        .where(eq(sessions.id, sessionId));
    });
    return 'ended';
  }

  async function reconcile(sessionId: string, expectedGeneration?: number): Promise<LiveReconcileResult> {
    const [located] = await db.select({ workspaceId: sessions.workspaceId }).from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!located) return 'stale';
    return locked(located.workspaceId, async () => {
      const result = await db.transaction(async (tx): Promise<LiveReconcileResult> => {
        const [current] = await tx.select().from(sessions).where(eq(sessions.id, sessionId));
        if (!current || current.workspaceId !== located.workspaceId ||
            (expectedGeneration !== undefined && current.generation !== expectedGeneration)) return 'stale';
        if (current.state === 'ended') return 'ended';
        if (current.state === 'ending') return 'ending';
        if (current.state !== 'available') return 'stale';

        // The project guard waits for in-flight admissions and blocks new ones
        // until occupancy has been observed and the decision committed.
        const [project] = await tx.select({ id: schema.projects.id }).from(schema.projects)
          .where(and(eq(schema.projects.id, current.projectId), eq(schema.projects.workspaceId, current.workspaceId)))
          .for('no key update');
        if (!project) return 'stale';
        const [row] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('update');
        if (!row || row.state !== 'available' || row.generation !== current.generation || row.roomId !== current.roomId)
          return 'stale';

        let occupied: number;
        try { occupied = await media.occupancy(row.roomId); }
        catch { return 'unknown'; }

        const at = now();
        if (occupied > 0) {
          await tx.update(sessions).set({ connectedOnce: true, emptySince: null, updatedAt: at })
            .where(eq(sessions.id, sessionId));
          return 'occupied';
        }
        const emptySince = row.emptySince ?? at;
        const grace = row.connectedOnce ? DEPARTED_GRACE_MS : NEVER_JOINED_GRACE_MS;
        if (at.getTime() - emptySince.getTime() < grace) {
          await tx.update(sessions).set({ emptySince, updatedAt: at }).where(eq(sessions.id, sessionId));
          return 'empty';
        }
        // This commit is the durable admission fence. Never call external
        // DeleteRoom before it, even if the room appears empty right now.
        await tx.update(sessions).set({ state: 'ending', emptySince, updatedAt: at })
          .where(eq(sessions.id, sessionId));
        return 'ending';
      });
      if (result === 'ending') return finishEndingLocked(sessionId);
      return result;
    });
  }

  async function sweep(limit = 32): Promise<void> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid live lifecycle sweep limit');
    // Rotate through the ordered active set. A room whose SFU stays unavailable
    // keeps its updatedAt, so always selecting the oldest rows would starve every
    // session behind the first page indefinitely.
    const position = sweepAfter === null ? undefined : or(
      gt(sessions.updatedAt, sweepAfter.updatedAt),
      and(eq(sessions.updatedAt, sweepAfter.updatedAt), gt(sessions.id, sweepAfter.id)),
    );
    const rows = await db.select({ id: sessions.id, updatedAt: sessions.updatedAt }).from(sessions)
      .where(and(inArray(sessions.state, ['available', 'ending']), position))
      .orderBy(asc(sessions.updatedAt), asc(sessions.id)).limit(limit);
    if (rows.length < limit && sweepAfter !== null) {
      const wrap = await db.select({ id: sessions.id, updatedAt: sessions.updatedAt }).from(sessions)
        .where(and(inArray(sessions.state, ['available', 'ending']), or(
          lt(sessions.updatedAt, sweepAfter.updatedAt),
          and(eq(sessions.updatedAt, sweepAfter.updatedAt), lte(sessions.id, sweepAfter.id)),
        )))
        .orderBy(asc(sessions.updatedAt), asc(sessions.id)).limit(limit - rows.length);
      rows.push(...wrap);
    }
    if (rows.length) sweepAfter = rows[rows.length - 1]!;
    // Reconcile holds one pool client for the workspace lock and another for
    // its transaction. Launching a full page at once can exhaust the pool.
    let failed: { reason: unknown } | null = null;
    for (const row of rows) {
      try { await reconcile(row.id); }
      catch (reason) { failed ??= { reason }; }
    }
    if (failed) throw failed.reason;
  }

  async function recoverPending(): Promise<void> {
    const rows = await db.select({ id: sessions.id }).from(sessions)
      .where(eq(sessions.state, 'ending')).orderBy(asc(sessions.updatedAt), asc(sessions.id));
    let failed: { reason: unknown } | null = null;
    for (const row of rows) {
      try { await reconcile(row.id); }
      catch (reason) { failed ??= { reason }; }
    }
    if (failed) throw failed.reason;
  }

  /** Caller must already hold pg_advisory_lock(62061, hashtext(workspaceId)).
   * Revocation uses this before changing access, so an old ending room cannot
   * retain a usable token after the access mutation commits. */
  async function recoverWorkspaceUnderLock(workspaceId: string): Promise<void> {
    const rows = await db.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.state, 'ending')))
      .orderBy(asc(sessions.updatedAt), asc(sessions.id));
    for (const row of rows) await finishEndingLocked(row.id);
  }

  return { reconcile, sweep, recoverPending, recoverWorkspaceUnderLock };
}

export type LiveLifecycle = ReturnType<typeof liveLifecycle>;
