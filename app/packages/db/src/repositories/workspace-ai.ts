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
 * F-029 "AI origin" (`isAiOrigin` of the contract): an Inbox row that came from AI work, that is, from an event an agent
 * recorded (agent questions, assistant answers, proposals and changes, co-work requests and reviews from agents) or an
 * assistant join request. True while such a row's workspace has AI off: it is then left out of lists and counts, and
 * neither pushed nor e-mailed, including rows created before AI was turned off.
 */
export function hiddenWhileAiOff(n: { workspaceId: SQLWrapper; eventId: SQLWrapper; assistantJoinRequestId: SQLWrapper }): SQL<boolean> {
  return sql<boolean>`((${n.assistantJoinRequestId} IS NOT NULL OR EXISTS (SELECT 1 FROM events ai_event WHERE ai_event.id = ${n.eventId}
    AND ai_event.actor_id LIKE 'agent:%')) AND ${currentAiEpoch(n.workspaceId)} IS NULL)`;
}

/** The same decision for one notification row. */
export async function notificationHiddenWhileAiOff(db: DbExecutor, notificationId: string): Promise<boolean> {
  const result = await db.execute<{ hidden: boolean }>(sql`SELECT ${hiddenWhileAiOff({ workspaceId: sql`n.workspace_id`, eventId: sql`n.event_id`,
    assistantJoinRequestId: sql`n.assistant_join_request_id` })} AS hidden FROM notifications n WHERE n.id = ${notificationId}`);
  return result.rows[0]?.hidden === true;
}
