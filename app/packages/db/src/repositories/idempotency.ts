import { randomUUID } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Drizzle adapter for idempotency keys (issues #46, #86). It satisfies core's `IdempotencyStore`
 * port structurally; core decides expiry, reuse and replay. Bind it to the command's transaction:
 * `lock` takes a transaction-scoped advisory lock, so a concurrent request with the same key waits
 * for the first one's commit before it looks the key up.
 */
const k = schema.idempotencyKeys;
const NO_WORKSPACE = '00000000-0000-0000-0000-000000000000';

export interface IdempotencyKeyScope {
  /** The principal's stable key (`kind:id`). */
  principal: string;
  workspaceId: string | null;
  operation: string;
  key: string;
}

export interface StoredIdempotencyKey {
  id: string;
  requestHash: string;
  expiresAt: Date;
  response: { status: number; body: unknown; etag: string | null };
}

const match = (scope: IdempotencyKeyScope) => and(
  eq(k.principal, scope.principal),
  // Commands outside a workspace (null) match each other, not every workspace.
  sql`coalesce(${k.workspaceId}, ${NO_WORKSPACE}::uuid) = coalesce(${scope.workspaceId}::uuid, ${NO_WORKSPACE}::uuid)`,
  eq(k.operation, scope.operation),
  eq(k.key, scope.key),
);

export function idempotencyRepository(db: DbExecutor) {
  return {
    /** Holds the scope's advisory lock until the enclosing transaction ends. */
    async lock(scope: IdempotencyKeyScope): Promise<void> {
      const lockKey = JSON.stringify([scope.principal, scope.workspaceId, scope.operation, scope.key]);
      await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    },
    async find(scope: IdempotencyKeyScope): Promise<StoredIdempotencyKey | null> {
      const [row] = await db.select().from(k).where(match(scope));
      return row ? { id: row.id, requestHash: row.requestHash, expiresAt: row.expiresAt,
        response: { status: row.responseStatus, body: row.responseBody, etag: row.responseEtag } } : null;
    },
    async delete(id: string): Promise<void> {
      await db.delete(k).where(eq(k.id, id));
    },
    /** Stores a response, kept for `retentionHours` from the transaction's time. */
    async save(scope: IdempotencyKeyScope, requestHash: string, response: { status: number; body: unknown; etag: string | null }, retentionHours: number): Promise<void> {
      await db.insert(k).values({
        id: randomUUID(), principal: scope.principal, workspaceId: scope.workspaceId, operation: scope.operation, key: scope.key,
        requestHash, responseStatus: response.status, responseBody: response.body, responseEtag: response.etag,
        expiresAt: sql`now() + make_interval(hours => ${retentionHours})`,
      });
    },
    /** Deletes every expired key; returns how many were deleted. */
    async deleteExpired(): Promise<number> {
      const deleted = await db.delete(k).where(lte(k.expiresAt, sql`now()`)).returning({ id: k.id });
      return deleted.length;
    },
  };
}
