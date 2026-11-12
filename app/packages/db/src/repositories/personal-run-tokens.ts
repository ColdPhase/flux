import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import * as schema from '../schema.js';
import type { DbExecutor } from './push.js';

/**
 * Rows of a personal run's MCP token (F-022 "Agent connection and permissions", F-027 A2, #280/#484).
 * The token itself is never stored. The worker arms a run with the SHA-256 of a one-time nonce; the API,
 * which is the authorization server, mints exactly one token for an in-flight run whose nonce matches and
 * records its id, expiry and exact tools. The MCP route reads the live row on every request and accounts
 * the bytes tool results return to it. These rows make no access decision.
 */

const r = schema.personalRuns;
const IN_FLIGHT: ('reading' | 'dispatching')[] = ['reading', 'dispatching'];

export interface RunTokenRow {
  id: string;
  workspaceId: string;
  /** The run's place (#842): a space and its conversation, a direct message, or neither (a private chat). */
  projectId: string | null;
  conversationId: string | null;
  dmId: string | null;
  ownerUserId: string;
  agentId: string;
  status: typeof r.$inferSelect.status;
  engine: 'server' | 'runtime';
  /** The provider and model the run was sent with: whether it sees pictures (#1217). */
  provider: typeof r.$inferSelect.provider;
  model: string;
  /** #841: a `task_answer` run only reads. */
  kind: typeof r.$inferSelect.kind;
  runTokenNonceHash: string | null;
  runTokenJti: string | null;
  runTokenExpiresAt: Date | null;
  runTokenClosedAt: Date | null;
  runTools: string[];
  mcpResultBytes: number;
  mcpLimit: 'call' | 'run' | null;
  stopRequestedAt: Date | null;
  /** F-029: the workspace AI policy epoch the run was admitted under. */
  aiEpoch: number | null;
}

const columns = {
  id: r.id, workspaceId: r.workspaceId, projectId: r.projectId, conversationId: r.conversationId, dmId: r.dmId, ownerUserId: r.ownerUserId,
  agentId: r.agentId, status: r.status, engine: r.engine, kind: r.kind, runTokenNonceHash: r.runTokenNonceHash, runTokenJti: r.runTokenJti,
  runTokenExpiresAt: r.runTokenExpiresAt, runTokenClosedAt: r.runTokenClosedAt, runTools: r.runTools, mcpResultBytes: r.mcpResultBytes,
  mcpLimit: r.mcpLimit, stopRequestedAt: r.stopRequestedAt, aiEpoch: r.aiEpoch, provider: r.provider, model: r.model,
};

export function personalRunTokenRows(db: DbExecutor) {
  return {
    /** Worker: arms an in-flight run that has no token yet with the hash of its one-time minting nonce. */
    async arm(runId: string, nonceHash: string): Promise<boolean> {
      const rows = await db.update(r).set({ runTokenNonceHash: nonceHash, updatedAt: new Date() })
        .where(and(eq(r.id, runId), inArray(r.status, IN_FLIGHT), isNull(r.runTokenJti))).returning({ id: r.id });
      return rows.length === 1;
    },

    /** The run's token row; `lock` holds it for a mint or an accounting decision. */
    async find(runId: string, options: { lock?: 'update' | 'share' } = {}): Promise<RunTokenRow | null> {
      const query = db.select(columns).from(r).where(eq(r.id, runId));
      const [row] = options.lock ? await query.for(options.lock) : await query;
      return (row as RunTokenRow | undefined) ?? null;
    },

    /** API: records the one minted token (its id, expiry and exact tools) and spends the nonce. */
    async recordMint(runId: string, mint: { jti: string; expiresAt: Date; tools: string[] }): Promise<void> {
      await db.update(r).set({ runTokenJti: mint.jti, runTokenExpiresAt: mint.expiresAt, runTools: mint.tools, runTokenNonceHash: null, updatedAt: new Date() })
        .where(eq(r.id, runId));
    },

    /** Ends the token whatever the run does next (`PersonalToolSession.close`, the runtime's end). */
    async close(runId: string): Promise<void> {
      await db.update(r).set({ runTokenClosedAt: sql`COALESCE(${r.runTokenClosedAt}, now())`, updatedAt: new Date() }).where(eq(r.id, runId));
    },

    /**
     * MCP route: adds one tool result's bytes to the run's total while it stays within `limit`. False when
     * the result would take the run past it (nothing is added).
     */
    async addResultBytes(runId: string, bytes: number, limit: number): Promise<boolean> {
      const rows = await db.update(r).set({ mcpResultBytes: sql`${r.mcpResultBytes} + ${bytes}` })
        .where(and(eq(r.id, runId), sql`${r.mcpResultBytes} + ${bytes} <= ${limit}`)).returning({ id: r.id });
      return rows.length === 1;
    },

    /** MCP route: a result passed one of its bounds; the first bound reached is kept. */
    async markMcpLimit(runId: string, limit: 'call' | 'run'): Promise<void> {
      await db.update(r).set({ mcpLimit: sql`COALESCE(${r.mcpLimit}, ${limit})` }).where(eq(r.id, runId));
    },

    /**
     * The rights connection of one of the owner's agents (F-036 AG-1: each agent has its own). The mapping never changes once
     * created, so it is read without a lock (S6 writers lock policy, then settings); a deleted agent has none.
     */
    async assistantConnectionId(ownerUserId: string, agentId: string): Promise<string | null> {
      const [row] = await db.select({ connectionId: schema.assistantSettings.connectionId }).from(schema.assistantSettings)
        .innerJoin(schema.agents, eq(schema.agents.id, schema.assistantSettings.agentId))
        .where(and(eq(schema.assistantSettings.ownerUserId, ownerUserId), eq(schema.assistantSettings.agentId, agentId), isNull(schema.agents.revokedAt)));
      return row?.connectionId ?? null;
    },
  };
}

/** The owner's own Claude Code or Codex in their runtime slot, for a personal run (F-022 AIM-3, #280, #281). Display facts only. */
export interface PersonalRuntimeRow {
  state: 'signed_out' | 'sign_in_again' | 'signed_in';
  /** The CLI this row describes: the one asked for, or the owner's most recently signed-in one. */
  client: 'claude_code' | 'codex';
  slot: string | null;
  bindingId: string | null;
  authMethod: string | null;
  accountLabel: string | null;
  /** While signed in: when (Connect AI's default is the connection made first, #854). */
  signedInAt: Date | null;
}

/**
 * The owner's live binding and one CLI's connection in it: signed in only when the CLI's own status said
 * so (T4); *Sign in again* when either the binding or the connection says so; otherwise signed out.
 * Without `client`, the connection is chosen among `clients`: a signed-in one first, the most recent
 * sign-in first, so the CLI the owner signed in to last is the one their assistant consents to.
 */
export async function personalRuntimeRow(db: DbExecutor, ownerUserId: string, clients: readonly ('claude_code' | 'codex')[] = ['claude_code']): Promise<PersonalRuntimeRow> {
  const wanted = clients.length ? [...clients] : ['claude_code'];
  const result = await db.execute<{ id: string; slot: string; binding_state: string; client: string | null; connection_state: string | null; auth_method: string | null; account_label: string | null; signed_in_at: Date | string | null }>(sql`
    SELECT b.id, b.slot, b.state AS binding_state, c.client, c.state AS connection_state, c.auth_method, c.account_label, c.signed_in_at
    FROM agent_runtime_bindings b
    LEFT JOIN agent_runtime_connections c ON c.binding_id = b.id AND c.client IN (${sql.join(wanted.map((client) => sql`${client}`), sql`, `)}) AND c.revoked_at IS NULL
    WHERE b.owner_user_id = ${ownerUserId} AND b.state <> 'released'
    ORDER BY (c.state = 'signed_in') DESC NULLS LAST, c.signed_in_at DESC NULLS LAST, c.client
    LIMIT 1`);
  const row = result.rows[0];
  const fallback = (wanted[0] === 'codex' ? 'codex' : 'claude_code') as PersonalRuntimeRow['client'];
  if (!row) return { state: 'signed_out', client: fallback, slot: null, bindingId: null, authMethod: null, accountLabel: null, signedInAt: null };
  const client = (row.client === 'codex' || row.client === 'claude_code' ? row.client : fallback) as PersonalRuntimeRow['client'];
  const state = row.binding_state === 'sign_in_again' || row.connection_state === 'sign_in_again' ? 'sign_in_again'
    : row.binding_state === 'active' && row.connection_state === 'signed_in' ? 'signed_in' : 'signed_out';
  return { state, client, slot: row.slot, bindingId: row.id, authMethod: state === 'signed_in' ? row.auth_method : null, accountLabel: row.account_label,
    signedInAt: state === 'signed_in' && row.signed_in_at ? new Date(row.signed_in_at) : null };
}

/** A run used the binding: the operator's idle policy counts from here (F-022 "Bindings"). */
export async function touchRuntimeBinding(db: DbExecutor, bindingId: string): Promise<void> {
  await db.execute(sql`UPDATE agent_runtime_bindings SET last_used_at = now() WHERE id = ${bindingId} AND state = 'active'`);
}

/**
 * A run whose CLI said its sign-in no longer works (#1129): that sign-in shows *Sign in again* until the owner signs in again. A status check
 * (`recordSignIn`) sets it back too whenever the CLI's own status reports a login, which a revoked key still does (#1133): the next run
 * marks it again. Only a signed-in connection of that CLI changes.
 */
export async function markRuntimeSignInAgain(db: DbExecutor, bindingId: string, client: 'claude_code' | 'codex'): Promise<void> {
  await db.execute(sql`UPDATE agent_runtime_connections SET state = 'sign_in_again', signed_in_at = NULL
    WHERE binding_id = ${bindingId} AND client = ${client} AND state = 'signed_in' AND revoked_at IS NULL`);
}

/**
 * The provider's remaining usage of a plan, as a run just saw it (#854): Codex's own rate-limit read, or a limit the run
 * met. Display facts only (a share, a window, a time), on the owner's signed-in connection of that CLI.
 */
export async function recordRuntimeUsage(db: DbExecutor, bindingId: string, client: 'claude_code' | 'codex',
  usage: { leftPercent: number | null; window: 'five_hour' | 'weekly' | null; resetsAt: Date | null; limitReached: boolean }): Promise<void> {
  const left = usage.leftPercent === null ? null : Math.max(0, Math.min(100, Math.round(usage.leftPercent)));
  await db.execute(sql`UPDATE agent_runtime_connections SET usage_left_percent = ${left}, usage_window = ${usage.window},
    usage_resets_at = ${usage.resetsAt}, usage_limit_reached = ${usage.limitReached}, usage_read_at = now()
    WHERE binding_id = ${bindingId} AND client = ${client} AND state = 'signed_in' AND revoked_at IS NULL`);
}
