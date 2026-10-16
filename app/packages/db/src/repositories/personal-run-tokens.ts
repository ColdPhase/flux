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
  projectId: string;
  conversationId: string;
  ownerUserId: string;
  agentId: string;
  status: typeof r.$inferSelect.status;
  engine: 'server' | 'runtime';
  runTokenNonceHash: string | null;
  runTokenJti: string | null;
  runTokenExpiresAt: Date | null;
  runTokenClosedAt: Date | null;
  runTools: string[];
  mcpResultBytes: number;
  mcpLimit: 'call' | 'run' | null;
  stopRequestedAt: Date | null;
}

const columns = {
  id: r.id, workspaceId: r.workspaceId, projectId: r.projectId, conversationId: r.conversationId, ownerUserId: r.ownerUserId,
  agentId: r.agentId, status: r.status, engine: r.engine, runTokenNonceHash: r.runTokenNonceHash, runTokenJti: r.runTokenJti,
  runTokenExpiresAt: r.runTokenExpiresAt, runTokenClosedAt: r.runTokenClosedAt, runTools: r.runTools, mcpResultBytes: r.mcpResultBytes,
  mcpLimit: r.mcpLimit, stopRequestedAt: r.stopRequestedAt,
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
     * The connection of the owner's assistant in a workspace (F-027 AST-3: one per person per workspace). The
     * mapping never changes once created, so it is read without a lock (S6 writers lock policy, then settings).
     */
    async assistantConnectionId(ownerUserId: string, workspaceId: string): Promise<string | null> {
      const [row] = await db.select({ connectionId: schema.assistantSettings.connectionId }).from(schema.assistantSettings)
        .where(and(eq(schema.assistantSettings.ownerUserId, ownerUserId), eq(schema.assistantSettings.workspaceId, workspaceId)));
      return row?.connectionId ?? null;
    },
  };
}
export type PersonalRunTokenRows = ReturnType<typeof personalRunTokenRows>;

/** The owner's own Claude Code in their runtime slot, for a personal run (F-022 AIM-3, #280). Display facts only. */
export interface PersonalRuntimeRow {
  state: 'signed_out' | 'sign_in_again' | 'signed_in';
  slot: string | null;
  bindingId: string | null;
  authMethod: string | null;
  accountLabel: string | null;
}

/**
 * The owner's live binding and its Claude Code connection: signed in only when the CLI's own status said
 * so (T4); *Sign in again* when either the binding or the connection says so; otherwise signed out.
 */
export async function personalRuntimeRow(db: DbExecutor, ownerUserId: string): Promise<PersonalRuntimeRow> {
  const result = await db.execute<{ id: string; slot: string; binding_state: string; connection_state: string | null; auth_method: string | null; account_label: string | null }>(sql`
    SELECT b.id, b.slot, b.state AS binding_state, c.state AS connection_state, c.auth_method, c.account_label
    FROM agent_runtime_bindings b
    LEFT JOIN agent_runtime_connections c ON c.binding_id = b.id AND c.client = 'claude_code' AND c.revoked_at IS NULL
    WHERE b.owner_user_id = ${ownerUserId} AND b.state <> 'released' LIMIT 1`);
  const row = result.rows[0];
  if (!row) return { state: 'signed_out', slot: null, bindingId: null, authMethod: null, accountLabel: null };
  const state = row.binding_state === 'sign_in_again' || row.connection_state === 'sign_in_again' ? 'sign_in_again'
    : row.binding_state === 'active' && row.connection_state === 'signed_in' ? 'signed_in' : 'signed_out';
  return { state, slot: row.slot, bindingId: row.id, authMethod: state === 'signed_in' ? row.auth_method : null, accountLabel: row.account_label };
}

/** A run used the binding: the operator's idle policy counts from here (F-022 "Bindings"). */
export async function touchRuntimeBinding(db: DbExecutor, bindingId: string): Promise<void> {
  await db.execute(sql`UPDATE agent_runtime_bindings SET last_used_at = now() WHERE id = ${bindingId} AND state = 'active'`);
}
