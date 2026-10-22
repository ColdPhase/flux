import { pool } from './db.js';

/**
 * Test fixture for the workspace AI lock (F-029, #614). S1 has no route that changes the policy, so tests turn AI off
 * and on here, as the change will (state, epoch and version move together).
 */
export async function setWorkspaceAi(workspaceId: string, state: 'allowed' | 'blocked') {
  const result = await pool.query(`UPDATE workspace_ai_policies SET state = $2, epoch = epoch + 1, version = version + 1, changed_at = now()
    WHERE workspace_id = $1 RETURNING epoch::int AS epoch`, [workspaceId, state]);
  if (result.rowCount !== 1) throw new Error(`no AI policy row for workspace ${workspaceId}`);
  return (result.rows[0] as { epoch: number }).epoch;
}

export async function workspaceAiRow(workspaceId: string) {
  return (await pool.query('SELECT state, epoch::int AS epoch, version FROM workspace_ai_policies WHERE workspace_id = $1', [workspaceId])).rows[0] as
    { state: string; epoch: number; version: number } | undefined;
}

/** Turns AI back on only if a previous step left it off (keeps one failure from cascading into the next test). */
export async function ensureWorkspaceAiAllowed(workspaceId: string) {
  const row = await workspaceAiRow(workspaceId);
  if (row?.state !== 'allowed') await setWorkspaceAi(workspaceId, 'allowed');
}
