import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AgentRuntimeReleaseReason } from '@flux/contracts';
import type { AgentRuntimeStore, RuntimeBindingRow, RuntimeSlotRow } from '@flux/core';
import type { Pool } from 'pg';
import type * as schema from '../schema.js';

// PostgreSQL adapter of the `runtime` transport's store (F-022 T3, migration 0056). Each method is one
// short transaction; the use cases call runtime-manager only between them, never inside one.

type Handle = Pick<NodePgDatabase<typeof schema>, 'execute' | 'transaction'>;
type Exec = Pick<NodePgDatabase<typeof schema>, 'execute'>;

type BindingRecord = { id: string; owner_user_id: string; slot: string; state: RuntimeBindingRow['state']; created_at: Date | string;
  last_used_at: Date | string | null; release_reason: AgentRuntimeReleaseReason | null };
type SlotRecord = { slot: string; state: RuntimeSlotRow['state']; boot_id: string | null; wipe_boot_id: string | null; out_of_pool_reason: RuntimeSlotRow['outOfPoolReason'] };

const date = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const binding = (row: BindingRecord): RuntimeBindingRow => ({
  id: row.id, ownerUserId: row.owner_user_id, slot: row.slot, state: row.state, createdAt: date(row.created_at),
  lastUsedAt: row.last_used_at === null ? null : date(row.last_used_at), releaseReason: row.release_reason,
});
const slotRow = (row: SlotRecord): RuntimeSlotRow => ({ slot: row.slot, state: row.state, bootId: row.boot_id, wipeBootId: row.wipe_boot_id, outOfPoolReason: row.out_of_pool_reason });

const BINDING_COLUMNS = sql`id, owner_user_id, slot, state, created_at, last_used_at, release_reason`;

async function ownerLock(tx: Exec, ownerUserId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-runtime-owner:${ownerUserId}`}))`);
}

/** Signs the binding's connections out in Flux (the CLI's own files are deleted by the release). */
async function revokeConnections(tx: Exec, bindingId: string) {
  await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL, revoked_at = coalesce(revoked_at, now())
    WHERE binding_id = ${bindingId} AND revoked_at IS NULL`);
}

export function agentRuntimeStore(db: Handle): AgentRuntimeStore {
  return {
    async ownerView(ownerUserId) {
      const live = await db.execute<BindingRecord>(sql`SELECT ${BINDING_COLUMNS} FROM agent_runtime_bindings
        WHERE owner_user_id = ${ownerUserId} AND state <> 'released'`);
      const last = await db.execute<{ release_reason: AgentRuntimeReleaseReason; released_at: Date | string }>(sql`SELECT release_reason, released_at
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
        lastRelease: last.rows[0] ? { reason: last.rows[0].release_reason, at: date(last.rows[0].released_at) } : null,
        slots: counts.rows[0] ?? { ready: 0, held: 0, total: 0 },
        commercialTerms: terms.rows[0] ? { agreedOn: terms.rows[0].agreed_on, recordedAt: date(terms.rows[0].recorded_at) } : null,
      };
    },

    reserve(ownerUserId, bindingId) {
      return db.transaction(async (tx) => {
        await ownerLock(tx, ownerUserId);
        const existing = await tx.execute<BindingRecord>(sql`SELECT ${BINDING_COLUMNS} FROM agent_runtime_bindings
          WHERE owner_user_id = ${ownerUserId} AND state <> 'released' FOR UPDATE`);
        if (existing.rows[0]) return { kind: 'existing' as const, binding: binding(existing.rows[0]) };
        const free = await tx.execute<{ slot: string }>(sql`SELECT s.slot FROM agent_runtime_slots s
          WHERE s.state = 'ready' AND NOT EXISTS (SELECT 1 FROM agent_runtime_bindings b WHERE b.slot = s.slot AND b.state <> 'released')
          ORDER BY length(s.slot), s.slot FOR UPDATE SKIP LOCKED LIMIT 1`);
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

    async completeRelease(bindingId, slot) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'released', released_at = now() WHERE id = ${bindingId} AND state = 'releasing'`);
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
    async forgetAll() {
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL, revoked_at = coalesce(revoked_at, now()) WHERE revoked_at IS NULL`);
        await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'released', release_reason = 'purge',
          release_requested_at = coalesce(release_requested_at, now()), released_at = now() WHERE state <> 'released'`);
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
