import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { AiScopeKind } from '@flux/contracts';
import type { DbExecutor } from './push.js';

/**
 * SQL for the workspace AI lock (F-029, #614; docs/product/workspace-ai-lock.md). These fragments make no access
 * decision: the caller has already checked the policy (`requireWorkspaceAi` in @flux/core, which holds the row
 * `FOR SHARE`), and the `ai_work_admission` trigger is the backstop.
 */

/** The current epoch of a workspace whose AI is allowed; NULL when it is off or the row is missing. */
export function currentAiEpoch(workspaceId: SQLWrapper | string): SQL<number> {
  return sql<number>`(SELECT ai.epoch FROM workspace_ai_policies ai WHERE ai.workspace_id = ${workspaceId} AND ai.state = 'allowed')`;
}

/** The same for the workspace of a project. */
export function currentProjectAiEpoch(projectId: SQLWrapper | string): SQL<number> {
  return sql<number>`(SELECT ai.epoch FROM workspace_ai_policies ai JOIN projects ai_project ON ai_project.workspace_id = ai.workspace_id
    WHERE ai_project.id = ${projectId} AND ai.state = 'allowed')`;
}

/** An AI work row may continue only while AI is allowed in its workspace at the epoch it was admitted under. */
export function aiEpochIsCurrent(epoch: SQLWrapper, workspaceId: SQLWrapper): SQL {
  return sql`${epoch} = ${currentAiEpoch(workspaceId)}`;
}

/** Where each object an AI route names keeps its workspace (F-029): its own column, or its project's. */
const SCOPE_SQL: Record<AiScopeKind, (id: string) => SQL> = {
  workspace: (id) => sql`SELECT id FROM workspaces WHERE id = ${id}`,
  project: (id) => sql`SELECT workspace_id AS id FROM projects WHERE id = ${id}`,
  conversation: (id) => sql`SELECT workspace_id AS id FROM project_conversations WHERE id = ${id}`,
  work: (id) => sql`SELECT workspace_id AS id FROM project_work_items WHERE id = ${id}`,
  agent: (id) => sql`SELECT workspace_id AS id FROM agents WHERE id = ${id}`,
  connection: (id) => sql`SELECT workspace_id AS id FROM agent_connections WHERE id = ${id}`,
  run: (id) => sql`SELECT workspace_id AS id FROM personal_runs WHERE id = ${id}`,
  assistant_proposal: (id) => sql`SELECT workspace_id AS id FROM assistant_proposals WHERE id = ${id}`,
  assistant_change: (id) => sql`SELECT workspace_id AS id FROM assistant_changes WHERE id = ${id}`,
  agent_question: (id) => sql`SELECT workspace_id AS id FROM agent_questions WHERE id = ${id}`,
  comparison_rule: (id) => sql`SELECT workspace_id AS id FROM proactive_comparison_rules WHERE id = ${id}`,
  comparison_proposal: (id) => sql`SELECT p.workspace_id AS id FROM proactive_comparison_proposals t JOIN projects p ON p.id = t.project_id WHERE t.id = ${id}`,
  comparison_outcome: (id) => sql`SELECT p.workspace_id AS id FROM proactive_comparison_insufficient_outcomes t JOIN projects p ON p.id = t.project_id WHERE t.id = ${id}`,
  assistant_join: (id) => sql`SELECT workspace_id AS id FROM assistant_join_requests WHERE id = ${id}`,
  assistant_job: (id) => sql`SELECT workspace_id AS id FROM assistant_jobs WHERE id = ${id}`,
  notification: (id) => sql`SELECT workspace_id AS id FROM notifications WHERE id = ${id}`,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The workspace of one object an AI route names, or null when it does not exist (the route then answers as usual). */
export async function workspaceIdOfAiScope(db: DbExecutor, kind: AiScopeKind, id: unknown): Promise<string | null> {
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  const result = await db.execute<{ id: string }>(SCOPE_SQL[kind](id));
  return result.rows[0]?.id ?? null;
}

/**
 * F-029 "AI origin" (`isAiOrigin` of the contract): the row's own `ai_origin` flag, which its writer set from the actor or
 * the source (an agent's message, decision or result, an assistant's suggestion, note, join request or assistant-written
 * summary). True while the row's workspace has AI off: it is then left out of lists, counts, Needs you and the plain
 * morning summary, and neither pushed nor e-mailed, including rows created before AI was turned off.
 */
export function hiddenWhileAiOff(n: { workspaceId: SQLWrapper; aiOrigin: SQLWrapper }): SQL<boolean> {
  return sql<boolean>`(${n.aiOrigin} AND ${currentAiEpoch(n.workspaceId)} IS NULL)`;
}

/** The same decision for one notification row. */
export async function notificationHiddenWhileAiOff(db: DbExecutor, notificationId: string): Promise<boolean> {
  const result = await db.execute<{ hidden: boolean }>(sql`SELECT ${hiddenWhileAiOff({ workspaceId: sql`n.workspace_id`, aiOrigin: sql`n.ai_origin` })} AS hidden
    FROM notifications n WHERE n.id = ${notificationId}`);
  return result.rows[0]?.hidden === true;
}

/** One personal run the sweep ended or asked to stop, for its owner's progress events. */
export interface SweptRun { id: string; workspaceId: string; projectId: string; conversationId: string; ownerUserId: string; agentId: string; status: string }

/**
 * The turn-off sweep of F-029 (S2) for one workspace and the epoch `E` its flip set. It touches only work admitted under an
 * older epoch (`ai_epoch < E`), whatever the current state: work admitted after a later re-enable is never touched, and a
 * late sweep still ends everything admitted before the flip. Idempotent. Deletes nothing. Makes no access decision.
 */
export function workspaceAiSweepRows(db: DbExecutor) {
  const runColumns = sql`id, workspace_id AS "workspaceId", project_id AS "projectId", conversation_id AS "conversationId",
    owner_user_id AS "ownerUserId", agent_id AS "agentId", status`;
  const rows = async <T>(query: SQL) => (await db.execute(query)).rows as T[];
  return {
    /** Queued runs end before reading, their reservation released. */
    endQueuedRuns: (workspaceId: string, epoch: number) => rows<SweptRun>(sql`UPDATE personal_runs SET status = 'stopped', stopped_at_stage = 'before_read',
      cost_state = 'released', charged_micros = 0, end_reason = 'ai_off', completed_at = now(), updated_at = now()
      WHERE workspace_id = ${workspaceId} AND ai_epoch < ${epoch} AND status = 'queued' RETURNING ${runColumns}`),
    /** Runs that are reading or dispatching are asked to stop: the 250 ms watchers abort the provider request or stop the CLI. */
    stopInFlightRuns: (workspaceId: string, epoch: number) => rows<SweptRun>(sql`UPDATE personal_runs SET stop_requested_at = now(), updated_at = now()
      WHERE workspace_id = ${workspaceId} AND ai_epoch < ${epoch} AND status IN ('reading', 'dispatching') AND stop_requested_at IS NULL RETURNING ${runColumns}`),
    async closeRunTokens(workspaceId: string, epoch: number) {
      return (await db.execute(sql`UPDATE personal_runs SET run_token_closed_at = now(), updated_at = now()
        WHERE workspace_id = ${workspaceId} AND ai_epoch < ${epoch} AND run_token_jti IS NOT NULL AND run_token_closed_at IS NULL`)).rowCount ?? 0;
    },
    /** Comparisons that have not started their provider request end `not_run`; one in flight is aborted by its watcher. */
    async endComparisons(workspaceId: string, epoch: number) {
      // As every not_run end does (proactive_comparison_outbox_lifecycle_check): the reservation and its connection are released.
      return (await db.execute(sql`UPDATE proactive_comparison_outbox q SET status = 'not_run', failure_code = 'AI_OFF', reserved_cents = 0,
        connection_id = NULL, reserved_at = NULL, dispatch_started_at = NULL,
        usage_input_tokens = 0, usage_output_tokens = 0, usage_estimated_cents = 0, finished_at = now(), updated_at = now()
        FROM projects p WHERE p.id = q.project_id AND p.workspace_id = ${workspaceId} AND q.ai_epoch < ${epoch}
          AND (q.status = 'queued' OR (q.status = 'reserved' AND q.dispatch_started_at IS NULL))`)).rowCount ?? 0;
    },
    async skipReactionEvents(workspaceId: string, epoch: number) {
      return (await db.execute(sql`UPDATE assistant_reaction_events e SET state = 'skipped', line = 'Skipped: AI was turned off', finished_at = now()
        FROM assistant_reactions r WHERE r.id = e.reaction_id AND r.workspace_id = ${workspaceId} AND e.ai_epoch < ${epoch}
          AND e.state IN ('queued', 'proof')`)).rowCount ?? 0;
    },
    async cancelRequests(workspaceId: string, epoch: number) {
      return (await db.execute(sql`UPDATE cowork_requests SET state = 'cancelled', reason = 'ai_off', version = version + 1, updated_at = clock_timestamp()
        WHERE workspace_id = ${workspaceId} AND ai_epoch < ${epoch} AND state IN ('queued', 'deferred', 'claimed')`)).rowCount ?? 0;
    },
    /**
     * Units stop and release their lease, with a new generation, as a revoked connection's units do (cowork_stop_connection_units);
     * the task itself is unchanged. The same lock order as a claim: connection slots, then tasks, then units, each sorted.
     */
    async stopUnits(workspaceId: string, epoch: number) {
      const open = sql`workspace_id = ${workspaceId} AND ai_epoch < ${epoch} AND state IN ('pending', 'claimed', 'paused')`;
      await db.execute(sql`SELECT connection_id FROM cowork_connection_slots WHERE workspace_id = ${workspaceId}
        AND connection_id IN (SELECT assignment_connection_id FROM cowork_units WHERE ${open}) ORDER BY connection_id FOR UPDATE`);
      await db.execute(sql`SELECT id FROM project_work_items WHERE id IN (SELECT work_id FROM cowork_units WHERE ${open}) ORDER BY id FOR UPDATE`);
      await db.execute(sql`SELECT id FROM cowork_units WHERE ${open} ORDER BY id FOR UPDATE`);
      return (await db.execute(sql`UPDATE cowork_units SET state = 'stopped', generation = generation + 1, lease_id = NULL, lease_session_id = NULL,
        lease_expires_at = NULL, version = version + 1, updated_at = clock_timestamp() WHERE ${open}`)).rowCount ?? 0;
    },
    async revokeSessions(workspaceId: string, epoch: number) {
      return (await db.execute(sql`UPDATE agent_runtime_sessions SET revoked_at = now()
        WHERE workspace_id = ${workspaceId} AND ai_epoch < ${epoch} AND revoked_at IS NULL`)).rowCount ?? 0;
    },
  };
}
export type WorkspaceAiSweepRows = ReturnType<typeof workspaceAiSweepRows>;
