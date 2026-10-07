import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AgentRuntimeBindingState, AgentRuntimeClient, AgentRuntimeConnectionState, AgentRuntimeReleaseReason, AgentRuntimeSignInMethod } from '@flux/contracts';
import type { Pool } from 'pg';
import type * as schema from '../schema.js';

// PostgreSQL adapter of the `runtime` transport's store (F-022 T3, migration 0056; sign-in T4, 0057).
// Each method is one short transaction; the use cases call runtime-manager only between them, never
// inside one.

// Structurally core's AgentRuntimeStore port (@flux/core agent-runtime/ports.ts); @flux/db cannot import
// @flux/core, which depends on it. The API and worker pass this adapter where the port is expected.
export type RuntimeSlotState = 'unknown' | 'ready' | 'held' | 'wiping' | 'out_of_pool';
export type RuntimeOutOfPoolReason = 'data_not_empty' | 'release_failed' | 'missing';
export interface RuntimeSlotRow { slot: string; state: RuntimeSlotState; bootId: string | null; wipeBootId: string | null; outOfPoolReason: RuntimeOutOfPoolReason | null }
export interface RuntimeBindingRow {
  id: string; ownerUserId: string; slot: string; state: AgentRuntimeBindingState; createdAt: Date; lastUsedAt: Date | null;
  releaseReason: AgentRuntimeReleaseReason | null;
}
type ReserveOutcome = { kind: 'reserved' | 'existing'; binding: RuntimeBindingRow } | { kind: 'full' } | { kind: 'starting' };
export interface RuntimeConnectionRow {
  client: AgentRuntimeClient; bindingId: string; state: AgentRuntimeConnectionState; signInMethod: AgentRuntimeSignInMethod | null;
  authMethod: string | null; plan: string | null; accountLabel: string | null; signedInAt: Date | null;
  accountChangedAt: Date | null; previousAccountLabel: string | null; signedOutAt: Date | null; signOutFailed: boolean | null;
}
export interface RuntimeSignInRecord {
  ownerUserId: string; bindingId: string; client: AgentRuntimeClient; method: AgentRuntimeSignInMethod | null; signedIn: boolean;
  facts: { authMethod: string; plan: string | null; accountLabel: string | null } | null; fingerprint: string | null;
}
export interface AgentRuntimeRows {
  ownerView(ownerUserId: string): Promise<{
    binding: RuntimeBindingRow | null;
    lastRelease: { reason: AgentRuntimeReleaseReason; at: Date; signOutFailed: boolean } | null;
    slots: { ready: number; held: number; total: number };
    commercialTerms: { agreedOn: string; recordedAt: Date } | null;
  }>;
  reserve(ownerUserId: string, bindingId: string): Promise<ReserveOutcome>;
  activate(bindingId: string): Promise<void>;
  abandon(bindingId: string, slot: { state: 'unknown' } | { state: 'out_of_pool'; reason: RuntimeOutOfPoolReason }): Promise<void>;
  requestRelease(target: { ownerUserId: string } | { slot: string }, reason: AgentRuntimeReleaseReason): Promise<RuntimeBindingRow | null>;
  recordCommercialTerms(agreedOn: string): Promise<void>;
  connections(ownerUserId: string): Promise<RuntimeConnectionRow[]>;
  recordSignIn(record: RuntimeSignInRecord): Promise<boolean>;
  recordSignOut(ownerUserId: string, bindingId: string, client: AgentRuntimeClient, failed: boolean): Promise<void>;
  dismissAccountNotice(ownerUserId: string, client: AgentRuntimeClient): Promise<void>;
  slotsWithBindings(): Promise<{ slot: RuntimeSlotRow; binding: RuntimeBindingRow | null }[]>;
  saveSlot(slot: RuntimeSlotRow): Promise<void>;
  markSignInAgain(bindingId: string): Promise<void>;
  completeRelease(bindingId: string, slot: RuntimeSlotRow, logoutFailed: boolean): Promise<void>;
  dropStaleReservation(bindingId: string, olderThan: Date): Promise<boolean>;
  idleBindings(before: Date): Promise<RuntimeBindingRow[]>;
}

type Handle = Pick<NodePgDatabase<typeof schema>, 'execute' | 'transaction'>;
type Exec = Pick<NodePgDatabase<typeof schema>, 'execute'>;

type BindingRecord = { id: string; owner_user_id: string; slot: string; state: AgentRuntimeBindingState; created_at: Date | string;
  last_used_at: Date | string | null; release_reason: AgentRuntimeReleaseReason | null };
type SlotRecord = { slot: string; state: RuntimeSlotRow['state']; boot_id: string | null; wipe_boot_id: string | null; out_of_pool_reason: RuntimeSlotRow['outOfPoolReason'] };

const date = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const binding = (row: BindingRecord): RuntimeBindingRow => ({
  id: row.id, ownerUserId: row.owner_user_id, slot: row.slot, state: row.state, createdAt: date(row.created_at),
  lastUsedAt: row.last_used_at === null ? null : date(row.last_used_at), releaseReason: row.release_reason,
});
const slotRow = (row: SlotRecord): RuntimeSlotRow => ({ slot: row.slot, state: row.state, bootId: row.boot_id, wipeBootId: row.wipe_boot_id, outOfPoolReason: row.out_of_pool_reason });

const BINDING_COLUMNS = sql`id, owner_user_id, slot, state, created_at, last_used_at, release_reason`;

type ConnectionRecord = { client: AgentRuntimeClient; binding_id: string; state: AgentRuntimeConnectionState; sign_in_method: AgentRuntimeSignInMethod | null;
  auth_method: string | null; plan_label: string | null; account_label: string | null; signed_in_at: Date | string | null;
  account_changed_at: Date | string | null; previous_account_label: string | null; signed_out_at: Date | string | null; sign_out_failed: boolean | null };
const maybeDate = (value: Date | string | null) => (value === null ? null : date(value));
const connection = (row: ConnectionRecord): RuntimeConnectionRow => ({
  client: row.client, bindingId: row.binding_id, state: row.state, signInMethod: row.sign_in_method, authMethod: row.auth_method, plan: row.plan_label,
  accountLabel: row.account_label, signedInAt: maybeDate(row.signed_in_at), accountChangedAt: maybeDate(row.account_changed_at),
  previousAccountLabel: row.previous_account_label, signedOutAt: maybeDate(row.signed_out_at), signOutFailed: row.sign_out_failed,
});
const CONNECTION_COLUMNS = sql`client, binding_id, state, sign_in_method, auth_method, plan_label, account_label, signed_in_at,
  account_changed_at, previous_account_label, signed_out_at, sign_out_failed`;

async function ownerLock(tx: Exec, ownerUserId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-runtime-owner:${ownerUserId}`}))`);
}

/** Signs the binding's connections out in Flux (the CLI's own files are deleted by the release). */
async function revokeConnections(tx: Exec, bindingId: string) {
  await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL, revoked_at = coalesce(revoked_at, now())
    WHERE binding_id = ${bindingId} AND revoked_at IS NULL`);
}

export function agentRuntimeStore(db: Handle): AgentRuntimeRows {
  return {
    async ownerView(ownerUserId) {
      const live = await db.execute<BindingRecord>(sql`SELECT ${BINDING_COLUMNS} FROM agent_runtime_bindings
        WHERE owner_user_id = ${ownerUserId} AND state <> 'released'`);
      const last = await db.execute<{ release_reason: AgentRuntimeReleaseReason; released_at: Date | string; release_logout_failed: boolean | null }>(sql`SELECT release_reason, released_at, release_logout_failed
        FROM agent_runtime_bindings WHERE owner_user_id = ${ownerUserId} AND state = 'released' AND release_reason <> 'bind_failed'
        ORDER BY released_at DESC, id LIMIT 1`);
      const counts = await db.execute<{ ready: number; held: number; total: number }>(sql`SELECT
        count(*) FILTER (WHERE s.state = 'ready' AND b.id IS NULL)::int AS ready,
        count(*) FILTER (WHERE b.id IS NOT NULL)::int AS held,
        count(*) FILTER (WHERE s.state <> 'out_of_pool' OR b.id IS NOT NULL)::int AS total
        FROM agent_runtime_slots s LEFT JOIN agent_runtime_bindings b ON b.slot = s.slot AND b.state <> 'released'`);
      const terms = await db.execute<{ agreed_on: string; recorded_at: Date | string }>(sql`SELECT agreed_on::text AS agreed_on, recorded_at
        FROM agent_runtime_operator_statements WHERE statement = 'anthropic_commercial_terms' ORDER BY recorded_at DESC LIMIT 1`);
      return {
        binding: live.rows[0] ? binding(live.rows[0]) : null,
        lastRelease: last.rows[0] ? { reason: last.rows[0].release_reason, at: date(last.rows[0].released_at), signOutFailed: last.rows[0].release_logout_failed === true } : null,
        slots: counts.rows[0] ?? { ready: 0, held: 0, total: 0 },
        commercialTerms: terms.rows[0] ? { agreedOn: terms.rows[0].agreed_on, recordedAt: date(terms.rows[0].recorded_at) } : null,
      };
    },

    reserve(ownerUserId, bindingId) {
      return db.transaction(async (tx) => {
        // Reservations are rare: one at a time, so "full" is never answered while another commits.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-runtime-reserve'))`);
        await ownerLock(tx, ownerUserId);
        const existing = await tx.execute<BindingRecord>(sql`SELECT ${BINDING_COLUMNS} FROM agent_runtime_bindings
          WHERE owner_user_id = ${ownerUserId} AND state <> 'released' FOR UPDATE`);
        if (existing.rows[0]) return { kind: 'existing' as const, binding: binding(existing.rows[0]) };
        const free = await tx.execute<{ slot: string }>(sql`SELECT s.slot FROM agent_runtime_slots s
          WHERE s.state = 'ready' AND NOT EXISTS (SELECT 1 FROM agent_runtime_bindings b WHERE b.slot = s.slot AND b.state <> 'released')
          ORDER BY length(s.slot), s.slot LIMIT 1 FOR UPDATE`);
        const slot = free.rows[0]?.slot;
        if (!slot) {
          const counts = await tx.execute<{ held: number; total: number }>(sql`SELECT
            (SELECT count(*) FROM agent_runtime_bindings WHERE state <> 'released')::int AS held,
            (SELECT count(*) FROM agent_runtime_slots WHERE state <> 'out_of_pool')::int AS total`);
          const { held, total } = counts.rows[0] ?? { held: 0, total: 0 };
          return total > 0 && held >= total ? { kind: 'full' as const } : { kind: 'starting' as const };
        }
        const inserted = await tx.execute<BindingRecord>(sql`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state)
          VALUES (${bindingId}, ${ownerUserId}, ${slot}, 'binding') RETURNING ${BINDING_COLUMNS}`);
        await tx.execute(sql`UPDATE agent_runtime_slots SET state = 'held', updated_at = now() WHERE slot = ${slot}`);
        return { kind: 'reserved' as const, binding: binding(inserted.rows[0]!) };
      });
    },

    async activate(bindingId) {
      await db.execute(sql`UPDATE agent_runtime_bindings SET state = 'active' WHERE id = ${bindingId} AND state IN ('binding', 'sign_in_again')`);
    },

    async abandon(bindingId, slot) {
      await db.transaction(async (tx) => {
        const dropped = await tx.execute<{ slot: string }>(sql`DELETE FROM agent_runtime_bindings WHERE id = ${bindingId} AND state = 'binding' RETURNING slot`);
        const name = dropped.rows[0]?.slot;
        if (!name) return;
        await tx.execute(slot.state === 'out_of_pool'
          ? sql`UPDATE agent_runtime_slots SET state = 'out_of_pool', out_of_pool_reason = ${slot.reason}, wipe_boot_id = NULL, updated_at = now() WHERE slot = ${name}`
          : sql`UPDATE agent_runtime_slots SET state = 'unknown', out_of_pool_reason = NULL, wipe_boot_id = NULL, updated_at = now() WHERE slot = ${name}`);
      });
    },

    requestRelease(target, reason) {
      return db.transaction(async (tx) => {
        const where = 'ownerUserId' in target ? sql`owner_user_id = ${target.ownerUserId}` : sql`slot = ${target.slot}`;
        if ('ownerUserId' in target) await ownerLock(tx, target.ownerUserId);
        const updated = await tx.execute<BindingRecord>(sql`UPDATE agent_runtime_bindings
          SET state = 'releasing', release_reason = ${reason}, release_requested_at = now()
          WHERE ${where} AND state IN ('binding', 'active', 'sign_in_again') RETURNING ${BINDING_COLUMNS}`);
        const row = updated.rows[0];
        if (!row) return null;
        await revokeConnections(tx, row.id);
        return binding(row);
      });
    },

    async recordCommercialTerms(agreedOn) {
      await db.execute(sql`INSERT INTO agent_runtime_operator_statements(statement, agreed_on)
        VALUES ('anthropic_commercial_terms', ${agreedOn}::date) ON CONFLICT (statement, agreed_on) DO NOTHING`);
    },

    async connections(ownerUserId) {
      const rows = await db.execute<ConnectionRecord>(sql`SELECT ${CONNECTION_COLUMNS} FROM agent_runtime_connections
        WHERE owner_user_id = ${ownerUserId} AND revoked_at IS NULL ORDER BY client`);
      return rows.rows.map(connection);
    },

    recordSignIn(record) {
      return db.transaction(async (tx) => {
        await ownerLock(tx, record.ownerUserId);
        const live = await tx.execute<{ id: string }>(sql`SELECT id FROM agent_runtime_bindings
          WHERE id = ${record.bindingId} AND owner_user_id = ${record.ownerUserId} AND state = 'active' FOR UPDATE`);
        if (!live.rows[0]) return false;
        const current = await tx.execute<{ id: string; state: AgentRuntimeConnectionState }>(sql`SELECT id, state FROM agent_runtime_connections
          WHERE owner_user_id = ${record.ownerUserId} AND client = ${record.client} AND revoked_at IS NULL FOR UPDATE`);
        const row = current.rows[0];
        if (!record.signedIn || !record.facts) {
          // Only the CLI's status can sign a connection in; anything else leaves it signed out (or
          // *Sign in again* when it was signed in before and the CLI no longer says so).
          if (row) {
            await tx.execute(sql`UPDATE agent_runtime_connections SET binding_id = ${record.bindingId},
              state = CASE WHEN state = 'signed_out' THEN 'signed_out' ELSE 'sign_in_again' END, signed_in_at = NULL,
              sign_in_method = coalesce(${record.method}, sign_in_method) WHERE id = ${row.id}`);
          } else {
            await tx.execute(sql`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, sign_in_method)
              VALUES (${randomUUID()}, ${record.ownerUserId}, ${record.bindingId}, ${record.client}, 'signed_out', ${record.method})`);
          }
          return true;
        }
        // The owner's previous account for this CLI: the live connection's, or else the latest one's.
        const previous = await tx.execute<{ account_label: string | null; account_fingerprint: string | null }>(sql`SELECT account_label, account_fingerprint
          FROM agent_runtime_connections WHERE owner_user_id = ${record.ownerUserId} AND client = ${record.client}
            AND (account_label IS NOT NULL OR account_fingerprint IS NOT NULL)
          ORDER BY (revoked_at IS NULL) DESC, coalesce(signed_in_at, revoked_at, created_at) DESC LIMIT 1`);
        const before = previous.rows[0];
        const changed = Boolean(before) && (before!.account_fingerprint && record.fingerprint
          ? before!.account_fingerprint !== record.fingerprint
          : (before!.account_label ?? '') !== (record.facts.accountLabel ?? ''));
        const { authMethod, plan, accountLabel } = record.facts;
        const id = row?.id ?? randomUUID();
        if (!row) {
          await tx.execute(sql`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state)
            VALUES (${id}, ${record.ownerUserId}, ${record.bindingId}, ${record.client}, 'signed_out')`);
        }
        await tx.execute(sql`UPDATE agent_runtime_connections SET binding_id = ${record.bindingId}, state = 'signed_in', signed_in_at = now(),
          sign_in_method = coalesce(${record.method}, sign_in_method), auth_method = ${authMethod}, plan_label = ${plan}, account_label = ${accountLabel},
          account_fingerprint = ${record.fingerprint},
          account_changed_at = CASE WHEN ${changed}::boolean THEN now() ELSE account_changed_at END,
          previous_account_label = CASE WHEN ${changed}::boolean THEN ${before?.account_label ?? null}::text ELSE previous_account_label END,
          signed_out_at = NULL, sign_out_failed = NULL
          WHERE id = ${id}`);
        return true;
      });
    },

    async recordSignOut(ownerUserId, bindingId, client, failed) {
      await db.transaction(async (tx) => {
        await ownerLock(tx, ownerUserId);
        const updated = await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL,
          signed_out_at = now(), sign_out_failed = ${failed}
          WHERE owner_user_id = ${ownerUserId} AND client = ${client} AND binding_id = ${bindingId} AND revoked_at IS NULL RETURNING id`);
        if (!updated.rows.length) {
          await tx.execute(sql`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, signed_out_at, sign_out_failed)
            SELECT ${randomUUID()}::uuid, ${ownerUserId}::text, ${bindingId}::uuid, ${client}::text, 'signed_out', now(), ${failed}::boolean
            WHERE NOT EXISTS (SELECT 1 FROM agent_runtime_connections WHERE owner_user_id = ${ownerUserId} AND client = ${client} AND revoked_at IS NULL)`);
        }
      });
    },

    async dismissAccountNotice(ownerUserId, client) {
      await db.execute(sql`UPDATE agent_runtime_connections SET account_changed_at = NULL, previous_account_label = NULL
        WHERE owner_user_id = ${ownerUserId} AND client = ${client} AND revoked_at IS NULL`);
    },

    async slotsWithBindings() {
      const rows = await db.execute<SlotRecord & { binding: BindingRecord | null }>(sql`SELECT s.slot, s.state, s.boot_id, s.wipe_boot_id, s.out_of_pool_reason,
        (SELECT to_jsonb(b) FROM (SELECT ${BINDING_COLUMNS} FROM agent_runtime_bindings WHERE slot = s.slot AND state <> 'released') b) AS binding
        FROM agent_runtime_slots s ORDER BY length(s.slot), s.slot`);
      return rows.rows.map((row) => ({ slot: slotRow(row), binding: row.binding ? binding(row.binding) : null }));
    },

    async saveSlot(slot) {
      await db.execute(sql`INSERT INTO agent_runtime_slots(slot, state, boot_id, wipe_boot_id, out_of_pool_reason, reported_at, updated_at)
        VALUES (${slot.slot}, ${slot.state}, ${slot.bootId}, ${slot.wipeBootId}, ${slot.outOfPoolReason}, now(), now())
        ON CONFLICT (slot) DO UPDATE SET state = excluded.state, boot_id = excluded.boot_id, wipe_boot_id = excluded.wipe_boot_id,
          out_of_pool_reason = excluded.out_of_pool_reason, reported_at = now(),
          updated_at = CASE WHEN agent_runtime_slots.state = excluded.state THEN agent_runtime_slots.updated_at ELSE now() END`);
    },

    async markSignInAgain(bindingId) {
      await db.transaction(async (tx) => {
        const updated = await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'sign_in_again' WHERE id = ${bindingId} AND state = 'active' RETURNING id`);
        if (updated.rows.length) await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'sign_in_again', signed_in_at = NULL
          WHERE binding_id = ${bindingId} AND revoked_at IS NULL AND state = 'signed_in'`);
      });
    },

    async completeRelease(bindingId, slot, logoutFailed) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'released', released_at = now(), release_logout_failed = ${logoutFailed}
          WHERE id = ${bindingId} AND state = 'releasing'`);
        await revokeConnections(tx, bindingId);
        await tx.execute(sql`UPDATE agent_runtime_slots SET state = ${slot.state}, boot_id = ${slot.bootId}, wipe_boot_id = ${slot.wipeBootId},
          out_of_pool_reason = ${slot.outOfPoolReason}, reported_at = now(), updated_at = now() WHERE slot = ${slot.slot}`);
      });
    },

    async dropStaleReservation(bindingId, olderThan) {
      return db.transaction(async (tx) => {
        const dropped = await tx.execute<{ slot: string }>(sql`DELETE FROM agent_runtime_bindings
          WHERE id = ${bindingId} AND state = 'binding' AND created_at < ${olderThan.toISOString()}::timestamptz RETURNING slot`);
        const name = dropped.rows[0]?.slot;
        if (name) await tx.execute(sql`UPDATE agent_runtime_slots SET state = 'unknown', updated_at = now() WHERE slot = ${name}`);
        return Boolean(name);
      });
    },

    async idleBindings(before) {
      const rows = await db.execute<BindingRecord>(sql`SELECT ${BINDING_COLUMNS} FROM agent_runtime_bindings
        WHERE state = 'active' AND coalesce(last_used_at, created_at) < ${before.toISOString()}::timestamptz ORDER BY created_at LIMIT 100`);
      return rows.rows.map(binding);
    },
  };
}

/**
 * Operator steps (tooling/operations.ts, `./flux runtime …`): the bindings with their owners' e-mail
 * for the operator's own view, a release request by slot, and forgetting every binding after a purge.
 */
export function agentRuntimeOperations(db: Handle) {
  const store = agentRuntimeStore(db);
  return {
    async list() {
      const rows = await db.execute<{ slot: string; slot_state: string; out_of_pool_reason: string | null; binding_state: string | null; email: string | null; created_at: Date | string | null }>(sql`
        SELECT s.slot, s.state AS slot_state, s.out_of_pool_reason, b.state AS binding_state, u.email, b.created_at
        FROM agent_runtime_slots s
        LEFT JOIN agent_runtime_bindings b ON b.slot = s.slot AND b.state <> 'released'
        LEFT JOIN auth_users u ON u.id = b.owner_user_id
        ORDER BY length(s.slot), s.slot`);
      return rows.rows;
    },
    release: (slot: string) => store.requestRelease({ slot }, 'operator'),
    async forgetAll(signOutConfirmed = false) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL, revoked_at = coalesce(revoked_at, now()) WHERE revoked_at IS NULL`);
        await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'released', release_reason = 'purge',
          release_requested_at = coalesce(release_requested_at, now()), released_at = now(),
          release_logout_failed = ${!signOutConfirmed} WHERE state <> 'released'`);
        await tx.execute(sql`UPDATE agent_runtime_slots SET state = 'unknown', boot_id = NULL, wipe_boot_id = NULL, out_of_pool_reason = NULL, updated_at = now()`);
      });
    },
  };
}

/**
 * Runs `work` only while this process holds a session advisory lock, so two workers never reconcile the
 * runtime at once. The lock's connection stays idle (no transaction) while `work` calls runtime-manager.
 */
export async function withRuntimeReconcileLock<T>(pool: Pick<Pool, 'connect'>, work: () => Promise<T>): Promise<T | null> {
  const client = await pool.connect();
  try {
    const locked = await client.query<{ ok: boolean }>("SELECT pg_try_advisory_lock(hashtext('agent-runtime-reconcile')) AS ok");
    if (!locked.rows[0]?.ok) return null;
    try { return await work(); } finally { await client.query("SELECT pg_advisory_unlock(hashtext('agent-runtime-reconcile'))").catch(() => undefined); }
  } finally {
    client.release();
  }
}
