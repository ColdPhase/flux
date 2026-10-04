import { createHash } from 'node:crypto';
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

/** Where a key is stored: the principal's stable key (`kind:id`), workspace, operation and key. */
export interface IdempotencyKeyScope {
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

/**
 * Key storage for one command transaction (#86). `lock` serializes requests with the same scope
 * until the transaction ends, so the lookup that follows sees the first request's commit.
 */
export interface IdempotencyStore {
  lock(scope: IdempotencyKeyScope): Promise<void>;
  find(scope: IdempotencyKeyScope): Promise<StoredIdempotencyKey | null>;
  delete(id: string): Promise<void>;
  /** Stores a successful response for `retentionHours` from the transaction's time. */
  save(scope: IdempotencyKeyScope, requestHash: string, response: { status: number; body: unknown; etag: string | null }, retentionHours: number): Promise<void>;
  deleteExpired(): Promise<number>;
}

/** The store bound to a command's transaction. */
export type IdempotencyStores = (tx: Database) => IdempotencyStore;

/**
 * Re-authorizes a stored response before it is replayed: it must throw the normal
 * NotFoundError/ForbiddenError when the caller can no longer read the object the stored
 * response describes. It runs inside the replay transaction with current rows.
 */
export type ReplayAuthorization = (stored: CommandResponse, tx: Database) => Promise<void>;

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
 *
 * A stored response is replayed only after `authorizeReplay` confirms that the caller can
 * still read what it describes; otherwise the caller gets the same 404/403 as any request
 * for an object it cannot see, and the stored body is never returned.
 */
export async function runIdempotent(db: Database, stores: IdempotencyStores, scope: IdempotencyScope, run: (tx: Database) => Promise<CommandResponse>, authorizeReplay: ReplayAuthorization): Promise<IdempotentResponse> {
  const keyScope: IdempotencyKeyScope = { principal: principalKey(scope.principal), workspaceId: scope.workspaceId, operation: scope.operation, key: scope.key };
  return db.transaction(async (tx) => {
    const store = stores(tx);
    await store.lock(keyScope);
    const existing = await store.find(keyScope);
    if (existing && existing.expiresAt.getTime() <= Date.now()) {
      await store.delete(existing.id);
    } else if (existing) {
      if (existing.requestHash !== scope.requestHash) throw new RuleViolationError('This Idempotency-Key was already used for a different request', 'IDEMPOTENCY_KEY_REUSED');
      const stored: CommandResponse = existing.response;
      await authorizeReplay(stored, tx as unknown as Database);
      return { ...stored, replayed: true };
    }
    const response = await run(tx);
    if (response.status >= 200 && response.status < 300) {
      await store.save(keyScope, scope.requestHash, { status: response.status, body: response.body ?? null, etag: response.etag ?? null }, IDEMPOTENCY_RETENTION_HOURS);
    }
    return { ...response, replayed: false };
  });
}

/** Deletes expired idempotency keys; run hourly by the worker. Returns the number deleted. */
export async function deleteExpiredIdempotencyKeys(store: Pick<IdempotencyStore, 'deleteExpired'>): Promise<number> {
  return store.deleteExpired();
}
