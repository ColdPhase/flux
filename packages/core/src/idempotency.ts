import { createHash, randomUUID } from 'node:crypto';
import { and, eq, lte, sql } from 'drizzle-orm';
import { schema } from '@flux/db';
import { InvalidInputError, RuleViolationError } from './access/errors.js';
import { principalKey } from './events.js';
import type { Database, Principal } from './types.js';

/** Stored responses are replayed for this long; the worker deletes expired keys hourly. */
export const IDEMPOTENCY_RETENTION_HOURS = 24;
export const IDEMPOTENCY_CLEANUP_JOB = 'idempotency.cleanup.v1';
const KEY = /^[\x21-\x7e]{1,255}$/;

export interface IdempotencyScope {
  principal: Principal;
  /** The workspace the command acts in, or null for commands outside a workspace. */
  workspaceId: string | null;
  /** Stable operation name, e.g. `POST /api/v1/drafts/:draftId/share`. */
  operation: string;
  key: string;
  /** Hash of everything that defines the request (see {@link requestHash}). */
  requestHash: string;
}

export interface CommandResponse {
  status: number;
  body: unknown;
  etag?: string | null;
}

export interface IdempotentResponse extends CommandResponse {
  replayed: boolean;
}

export function parseIdempotencyKey(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !KEY.test(value)) throw new InvalidInputError('Idempotency-Key must be 1–255 visible ASCII characters', 'INVALID_IDEMPOTENCY_KEY');
  return value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
  }
  return value;
}

/** SHA-256 of the canonical JSON form (object keys sorted) of a request description. */
export function requestHash(request: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(request) ?? null)).digest('hex');
}

/**
 * Runs a command at most once per idempotency scope. The command runs inside this
 * transaction (domain methods nest a savepoint), and its successful response is stored in
 * the same commit, so a crash cannot leave a change without its key or vice versa.
 * A concurrent request with the same scope waits for the first and then replays it.
 * Failed commands store nothing and roll back, so a retry runs again.
 */
export async function runIdempotent(db: Database, scope: IdempotencyScope, run: (tx: Database) => Promise<CommandResponse>): Promise<IdempotentResponse> {
  const principal = principalKey(scope.principal);
  const k = schema.idempotencyKeys;
  const match = and(
    eq(k.principal, principal),
    sql`coalesce(${k.workspaceId}, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${scope.workspaceId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
    eq(k.operation, scope.operation),
    eq(k.key, scope.key),
  );
  return db.transaction(async (tx) => {
    const lockKey = JSON.stringify([principal, scope.workspaceId, scope.operation, scope.key]);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const [existing] = await tx.select().from(k).where(match);
    if (existing && existing.expiresAt.getTime() <= Date.now()) {
      await tx.delete(k).where(eq(k.id, existing.id));
    } else if (existing) {
      if (existing.requestHash !== scope.requestHash) throw new RuleViolationError('This Idempotency-Key was already used for a different request', 'IDEMPOTENCY_KEY_REUSED');
      return { status: existing.responseStatus, body: existing.responseBody, etag: existing.responseEtag, replayed: true };
    }
    const response = await run(tx);
    if (response.status >= 200 && response.status < 300) {
      await tx.insert(k).values({
        id: randomUUID(), principal, workspaceId: scope.workspaceId, operation: scope.operation, key: scope.key,
        requestHash: scope.requestHash, responseStatus: response.status, responseBody: response.body ?? null,
        responseEtag: response.etag ?? null, expiresAt: sql`now() + make_interval(hours => ${IDEMPOTENCY_RETENTION_HOURS})`,
      });
    }
    return { ...response, replayed: false };
  });
}

/** Deletes expired idempotency keys; run hourly by the worker. Returns the number deleted. */
export async function deleteExpiredIdempotencyKeys(db: Database): Promise<number> {
  const deleted = await db.delete(schema.idempotencyKeys).where(lte(schema.idempotencyKeys.expiresAt, sql`now()`)).returning({ id: schema.idempotencyKeys.id });
  return deleted.length;
}
