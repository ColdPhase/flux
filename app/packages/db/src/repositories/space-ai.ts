import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { AiScopeKind } from '@flux/contracts';
import type { DbExecutor } from './push.js';
import { companyGuestSql } from './access.js';

/**
 * SQL for the AI switch of a space (F-037, #874, AG-10; it replaces the workspace AI lock of F-029). These fragments make no
 * access decision: the caller has already checked the switch (`requireSpaceAi` in @flux/core, which holds the row `FOR SHARE`),
 * and the `ai_work_admission` trigger is the backstop. Every AI work row belongs to one space.
 */

/** The current epoch of a space whose AI is on; NULL when it is off or the row is missing. */
export function currentAiEpoch(projectId: SQLWrapper | string): SQL<number> {
  return sql<number>`(SELECT ai.epoch FROM project_ai_policies ai WHERE ai.project_id = ${projectId} AND ai.state = 'allowed')`;
}

/** An AI work row may continue only while AI is on in its space at the epoch it was admitted under. */
export function aiEpochIsCurrent(epoch: SQLWrapper, projectId: SQLWrapper): SQL {
  return sql`${epoch} = ${currentAiEpoch(projectId)}`;
}

/** Where each object an AI route names keeps its space: its own column. Kinds that belong to a person, not a space, have none. */
const SCOPE_SQL: Record<AiScopeKind, ((id: string) => SQL) | null> = {
  project: (id) => sql`SELECT id FROM projects WHERE id = ${id}`,
  conversation: (id) => sql`SELECT project_id AS id FROM project_conversations WHERE id = ${id}`,
  work: (id) => sql`SELECT project_id AS id FROM project_work_items WHERE id = ${id}`,
  run: (id) => sql`SELECT project_id AS id FROM personal_runs WHERE id = ${id}`,
  assistant_change: (id) => sql`SELECT project_id AS id FROM assistant_changes WHERE id = ${id}`,
  agent_question: (id) => sql`SELECT project_id AS id FROM agent_questions WHERE id = ${id}`,
  assistant_job: (id) => sql`SELECT project_id AS id FROM assistant_jobs WHERE id = ${id}`,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The space of one object an AI route names, or null when it does not exist or belongs to no space (the route then answers as usual). */
export async function projectIdOfAiScope(db: DbExecutor, kind: AiScopeKind, id: unknown): Promise<string | null> {
  const scope = SCOPE_SQL[kind];
  if (!scope || typeof id !== 'string' || !UUID.test(id)) return null;
  const result = await db.execute<{ id: string }>(scope(id));
  return result.rows[0]?.id ?? null;
}

/**
 * F-029 "AI origin" (`isAiOrigin` of the contract): the row's own `ai_origin` flag, which its writer set from the actor or
 * the source (an agent's message or decision, an assistant's suggestion, note or join request). True while the space
 * it is about has AI off: it is then left out of lists, counts and Needs you, and neither pushed nor e-mailed, including rows
 * created before AI was turned off.
 */
export function hiddenWhileAiOff(n: { sourceType: SQLWrapper; sourceId: SQLWrapper; aiOrigin: SQLWrapper }): SQL<boolean> {
  return sql<boolean>`(${n.aiOrigin} AND ${n.sourceType} = 'project' AND ${currentAiEpoch(n.sourceId)} IS NULL)`;
}

/**
 * The notices of a person's own assistant stay with the person's AI, which is kept but hidden while they are a guest of the company (C-50,
 * #1059): the one kind written without a reason about a space, with AI origin, is a paused schedule (`assistantJobRows.notify`). Every other
 * AI-origin row (an agent's message, an assistant's suggestion) is about shared work and stays for a guest who can read it.
 */
export function assistantNoticeOfGuest(n: { userId: SQLWrapper; sourceType: SQLWrapper; aiOrigin: SQLWrapper; reason: SQLWrapper }): SQL<boolean> {
  return sql<boolean>`(${n.aiOrigin} AND ${n.sourceType} = 'project' AND ${n.reason} IS NULL AND ${companyGuestSql(n.userId)})`;
}

/** Whether the Inbox, its count and the pushes and e-mails leave a notification out: AI is off in its space, or it is a guest's own assistant's notice. */
export function hiddenNotice(n: { userId: SQLWrapper; sourceType: SQLWrapper; sourceId: SQLWrapper; aiOrigin: SQLWrapper; reason: SQLWrapper }): SQL<boolean> {
  return sql<boolean>`(${hiddenWhileAiOff(n)} OR ${assistantNoticeOfGuest(n)})`;
}

/** The same decision for one notification row. */
export async function notificationHiddenWhileAiOff(db: DbExecutor, notificationId: string): Promise<boolean> {
  const result = await db.execute<{ hidden: boolean }>(sql`SELECT ${hiddenNotice({ userId: sql`n.user_id`, sourceType: sql`n.source_type`, sourceId: sql`n.source_id`, aiOrigin: sql`n.ai_origin`, reason: sql`n.reason` })} AS hidden
    FROM notifications n WHERE n.id = ${notificationId}`);
  return result.rows[0]?.hidden === true;
}

/** One personal run the sweep ended or asked to stop, for its owner's progress events. */
export interface SweptRun { id: string; workspaceId: string; projectId: string; conversationId: string; ownerUserId: string; agentId: string; status: string }

/**
 * The turn-off sweep (AG-10) for one space and the epoch `E` its flip set. It touches only work admitted under an older epoch
 * (`ai_epoch < E`), whatever the current state: work admitted after a later re-enable is never touched, and a late sweep still
 * ends everything admitted before the flip. Idempotent. Deletes nothing. Makes no access decision.
 */
export function spaceAiSweepRows(db: DbExecutor) {
  const runColumns = sql`id, workspace_id AS "workspaceId", project_id AS "projectId", conversation_id AS "conversationId",
    owner_user_id AS "ownerUserId", agent_id AS "agentId", status`;
  const rows = async <T>(query: SQL) => (await db.execute(query)).rows as T[];
  return {
    /** Queued runs end before reading, their reservation released. */
    endQueuedRuns: (projectId: string, epoch: number) => rows<SweptRun>(sql`UPDATE personal_runs SET status = 'stopped', stopped_at_stage = 'before_read',
      cost_state = 'released', charged_micros = 0, end_reason = 'ai_off', completed_at = now(), updated_at = now()
      WHERE project_id = ${projectId} AND ai_epoch < ${epoch} AND status = 'queued' RETURNING ${runColumns}`),
    /** Runs that are reading or dispatching are asked to stop: the 250 ms watchers abort the provider request or stop the CLI. */
    stopInFlightRuns: (projectId: string, epoch: number) => rows<SweptRun>(sql`UPDATE personal_runs SET stop_requested_at = now(), updated_at = now()
      WHERE project_id = ${projectId} AND ai_epoch < ${epoch} AND status IN ('reading', 'dispatching') AND stop_requested_at IS NULL RETURNING ${runColumns}`),
    async closeRunTokens(projectId: string, epoch: number) {
      return (await db.execute(sql`UPDATE personal_runs SET run_token_closed_at = now(), updated_at = now()
        WHERE project_id = ${projectId} AND ai_epoch < ${epoch} AND run_token_jti IS NOT NULL AND run_token_closed_at IS NULL`)).rowCount ?? 0;
    },
    /**
     * Units stop and release their lease, with a new generation, as a revoked connection's units do (cowork_stop_connection_units);
     * the task itself is unchanged. The same lock order as a claim: connection slots, then tasks, then units, each sorted.
     */
    async stopUnits(projectId: string, epoch: number) {
      const open = sql`project_id = ${projectId} AND ai_epoch < ${epoch} AND state IN ('pending', 'claimed', 'paused')`;
      await db.execute(sql`SELECT connection_id FROM cowork_connection_slots
        WHERE connection_id IN (SELECT assignment_connection_id FROM cowork_units WHERE ${open}) ORDER BY connection_id FOR UPDATE`);
      await db.execute(sql`SELECT id FROM project_work_items WHERE id IN (SELECT work_id FROM cowork_units WHERE ${open}) ORDER BY id FOR UPDATE`);
      await db.execute(sql`SELECT id FROM cowork_units WHERE ${open} ORDER BY id FOR UPDATE`);
      return (await db.execute(sql`UPDATE cowork_units SET state = 'stopped', generation = generation + 1, lease_id = NULL, lease_session_id = NULL,
        lease_expires_at = NULL, version = version + 1, updated_at = clock_timestamp() WHERE ${open}`)).rowCount ?? 0;
    },
  };
}
