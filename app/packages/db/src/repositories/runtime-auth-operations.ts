import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AgentRuntimeClient } from '@flux/contracts';
import type * as schema from '../schema.js';

type Handle = Pick<NodePgDatabase<typeof schema>, 'execute' | 'transaction'>;
type Exec = Pick<NodePgDatabase<typeof schema>, 'execute'>;
export type RuntimeAuthKind = 'check' | 'logout' | 'console';
export interface RuntimeAuthActor { ownerUserId: string; sessionId: string }
/** Internal capability, never accepted from a browser or persisted as a raw session/ticket. */
export interface RuntimeAuthOperation extends RuntimeAuthActor {
  bindingId: string; client: AgentRuntimeClient; operationId: string; revision: number;
  bootId: string; kind: RuntimeAuthKind; leaseEndsAt: Date; hardEndsAt: Date;
}
export interface RuntimeAuthClaim extends RuntimeAuthActor {
  bindingId: string; client: AgentRuntimeClient; kind: RuntimeAuthKind;
  leaseMs: number; lifetimeMs: number;
  nonce?: { digest: string; expiresAt: Date };
}
export type RuntimeAuthAdmission =
  | { kind: 'claimed'; operation: RuntimeAuthOperation }
  | { kind: 'busy' | 'recovery' | 'superseded' | 'ticket_replayed' };
type OperationRow = {
  operation_id: string; revision: number; boot_id: string; actor_digest: string;
  kind: RuntimeAuthKind; phase: 'active' | 'settled' | 'uncertain';
  lease_ends_at: Date | string; hard_ends_at: Date | string; live: boolean;
};
const asDate = (value: Date | string) => value instanceof Date ? value : new Date(value);
const digest = (actor: RuntimeAuthActor) => createHash('sha256')
  .update(`flux-runtime-auth-actor-v1\n${actor.ownerUserId}\n${actor.sessionId}`).digest('hex');

/** Lock order: admission → owner → binding → slot → operation; no external wait here. */
export async function runtimeAuthAdmissionLock(tx: Exec) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(hashtext('agent-runtime-auth-admission'))`);
  const gate = await tx.execute<{ blocked: boolean }>(sql`SELECT blocked FROM agent_runtime_auth_admission WHERE singleton`);
  return gate.rows[0]?.blocked === false;
}
async function ownerLock(tx: Exec, ownerUserId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-runtime-owner:${ownerUserId}`}))`);
}
async function currentBinding(tx: Exec, actor: RuntimeAuthActor, bindingId: string) {
  const binding = await tx.execute<{ slot: string }>(sql`SELECT slot FROM agent_runtime_bindings
    WHERE id = ${bindingId} AND owner_user_id = ${actor.ownerUserId} AND state = 'active' FOR UPDATE`);
  if (!binding.rows[0]) return null;
  const slot = await tx.execute<{ boot_id: string | null }>(sql`SELECT boot_id FROM agent_runtime_slots
    WHERE slot = ${binding.rows[0].slot} FOR UPDATE`);
  // Lock the current session record, not its cookie/token. Only its digest is persisted.
  const session = await tx.execute<{ id: string }>(sql`SELECT id FROM auth_sessions
    WHERE id = ${actor.sessionId} AND user_id = ${actor.ownerUserId} AND expires_at > clock_timestamp() FOR SHARE`);
  return session.rows[0] && slot.rows[0]?.boot_id ? slot.rows[0].boot_id : null;
}
async function operationRow(tx: Exec, bindingId: string, client: AgentRuntimeClient) {
  const rows = await tx.execute<OperationRow>(sql`SELECT operation_id, revision, boot_id, actor_digest, kind, phase,
    lease_ends_at, hard_ends_at, lease_ends_at > clock_timestamp() AND hard_ends_at > clock_timestamp() AS live
    FROM agent_runtime_auth_operations WHERE binding_id = ${bindingId} AND client = ${client} FOR UPDATE`);
  return rows.rows[0] ?? null;
}
const sameOperation = (row: OperationRow | null, operation: RuntimeAuthOperation) => Boolean(row
  && row.operation_id === operation.operationId && row.revision === operation.revision && row.boot_id === operation.bootId
  && row.kind === operation.kind && row.actor_digest === digest(operation));

/** Uncertain work is never leased to another command on this binding. Recycle the whole slot. */
async function recoverBinding(tx: Exec, ownerUserId: string, bindingId: string) {
  await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'releasing', release_reason = 'auth_recovery',
    release_requested_at = clock_timestamp() WHERE id = ${bindingId} AND owner_user_id = ${ownerUserId}
    AND state IN ('active', 'sign_in_again')`);
  await tx.execute(sql`UPDATE agent_runtime_auth_operations SET phase = 'uncertain', settled_at = NULL
    WHERE binding_id = ${bindingId} AND phase = 'active'`);
  await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL,
    revoked_at = coalesce(revoked_at, clock_timestamp()) WHERE binding_id = ${bindingId} AND revoked_at IS NULL`);
}

/** Called inside the connection update's transaction; settlement and display facts commit together. */
export async function currentRuntimeAuthOperation(tx: Exec, operation: RuntimeAuthOperation) {
  if (!await runtimeAuthAdmissionLock(tx)) return false;
  await ownerLock(tx, operation.ownerUserId);
  const boot = await currentBinding(tx, operation, operation.bindingId);
  const row = await operationRow(tx, operation.bindingId, operation.client);
  return boot === operation.bootId && sameOperation(row, operation) && row!.phase === 'active' && row!.live;
}
export async function settleRuntimeAuthOperation(tx: Exec, operation: RuntimeAuthOperation) {
  const settled = await tx.execute(sql`UPDATE agent_runtime_auth_operations SET phase = 'settled', settled_at = clock_timestamp()
    WHERE binding_id = ${operation.bindingId} AND client = ${operation.client} AND operation_id = ${operation.operationId}
    AND revision = ${operation.revision} AND boot_id = ${operation.bootId} AND actor_digest = ${digest(operation)}
    AND kind = ${operation.kind} AND phase = 'active' AND lease_ends_at > clock_timestamp() AND hard_ends_at > clock_timestamp()
    AND EXISTS (SELECT 1 FROM agent_runtime_bindings b JOIN agent_runtime_slots s ON s.slot = b.slot
      WHERE b.id = ${operation.bindingId} AND b.owner_user_id = ${operation.ownerUserId} AND b.state = 'active' AND s.boot_id = ${operation.bootId})
    AND EXISTS (SELECT 1 FROM auth_sessions WHERE id = ${operation.sessionId} AND user_id = ${operation.ownerUserId}
      AND expires_at > clock_timestamp())
    AND EXISTS (SELECT 1 FROM agent_runtime_auth_admission WHERE singleton AND NOT blocked)
    RETURNING operation_id`);
  // The caller must let this escape its transaction, rolling display updates back
  // as well. Lease/session wall time may have elapsed after the initial row lock.
  if (!settled.rows.length) throw new RuntimeAuthSupersededError();
}
export class RuntimeAuthSupersededError extends Error {
  constructor() { super('Runtime auth operation superseded before settlement'); this.name = 'RuntimeAuthSupersededError'; }
}

export function runtimeAuthOperations(db: Handle) {
  return {
    claim(input: RuntimeAuthClaim): Promise<RuntimeAuthAdmission> {
      if (!Number.isInteger(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > 120_000
        || !Number.isInteger(input.lifetimeMs) || input.lifetimeMs < input.leaseMs || input.lifetimeMs > 15 * 60_000
        || (input.kind === 'console') !== Boolean(input.nonce)
        || (input.nonce && !/^[0-9a-f]{64}$/.test(input.nonce.digest))) {
        throw new Error('Invalid internal runtime auth admission');
      }
      return db.transaction(async (tx) => {
        if (!await runtimeAuthAdmissionLock(tx)) return { kind: 'superseded' as const };
        await ownerLock(tx, input.ownerUserId);
        const bootId = await currentBinding(tx, input, input.bindingId);
        if (!bootId) return { kind: 'superseded' as const };
        if (input.nonce) {
          const used = await tx.execute(sql`SELECT 1 FROM agent_runtime_console_nonces WHERE nonce_digest = ${input.nonce.digest}`);
          if (used.rows.length) return { kind: 'ticket_replayed' as const };
        }
        // Uncertainty for either client blocks this entire binding, not just a row.
        const uncertain = await tx.execute(sql`SELECT 1 FROM agent_runtime_auth_operations
          WHERE binding_id = ${input.bindingId} AND (phase = 'uncertain' OR (phase = 'active' AND lease_ends_at <= clock_timestamp()))`);
        if (uncertain.rows.length) {
          await recoverBinding(tx, input.ownerUserId, input.bindingId);
          return { kind: 'recovery' as const };
        }
        const previous = await operationRow(tx, input.bindingId, input.client);
        if (previous?.phase === 'active') {
          if (input.kind === 'logout') {
            // The owner may always restrict their runtime. Without a proved drain
            // acknowledgement, sign-out cannot replace the in-flight command.
            await recoverBinding(tx, input.ownerUserId, input.bindingId);
            return { kind: 'recovery' as const };
          }
          return { kind: 'busy' as const };
        }
        if (previous?.revision === 2_147_483_647) {
          await recoverBinding(tx, input.ownerUserId, input.bindingId);
          return { kind: 'recovery' as const };
        }
        const operationId = randomUUID();
        const revision = (previous?.revision ?? 0) + 1;
        const rows = await tx.execute<OperationRow>(sql`INSERT INTO agent_runtime_auth_operations
          (binding_id, client, owner_user_id, operation_id, revision, boot_id, actor_digest, kind, phase,
            claimed_at, lease_ends_at, hard_ends_at, settled_at)
          VALUES (${input.bindingId}, ${input.client}, ${input.ownerUserId}, ${operationId}, ${revision}, ${bootId}, ${digest(input)},
            ${input.kind}, 'active', clock_timestamp(), clock_timestamp() + ${input.leaseMs} * interval '1 millisecond',
            clock_timestamp() + ${input.lifetimeMs} * interval '1 millisecond', NULL)
          ON CONFLICT (binding_id, client) DO UPDATE SET operation_id = excluded.operation_id, revision = excluded.revision,
            boot_id = excluded.boot_id, actor_digest = excluded.actor_digest, kind = excluded.kind, phase = 'active',
            claimed_at = excluded.claimed_at, lease_ends_at = excluded.lease_ends_at, hard_ends_at = excluded.hard_ends_at, settled_at = NULL
          RETURNING operation_id, revision, boot_id, actor_digest, kind, phase, lease_ends_at, hard_ends_at, true AS live`);
        if (input.nonce) {
          const consumed = await tx.execute(sql`INSERT INTO agent_runtime_console_nonces
            (nonce_digest, owner_user_id, actor_digest, operation_id, expires_at)
            SELECT ${input.nonce.digest}, ${input.ownerUserId}, ${digest(input)}, ${operationId}, ${input.nonce.expiresAt.toISOString()}::timestamptz
            WHERE ${input.nonce.expiresAt.toISOString()}::timestamptz > clock_timestamp()
            ON CONFLICT DO NOTHING RETURNING nonce_digest`);
          if (!consumed.rows.length) {
            // Throwing rolls the claim back too; an expired nonce grants no operation.
            throw new Error('Runtime console nonce expired or already consumed');
          }
        }
        if (input.kind === 'logout') {
          await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL
            WHERE binding_id = ${input.bindingId} AND owner_user_id = ${input.ownerUserId} AND client = ${input.client} AND revoked_at IS NULL`);
        }
        const row = rows.rows[0]!;
        return { kind: 'claimed' as const, operation: { ownerUserId: input.ownerUserId, sessionId: input.sessionId,
          bindingId: input.bindingId, client: input.client, operationId, revision, bootId, kind: input.kind,
          leaseEndsAt: asDate(row.lease_ends_at), hardEndsAt: asDate(row.hard_ends_at) } };
      });
    },
    renew(operation: RuntimeAuthOperation, leaseMs: number): Promise<boolean> {
      if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120_000) throw new Error('Invalid runtime auth renewal');
      return db.transaction(async (tx) => {
        if (!await currentRuntimeAuthOperation(tx, operation)) return false;
        const renewed = await tx.execute(sql`UPDATE agent_runtime_auth_operations SET lease_ends_at = least(hard_ends_at,
          clock_timestamp() + ${leaseMs} * interval '1 millisecond')
          WHERE binding_id = ${operation.bindingId} AND client = ${operation.client} AND operation_id = ${operation.operationId}
            AND revision = ${operation.revision} AND boot_id = ${operation.bootId} AND actor_digest = ${digest(operation)}
            AND kind = ${operation.kind} AND phase = 'active' AND lease_ends_at > clock_timestamp() AND hard_ends_at > clock_timestamp()
            AND EXISTS (SELECT 1 FROM auth_sessions WHERE id = ${operation.sessionId} AND user_id = ${operation.ownerUserId}
              AND expires_at > clock_timestamp())
            AND EXISTS (SELECT 1 FROM agent_runtime_bindings b JOIN agent_runtime_slots s ON s.slot = b.slot
              WHERE b.id = ${operation.bindingId} AND b.owner_user_id = ${operation.ownerUserId} AND b.state = 'active' AND s.boot_id = ${operation.bootId})
            AND EXISTS (SELECT 1 FROM agent_runtime_auth_admission WHERE singleton AND NOT blocked)
          RETURNING operation_id`);
        return renewed.rows.length > 0;
      });
    },
    /** Restrictive cancellation remains valid after session loss; it cannot create authority. */
    uncertain(operation: RuntimeAuthOperation): Promise<boolean> {
      return db.transaction(async (tx) => {
        await ownerLock(tx, operation.ownerUserId);
        const live = await tx.execute(sql`SELECT id FROM agent_runtime_bindings WHERE id = ${operation.bindingId}
          AND owner_user_id = ${operation.ownerUserId} AND state = 'active' FOR UPDATE`);
        const row = await operationRow(tx, operation.bindingId, operation.client);
        if (!live.rows.length || !sameOperation(row, operation) || row!.phase !== 'active') return false;
        await recoverBinding(tx, operation.ownerUserId, operation.bindingId);
        return true;
      });
    },
    /** Existing worker reconciliation consumes these release requests; no new scheduler or TTL takeover. */
    async recoverAbandoned(): Promise<number> {
      const rows = await db.execute<{ owner_user_id: string; binding_id: string }>(sql`SELECT DISTINCT owner_user_id, binding_id
        FROM agent_runtime_auth_operations WHERE phase = 'uncertain' OR (phase = 'active' AND lease_ends_at <= clock_timestamp())
        LIMIT 100`);
      let recovered = 0;
      for (const row of rows.rows) {
        recovered += await db.transaction(async (tx) => {
          await ownerLock(tx, row.owner_user_id);
          const binding = await tx.execute(sql`SELECT id FROM agent_runtime_bindings WHERE id = ${row.binding_id}
            AND owner_user_id = ${row.owner_user_id} AND state IN ('active', 'sign_in_again') FOR UPDATE`);
          if (!binding.rows.length) return 0;
          const pending = await tx.execute(sql`SELECT 1 FROM agent_runtime_auth_operations WHERE binding_id = ${row.binding_id}
            AND (phase = 'uncertain' OR (phase = 'active' AND lease_ends_at <= clock_timestamp())) FOR UPDATE`);
          if (!pending.rows.length) return 0;
          await recoverBinding(tx, row.owner_user_id, row.binding_id);
          return 1;
        });
      }
      return recovered;
    },
    /** Operator-only through the launcher's existing database tooling, never an HTTP grant. */
    beginPurge(): Promise<string> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-runtime-auth-admission'))`);
        const current = await tx.execute<{ purge_id: string | null }>(sql`SELECT purge_id FROM agent_runtime_auth_admission WHERE singleton FOR UPDATE`);
        if (current.rows[0]?.purge_id) return current.rows[0].purge_id;
        const purgeId = randomUUID();
        await tx.execute(sql`UPDATE agent_runtime_auth_admission SET blocked = true, purge_id = ${purgeId}, changed_at = clock_timestamp() WHERE singleton`);
        await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'releasing', release_reason = 'purge',
          release_requested_at = clock_timestamp() WHERE state IN ('binding', 'active', 'sign_in_again')`);
        await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL,
          revoked_at = coalesce(revoked_at, clock_timestamp()) WHERE revoked_at IS NULL`);
        return purgeId;
      });
    },
    /** Caller must first prove physical cleanup; an error never opens the gate. */
    finishPurge(purgeId: string, cleanupConfirmed: boolean): Promise<boolean> {
      if (!cleanupConfirmed) return Promise.resolve(false);
      return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-runtime-auth-admission'))`);
        const updated = await tx.execute(sql`UPDATE agent_runtime_auth_admission SET blocked = false, purge_id = NULL,
          changed_at = clock_timestamp() WHERE singleton AND blocked AND purge_id = ${purgeId} RETURNING singleton`);
        return updated.rows.length > 0;
      });
    },
  };
}
