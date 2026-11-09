import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AgentRuntimeBindingState, AgentRuntimeClient, AgentRuntimeConnectionState, AgentRuntimeReleaseReason, AgentRuntimeSignInMethod } from '@flux/contracts';
import type { Pool } from 'pg';
import { holdingSessionLock } from '../session-lock.js';
import { companyGuestSql } from './access.js';
import type * as schema from '../schema.js';
import {
  currentRuntimeAuthOperation, markLoginConfirmedGone, markLoginPossible, runtimeAuthAdmissionLock, runtimeAuthOperations, settleRuntimeAuthOperation, RuntimeAuthSupersededError,
  type RuntimeAuthClaim, type RuntimeAuthAdmission, type RuntimeAuthOperation,
} from './runtime-auth-operations.js';

// PostgreSQL adapter of the `runtime` transport's store (F-022 T3, migration 0056; sign-in T4, 0057).
// Each method is one short transaction; the use cases call runtime-manager only between them, never
// inside one.

// Structurally core's AgentRuntimeStore port (@flux/core agent-runtime/ports.ts); @flux/db does not import
// @flux/core (no manifest dependency on it). The API and worker pass this adapter where the port is expected.
export type RuntimeSlotState = 'unknown' | 'ready' | 'out_of_pool';
export type RuntimeOutOfPoolReason = 'data_not_empty' | 'missing';
export interface RuntimeSlotRow { slot: string; state: RuntimeSlotState; bootId: string | null; outOfPoolReason: RuntimeOutOfPoolReason | null; capacity: number | null }
export interface RuntimeBindingRow {
  id: string; ownerUserId: string; slot: string; state: AgentRuntimeBindingState; createdAt: Date; lastUsedAt: Date | null;
  /** Where the idle window starts (see `IDLE_SINCE`). */
  idleSince: Date;
  releaseReason: AgentRuntimeReleaseReason | null;
}
type ReserveOutcome = { kind: 'reserved' | 'existing'; binding: RuntimeBindingRow } | { kind: 'starting' };
export interface RuntimeConnectionRow {
  /** The provider's remaining usage as the last run saw it (#854); null before any. */
  usage: { leftPercent: number | null; window: 'five_hour' | 'weekly' | null; resetsAt: Date | null; limitReached: boolean; readAt: Date } | null;
  client: AgentRuntimeClient; bindingId: string; state: AgentRuntimeConnectionState; signInMethod: AgentRuntimeSignInMethod | null;
  authMethod: string | null; plan: string | null; accountLabel: string | null; signedInAt: Date | null;
  accountChangedAt: Date | null; previousAccountLabel: string | null; signedOutAt: Date | null; signOutFailed: boolean | null;
}
export interface RuntimeSignInRecord {
  operation: RuntimeAuthOperation;
  ownerUserId: string; bindingId: string; client: AgentRuntimeClient; method: AgentRuntimeSignInMethod | null; signedIn: boolean;
  facts: { authMethod: string; plan: string | null; accountLabel: string | null } | null; fingerprint: string | null;
}
export interface AgentRuntimeRows {
  claimAuth(input: RuntimeAuthClaim): Promise<RuntimeAuthAdmission>;
  renewAuth(operation: RuntimeAuthOperation, leaseMs: number): Promise<boolean>;
  recoverAuth(operation: RuntimeAuthOperation): Promise<boolean>;
  recoverAbandonedAuth(): Promise<number>;
  ownerView(ownerUserId: string): Promise<{
    binding: RuntimeBindingRow | null;
    lastRelease: { reason: AgentRuntimeReleaseReason; at: Date; signOutFailed: boolean } | null;
    slots: { ready: number };
    commercialTerms: { agreedOn: string; recordedAt: Date } | null;
    auth?: { client: AgentRuntimeClient; kind: 'check' | 'logout' | 'console' }[];
  }>;
  reserve(ownerUserId: string, bindingId: string): Promise<ReserveOutcome>;
  activate(bindingId: string): Promise<void>;
  abandon(bindingId: string): Promise<void>;
  requestRelease(target: { ownerUserId: string } | { bindingId: string }, reason: AgentRuntimeReleaseReason): Promise<RuntimeBindingRow | null>;
  recordCommercialTerms(agreedOn: string): Promise<void>;
  connections(ownerUserId: string): Promise<RuntimeConnectionRow[]>;
  recordSignIn(record: RuntimeSignInRecord): Promise<boolean>;
  recordSignOut(operation: RuntimeAuthOperation, failed: boolean): Promise<boolean>;
  loginPossible(bindingId: string): Promise<AgentRuntimeClient[]>;
  dismissAccountNotice(ownerUserId: string, client: AgentRuntimeClient): Promise<void>;
  slotsWithBindings(): Promise<{ slot: RuntimeSlotRow; bindings: RuntimeBindingRow[] }[]>;
  saveSlot(slot: RuntimeSlotRow): Promise<void>;
  markSignInAgain(bindingId: string): Promise<void>;
  completeRelease(bindingId: string, logoutFailed: boolean): Promise<void>;
  dropStaleReservation(bindingId: string, olderThan: Date): Promise<boolean>;
  idleBindings(before: Date): Promise<RuntimeBindingRow[]>;
}

type Handle = Pick<NodePgDatabase<typeof schema>, 'execute' | 'transaction'>;
type Exec = Pick<NodePgDatabase<typeof schema>, 'execute'>;

type BindingRecord = { id: string; owner_user_id: string; slot: string; state: AgentRuntimeBindingState; created_at: Date | string;
  last_used_at: Date | string | null; release_reason: AgentRuntimeReleaseReason | null; idle_since?: Date | string };
type SlotRecord = { slot: string; state: RuntimeSlotRow['state']; boot_id: string | null; out_of_pool_reason: RuntimeSlotRow['outOfPoolReason']; capacity: number | null };

const date = (value: Date | string) => (value instanceof Date ? value : new Date(value));
const binding = (row: BindingRecord): RuntimeBindingRow => ({
  id: row.id, ownerUserId: row.owner_user_id, slot: row.slot, state: row.state, createdAt: date(row.created_at),
  lastUsedAt: row.last_used_at === null ? null : date(row.last_used_at), releaseReason: row.release_reason,
  idleSince: date(row.idle_since ?? row.last_used_at ?? row.created_at),
});
const slotRow = (row: SlotRecord): RuntimeSlotRow => ({ slot: row.slot, state: row.state, bootId: row.boot_id, outOfPoolReason: row.out_of_pool_reason, capacity: row.capacity });

const BINDING_COLUMNS = sql`id, owner_user_id, slot, state, created_at, last_used_at, release_reason`;
/**
 * Where a binding's idle window starts (`idle_since`): its last use, or the owner's last role change in the company if that is later.
 * A guest's place is kept untouched while they are one (C-50), so a guest back as a member starts a new window instead of being released
 * for the days they could not use it (#1095). Select it with `FROM agent_runtime_bindings` (the table name is not aliased).
 */
const IDLE_SINCE = sql`greatest(coalesce(last_used_at, created_at), coalesce((SELECT m.updated_at FROM workspace_members m
  JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = agent_runtime_bindings.owner_user_id AND w.company), created_at))`;

type ConnectionRecord = { client: AgentRuntimeClient; binding_id: string; state: AgentRuntimeConnectionState; sign_in_method: AgentRuntimeSignInMethod | null;
  auth_method: string | null; plan_label: string | null; account_label: string | null; signed_in_at: Date | string | null;
  account_changed_at: Date | string | null; previous_account_label: string | null; signed_out_at: Date | string | null; sign_out_failed: boolean | null;
  usage_left_percent: number | null; usage_window: 'five_hour' | 'weekly' | null; usage_resets_at: Date | string | null; usage_limit_reached: boolean;
  usage_read_at: Date | string | null };
const maybeDate = (value: Date | string | null) => (value === null ? null : date(value));
const connection = (row: ConnectionRecord): RuntimeConnectionRow => ({
  client: row.client, bindingId: row.binding_id, state: row.state, signInMethod: row.sign_in_method, authMethod: row.auth_method, plan: row.plan_label,
  accountLabel: row.account_label, signedInAt: maybeDate(row.signed_in_at), accountChangedAt: maybeDate(row.account_changed_at),
  previousAccountLabel: row.previous_account_label, signedOutAt: maybeDate(row.signed_out_at), signOutFailed: row.sign_out_failed,
  usage: row.usage_read_at === null ? null : { leftPercent: row.usage_left_percent, window: row.usage_window, resetsAt: maybeDate(row.usage_resets_at),
    limitReached: row.usage_limit_reached, readAt: date(row.usage_read_at) },
});
const CONNECTION_COLUMNS = sql`client, binding_id, state, sign_in_method, auth_method, plan_label, account_label, signed_in_at,
  account_changed_at, previous_account_label, signed_out_at, sign_out_failed, usage_left_percent, usage_window, usage_resets_at,
  usage_limit_reached, usage_read_at`;

async function ownerLock(tx: Exec, ownerUserId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-runtime-owner:${ownerUserId}`}))`);
}

/** Signs the binding's connections out in Flux (the CLI's own files are deleted by the release). */
async function revokeConnections(tx: Exec, bindingId: string) {
  await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL, revoked_at = coalesce(revoked_at, now())
    WHERE binding_id = ${bindingId} AND revoked_at IS NULL`);
}

export function agentRuntimeStore(db: Handle): AgentRuntimeRows {
  const auth = runtimeAuthOperations(db);
  return {
    claimAuth: auth.claim,
    renewAuth: auth.renew,
    recoverAuth: auth.uncertain,
    recoverAbandonedAuth: auth.recoverAbandoned,
    async ownerView(ownerUserId) {
      const live = await db.execute<BindingRecord>(sql`SELECT ${BINDING_COLUMNS}, ${IDLE_SINCE} AS idle_since FROM agent_runtime_bindings
        WHERE owner_user_id = ${ownerUserId} AND state <> 'released'`);
      const last = await db.execute<{ release_reason: AgentRuntimeReleaseReason; released_at: Date | string; release_logout_failed: boolean | null }>(sql`SELECT release_reason, released_at, release_logout_failed
        FROM agent_runtime_bindings WHERE owner_user_id = ${ownerUserId} AND state = 'released' AND release_reason <> 'bind_failed'
        ORDER BY released_at DESC, id LIMIT 1`);
      const counts = await db.execute<{ ready: number }>(sql`SELECT count(*)::int AS ready FROM agent_runtime_slots WHERE state = 'ready'`);
      const terms = await db.execute<{ agreed_on: string; recorded_at: Date | string }>(sql`SELECT agreed_on::text AS agreed_on, recorded_at
        FROM agent_runtime_operator_statements WHERE statement = 'anthropic_commercial_terms' ORDER BY recorded_at DESC LIMIT 1`);
      const auth = await db.execute<{ client: AgentRuntimeClient; kind: 'check' | 'logout' | 'console' }>(sql`SELECT a.client, a.kind
        FROM agent_runtime_auth_operations a JOIN agent_runtime_bindings b ON b.id = a.binding_id
        WHERE b.owner_user_id = ${ownerUserId} AND b.state = 'active' AND a.phase = 'active'`);
      return {
        auth: auth.rows,
        binding: live.rows[0] ? binding(live.rows[0]) : null,
        lastRelease: last.rows[0] ? { reason: last.rows[0].release_reason, at: date(last.rows[0].released_at), signOutFailed: last.rows[0].release_logout_failed === true } : null,
        slots: counts.rows[0] ?? { ready: 0 },
        commercialTerms: terms.rows[0] ? { agreedOn: terms.rows[0].agreed_on, recordedAt: date(terms.rows[0].recorded_at) } : null,
      };
    },

    reserve(ownerUserId, bindingId) {
      return db.transaction(async (tx) => {
        if (!await runtimeAuthAdmissionLock(tx)) return { kind: 'starting' as const };
        await ownerLock(tx, ownerUserId);
        const existing = await tx.execute<BindingRecord>(sql`SELECT ${BINDING_COLUMNS} FROM agent_runtime_bindings
          WHERE owner_user_id = ${ownerUserId} AND state <> 'released' FOR UPDATE`);
        if (existing.rows[0]) {
          const current = existing.rows[0];
          const uncertain = await tx.execute(sql`SELECT 1 FROM agent_runtime_auth_operations WHERE binding_id = ${current.id}
            AND (phase = 'uncertain' OR (phase = 'active' AND lease_ends_at <= clock_timestamp()))`);
          if (uncertain.rows.length && (current.state === 'active' || current.state === 'sign_in_again')) {
            await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'releasing', release_reason = 'auth_recovery',
              release_requested_at = clock_timestamp() WHERE id = ${current.id}`);
            await revokeConnections(tx, current.id);
            current.state = 'releasing'; current.release_reason = 'auth_recovery';
          }
          return { kind: 'existing' as const, binding: binding(current) };
        }
        // No fixed cap (#860): a person's directory costs nothing while it waits, so any runtime that answers takes them.
        const ready = await tx.execute<{ slot: string }>(sql`SELECT s.slot FROM agent_runtime_slots s WHERE s.state = 'ready'
          ORDER BY (SELECT count(*) FROM agent_runtime_bindings b WHERE b.slot = s.slot AND b.state <> 'released'), length(s.slot), s.slot LIMIT 1`);
        const slot = ready.rows[0]?.slot;
        if (!slot) return { kind: 'starting' as const };
        const inserted = await tx.execute<BindingRecord>(sql`INSERT INTO agent_runtime_bindings(id, owner_user_id, slot, state)
          VALUES (${bindingId}, ${ownerUserId}, ${slot}, 'binding') RETURNING ${BINDING_COLUMNS}`);
        return { kind: 'reserved' as const, binding: binding(inserted.rows[0]!) };
      });
    },

    async activate(bindingId) {
      await db.execute(sql`UPDATE agent_runtime_bindings SET state = 'active' WHERE id = ${bindingId} AND state IN ('binding', 'sign_in_again')`);
    },

    async abandon(bindingId) {
      await db.execute(sql`DELETE FROM agent_runtime_bindings WHERE id = ${bindingId} AND state = 'binding'`);
    },

    requestRelease(target, reason) {
      return db.transaction(async (tx) => {
        const where = 'ownerUserId' in target ? sql`owner_user_id = ${target.ownerUserId}` : sql`id = ${target.bindingId}`;
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

    async recordSignIn(record) {
      try { return await db.transaction(async (tx) => {
        const operation = record.operation;
        if (!operation || operation.kind === 'logout' || operation.ownerUserId !== record.ownerUserId
          || operation.bindingId !== record.bindingId || operation.client !== record.client
          || !await currentRuntimeAuthOperation(tx, operation)) return false;
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
          await settleRuntimeAuthOperation(tx, operation);
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
        // The CLI's own status says a login exists; the history says so even if no console was claimed for it.
        await markLoginPossible(tx, record.bindingId, record.client);
        await settleRuntimeAuthOperation(tx, operation);
        return true;
      }); } catch (error) { if (error instanceof RuntimeAuthSupersededError) return false; throw error; }
    },

    async recordSignOut(operation, failed) {
      try { return await db.transaction(async (tx) => {
        if (operation.kind !== 'logout' || !await currentRuntimeAuthOperation(tx, operation)) return false;
        const { ownerUserId, bindingId, client } = operation;
        const updated = await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL,
          signed_out_at = now(), sign_out_failed = ${failed}
          WHERE owner_user_id = ${ownerUserId} AND client = ${client} AND binding_id = ${bindingId} AND revoked_at IS NULL RETURNING id`);
        if (!updated.rows.length) {
          await tx.execute(sql`INSERT INTO agent_runtime_connections(id, owner_user_id, binding_id, client, state, signed_out_at, sign_out_failed)
            SELECT ${randomUUID()}::uuid, ${ownerUserId}::text, ${bindingId}::uuid, ${client}::text, 'signed_out', now(), ${failed}::boolean
            WHERE NOT EXISTS (SELECT 1 FROM agent_runtime_connections WHERE owner_user_id = ${ownerUserId} AND client = ${client} AND revoked_at IS NULL)`);
        }
        // Only the CLI's own logout returning ok ends the history's "a login may exist"; failed/timeout/not_installed/skipped keep it.
        if (!failed) await markLoginConfirmedGone(tx, bindingId, client);
        await settleRuntimeAuthOperation(tx, operation);
        return true;
      }); } catch (error) { if (error instanceof RuntimeAuthSupersededError) return false; throw error; }
    },

    async loginPossible(bindingId) {
      const rows = await db.execute<{ client: AgentRuntimeClient }>(sql`SELECT client FROM agent_runtime_client_history
        WHERE binding_id = ${bindingId} AND login_possible ORDER BY client`);
      return rows.rows.map((row) => row.client);
    },

    async dismissAccountNotice(ownerUserId, client) {
      await db.execute(sql`UPDATE agent_runtime_connections SET account_changed_at = NULL, previous_account_label = NULL
        WHERE owner_user_id = ${ownerUserId} AND client = ${client} AND revoked_at IS NULL`);
    },

    async slotsWithBindings() {
      const rows = await db.execute<SlotRecord & { bindings: BindingRecord[] }>(sql`SELECT s.slot, s.state, s.boot_id, s.out_of_pool_reason, s.capacity,
        coalesce((SELECT jsonb_agg(to_jsonb(b)) FROM (SELECT ${BINDING_COLUMNS} FROM agent_runtime_bindings WHERE slot = s.slot AND state <> 'released') b), '[]'::jsonb) AS bindings
        FROM agent_runtime_slots s ORDER BY length(s.slot), s.slot`);
      return rows.rows.map((row) => ({ slot: slotRow(row), bindings: row.bindings.map(binding) }));
    },

    async saveSlot(slot) {
      await db.execute(sql`INSERT INTO agent_runtime_slots(slot, state, boot_id, out_of_pool_reason, capacity, reported_at, updated_at)
        VALUES (${slot.slot}, ${slot.state}, ${slot.bootId}, ${slot.outOfPoolReason}, ${slot.capacity}, now(), now())
        ON CONFLICT (slot) DO UPDATE SET state = excluded.state, boot_id = excluded.boot_id, out_of_pool_reason = excluded.out_of_pool_reason,
          capacity = excluded.capacity, reported_at = now(),
          updated_at = CASE WHEN agent_runtime_slots.state = excluded.state THEN agent_runtime_slots.updated_at ELSE now() END`);
    },

    async markSignInAgain(bindingId) {
      await db.transaction(async (tx) => {
        const updated = await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'sign_in_again' WHERE id = ${bindingId} AND state = 'active' RETURNING id`);
        if (updated.rows.length) await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'sign_in_again', signed_in_at = NULL
          WHERE binding_id = ${bindingId} AND revoked_at IS NULL AND state = 'signed_in'`);
      });
    },

    async completeRelease(bindingId, logoutFailed) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE agent_runtime_bindings SET state = 'released', released_at = now(), release_logout_failed = ${logoutFailed}
          WHERE id = ${bindingId} AND state = 'releasing'`);
        await revokeConnections(tx, bindingId);
        await tx.execute(sql`UPDATE agent_runtime_auth_operations SET phase = 'settled', settled_at = clock_timestamp()
          WHERE binding_id = ${bindingId} AND phase <> 'settled'`);
      });
    },

    async dropStaleReservation(bindingId, olderThan) {
      const dropped = await db.execute(sql`DELETE FROM agent_runtime_bindings
        WHERE id = ${bindingId} AND state = 'binding' AND created_at < ${olderThan.toISOString()}::timestamptz RETURNING id`);
      return dropped.rows.length > 0;
    },

    async idleBindings(before) {
      const rows = await db.execute<BindingRecord>(sql`SELECT * FROM (SELECT ${BINDING_COLUMNS}, ${IDLE_SINCE} AS idle_since FROM agent_runtime_bindings
        WHERE state = 'active' AND NOT ${companyGuestSql(sql`owner_user_id`)}) b
        WHERE idle_since < ${before.toISOString()}::timestamptz ORDER BY created_at LIMIT 100`);
      return rows.rows.map(binding);
    },
  };
}

/**
 * Operator steps (tooling/operations.ts, `./flux runtime …`): the runtime and its people for the operator's own view, a
 * release request by a person's e-mail, and forgetting every binding after a purge.
 */
export function agentRuntimeOperations(db: Handle) {
  const store = agentRuntimeStore(db);
  return {
    async list() {
      const rows = await db.execute<{ slot: string; slot_state: string; out_of_pool_reason: string | null; capacity: number | null; binding_state: string | null; email: string | null; created_at: Date | string | null }>(sql`
        SELECT s.slot, s.state AS slot_state, s.out_of_pool_reason, s.capacity, b.state AS binding_state, u.email, b.created_at
        FROM agent_runtime_slots s
        LEFT JOIN agent_runtime_bindings b ON b.slot = s.slot AND b.state <> 'released'
        LEFT JOIN auth_users u ON u.id = b.owner_user_id
        ORDER BY length(s.slot), s.slot, u.email`);
      return rows.rows;
    },
    /** The person's runtime goes: the worker signs them out and deletes their directory. Null when they have none. */
    async release(email: string) {
      const owner = await db.execute<{ id: string }>(sql`SELECT id FROM auth_users WHERE lower(email) = lower(${email})`);
      return owner.rows[0] ? store.requestRelease({ ownerUserId: owner.rows[0].id }, 'operator') : null;
    },
    beginPurge: () => runtimeAuthOperations(db).beginPurge(),
    /**
     * `notInstalled`: the (binding, client) pairs the slots answered `not_installed` for during the purge's sign-out.
     * Such a client is confirmed only while the durable history shows no login was ever started for it in that
     * binding (migration 0118); an empty directory or a missing CLI alone never confirms anything (#480).
     */
    async forgetAll(purgeId: string, signOutConfirmed = false, notInstalled: readonly { bindingId: string; client: AgentRuntimeClient }[] = []) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('agent-runtime-auth-admission'))`);
        const gate = await tx.execute(sql`SELECT 1 FROM agent_runtime_auth_admission
          WHERE singleton AND blocked AND purge_id = ${purgeId} FOR UPDATE`);
        if (!gate.rows.length) throw new Error('Runtime purge is not the current fenced cleanup');
        await tx.execute(sql`UPDATE agent_runtime_connections SET state = 'signed_out', signed_in_at = NULL, revoked_at = coalesce(revoked_at, now()) WHERE revoked_at IS NULL`);
        const pairs = JSON.stringify(notInstalled.map((pair) => `${pair.bindingId}:${pair.client}`));
        await tx.execute(sql`UPDATE agent_runtime_bindings b SET state = 'released', release_reason = 'purge',
          release_requested_at = coalesce(release_requested_at, now()), released_at = now(),
          release_logout_failed = ${!signOutConfirmed} OR EXISTS (SELECT 1 FROM agent_runtime_client_history h
            WHERE h.binding_id = b.id AND h.login_possible
              AND (h.binding_id::text || ':' || h.client) IN (SELECT jsonb_array_elements_text(${pairs}::jsonb)))
          WHERE b.state <> 'released'`);
        await tx.execute(sql`UPDATE agent_runtime_slots SET state = 'unknown', boot_id = NULL, out_of_pool_reason = NULL, updated_at = now()`);
        await tx.execute(sql`UPDATE agent_runtime_auth_operations SET phase = 'settled', settled_at = clock_timestamp() WHERE phase <> 'settled'`);
        // The launcher invokes this only after every runtime container and volume is removed.
        await tx.execute(sql`UPDATE agent_runtime_auth_admission SET blocked = false, purge_id = NULL,
          changed_at = clock_timestamp() WHERE singleton AND purge_id = ${purgeId}`);
      });
    },
  };
}

/**
 * Runs `work` only while this process holds a session advisory lock, so two workers never reconcile the
 * runtime at once. The lock's connection stays idle (no transaction) while `work` calls runtime-manager; if it dies, the
 * lock goes with it, `work`'s `signal` aborts and the call rejects (`holdingSessionLock`, #916).
 */
export function withRuntimeReconcileLock<T>(pool: Pick<Pool, 'connect'>, work: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  return holdingSessionLock(pool, { try: true, acquire: { text: "SELECT pg_try_advisory_lock(hashtext('agent-runtime-reconcile')) AS ok" },
    release: { text: "SELECT pg_advisory_unlock(hashtext('agent-runtime-reconcile'))" } }, work);
}
