import { RUN_TOKEN_LIMITS } from '@flux/contracts';
import { DomainError, requireWorkspaceAi, type Database, type Transaction } from '@flux/core';
import { personalRunTokenRows } from '@flux/db';
import { toolError } from './tool-results.js';

// A personal run's MCP token at the MCP route (F-022 "Agent connection and permissions", F-027 A2/AST-8,
// #280/#484). It is an ordinary signed bearer of the owner's assistant connection, with `flux_run_id`
// and `flux_place`. On top of the route's checks for every bearer, a run token works only while its run
// is in flight and its id is the one minted for that run; it reaches only the run's place; the route
// lists exactly the run's tools; and tool results are bounded per call and per run.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The run a verified bearer names, from its signed claims only. */
export interface RunTokenClaims {
  id: string;
  jti: string;
  projectId: string;
  conversationId: string;
  /** The run's exact tools that the owner's switches still allow, set by the route before dispatch. */
  tools: readonly string[];
}

/** Null for an ordinary bearer; `invalid` for a bearer whose run claims are malformed (403). */
export function runTokenClaims(token: Record<string, unknown>): Omit<RunTokenClaims, 'tools'> | null | 'invalid' {
  if (token.flux_run_id === undefined && token.flux_place === undefined) return null;
  const place = token.flux_place;
  if (typeof token.flux_run_id !== 'string' || !UUID.test(token.flux_run_id) || typeof token.jti !== 'string' || !UUID.test(token.jti)
    || !place || typeof place !== 'object' || Array.isArray(place)) return 'invalid';
  const { project, conversation } = place as Record<string, unknown>;
  if (typeof project !== 'string' || !UUID.test(project) || typeof conversation !== 'string' || !UUID.test(conversation)) return 'invalid';
  return { id: token.flux_run_id, jti: token.jti, projectId: project, conversationId: conversation };
}

export const runEnded = () => new DomainError(403, 'RUN_TOKEN_UNAVAILABLE', 'This assistant run has ended');

/**
 * The run behind a run token, live: in flight, the token's own id, not closed or expired, the token's
 * place, and the owner's assistant connection in the run's workspace. `newCall` also refuses once a
 * result bound was reached (the response that reached it is still delivered). Throws 403 otherwise.
 */
export async function requireLiveRun(tx: Transaction, claims: { ownerUserId: string; connectionId: string; run: Omit<RunTokenClaims, 'tools'> },
  options: { newCall: boolean; lock?: boolean }) {
  const rows = personalRunTokenRows(tx);
  const row = await rows.find(claims.run.id, options.lock ? { lock: 'share' } : {});
  if (!row || row.reactionActive === false || row.ownerUserId !== claims.ownerUserId || (row.status !== 'reading' && row.status !== 'dispatching')
    || row.runTokenJti !== claims.run.jti || row.runTokenClosedAt !== null || !row.runTokenExpiresAt || row.runTokenExpiresAt.getTime() <= Date.now()
    || row.projectId !== claims.run.projectId || row.conversationId !== claims.run.conversationId || row.stopRequestedAt !== null
    || (options.newCall && row.mcpLimit !== null)) throw runEnded();
  if (await rows.assistantConnectionId(row.ownerUserId, row.workspaceId) !== claims.connectionId) throw runEnded();
  // F-029: the run works only while AI is on in its workspace, at the epoch it was admitted under.
  await requireWorkspaceAi(tx, row.workspaceId, { lock: options.lock ?? false, epoch: row.aiEpoch });
  return row;
}

type ToolOutput = { content?: unknown; isError?: boolean };

/**
 * Bounds what tools return to a run token (F-022 "Caps"): at most 16 KiB per result and 64 KiB per run,
 * counted by the bytes of the result's content. A result past either bound is not returned; the run
 * records which bound it reached, and the worker ends the run in its own state.
 */
export async function boundRunResult<T extends ToolOutput>(db: Database, runId: string, result: T): Promise<T | ReturnType<typeof toolError>> {
  const bytes = Buffer.byteLength(JSON.stringify(result?.content ?? []), 'utf8');
  if (bytes > RUN_TOKEN_LIMITS.resultBytesPerCall) {
    await db.transaction((tx) => personalRunTokenRows(tx).markMcpLimit(runId, 'call'));
    return toolError(new DomainError(413, 'MCP_RESULT_TOO_LARGE', 'This result is larger than one assistant run may receive; the run stops'));
  }
  if (!await db.transaction((tx) => personalRunTokenRows(tx).addResultBytes(runId, bytes, RUN_TOKEN_LIMITS.resultBytesPerRun))) {
    await db.transaction((tx) => personalRunTokenRows(tx).markMcpLimit(runId, 'run'));
    return toolError(new DomainError(413, 'MCP_RESULTS_TOO_LARGE', 'This run has read as much as one assistant run may; the run stops'));
  }
  return result;
}
