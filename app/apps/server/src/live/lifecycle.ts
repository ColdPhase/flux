import { and, asc, eq, gt, inArray, lt, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { holdingSessionLock, schema, type Database } from '@flux/db';
import type { LiveMedia } from '@flux/core';
import { recordLiveChanged } from './events.js';

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
  async function locked<T>(workspaceId: string, work: (signal: AbortSignal, held: Database) => Promise<T>): Promise<T> {
    // A lock whose connection dies is gone, and the next holder may be working: `work` stops at its next step (#916). `held` is a handle
    // on the lock's own connection: a write that must not commit after the lock is lost goes through it (#961, #975).
    return holdingSessionLock(pool, { acquire: { text: 'SELECT pg_advisory_lock(62061, hashtext($1))', values: [workspaceId] },
      release: { text: 'SELECT pg_advisory_unlock(62061, hashtext($1))', values: [workspaceId] } },
    (signal, connection) => work(signal, drizzle({ client: connection, schema })));
  }

  /** Ends a session whose room is being removed. The caller holds the workspace lock; the write that ends it goes through `held`, the lock's own connection. */
  async function finishEndingLocked(sessionId: string, held: Database): Promise<LiveReconcileResult> {
    const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
    if (!row || row.state === 'ended') return 'ended';
    if (row.state !== 'ending') return 'stale';
    // DeleteRoom confirms the old room is absent. Keep the durable ending fence
    // if the SFU cannot confirm; recovery will retry after a crash or outage.
    await media.deleteRoom(row.roomId);
    await held.transaction(async (tx) => {
      await tx.select({ id: schema.projects.id }).from(schema.projects)
        .where(eq(schema.projects.id, row.projectId)).for('no key update');
      const [current] = await tx.select().from(sessions)
        .where(eq(sessions.id, sessionId)).for('update');
      if (!current || current.state !== 'ending' || current.roomId !== row.roomId || current.generation !== row.generation)
        return;
      await tx.update(sessions).set({ state: 'ended', endedAt: now(), updatedAt: now() })
        .where(eq(sessions.id, sessionId));
      // Join leaves the space's open tabs at once (#1175).
      await recordLiveChanged(tx, { workspaceId: current.workspaceId, projectId: current.projectId, sessionId,
        actor: { kind: 'human', id: current.createdBy } });
    });
    return 'ended';
  }

  /**
   * `announce`: the SFU said someone joined or left (a webhook), so the space's open tabs are told to read who is in the call again
   * (#1175). The timer's sweep keeps the lifecycle only and announces nothing.
   */
  async function reconcile(sessionId: string, expectedGeneration?: number, options: { announce?: boolean } = {}): Promise<LiveReconcileResult> {
    const [located] = await db.select({ workspaceId: sessions.workspaceId }).from(sessions)
      .where(eq(sessions.id, sessionId));
    if (!located) return 'stale';
    return locked(located.workspaceId, async (signal, held) => {
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
        // Last in the transaction: the event's insert holds the sequence lock to commit.
        const announce = () => options.announce ? recordLiveChanged(tx, { workspaceId: row.workspaceId, projectId: row.projectId,
          sessionId, actor: { kind: 'human', id: row.createdBy } }) : undefined;
        if (occupied > 0) {
          await tx.update(sessions).set({ connectedOnce: true, emptySince: null, updatedAt: at })
            .where(eq(sessions.id, sessionId));
          await announce();
          return 'occupied';
        }
        const emptySince = row.emptySince ?? at;
        const grace = row.connectedOnce ? DEPARTED_GRACE_MS : NEVER_JOINED_GRACE_MS;
        if (at.getTime() - emptySince.getTime() < grace) {
          await tx.update(sessions).set({ emptySince, updatedAt: at }).where(eq(sessions.id, sessionId));
          await announce();
          return 'empty';
        }
        // This commit is the durable admission fence. Never call external
        // DeleteRoom before it, even if the room appears empty right now.
        await tx.update(sessions).set({ state: 'ending', emptySince, updatedAt: at })
          .where(eq(sessions.id, sessionId));
        return 'ending';
      });
      // Deleting the room is the step the lock protects; if its connection was lost meanwhile, the next holder decides (#916).
      signal.throwIfAborted();
      if (result === 'ending') return finishEndingLocked(sessionId, held);
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

  /** Caller must already hold pg_advisory_lock(62061, hashtext(workspaceId)), and passes `held`, the handle on that lock's own connection,
   * so the write that ends a session cannot commit after the lock is lost (#961, #975).
   * Revocation uses this before changing access, so an old ending room cannot
   * retain a usable token after the access mutation commits. */
  async function recoverWorkspaceUnderLock(workspaceId: string, held: Database): Promise<void> {
    const rows = await db.select({ id: sessions.id }).from(sessions)
      .where(and(eq(sessions.workspaceId, workspaceId), eq(sessions.state, 'ending')))
      .orderBy(asc(sessions.updatedAt), asc(sessions.id));
    for (const row of rows) await finishEndingLocked(row.id, held);
  }

  return { reconcile, sweep, recoverPending, recoverWorkspaceUnderLock };
}

export type LiveLifecycle = ReturnType<typeof liveLifecycle>;
