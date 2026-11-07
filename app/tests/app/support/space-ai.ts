import { pool } from './db.js';

/**
 * Test fixture for the AI switch of a space (F-037, AG-10; F-029, #614): turns AI off and on directly, as the flip does (the
 * state and the epoch move together), without the sweep.
 */
export async function setSpaceAi(projectId: string, state: 'allowed' | 'blocked') {
  const result = await pool.query(`UPDATE project_ai_policies SET state = $2, epoch = epoch + 1, changed_at = now()
    WHERE project_id = $1 RETURNING epoch::int AS epoch`, [projectId, state]);
  if (result.rowCount !== 1) throw new Error(`no AI policy row for space ${projectId}`);
  return (result.rows[0] as { epoch: number }).epoch;
}

export async function spaceAiRow(projectId: string) {
  return (await pool.query('SELECT state, epoch::int AS epoch FROM project_ai_policies WHERE project_id = $1', [projectId])).rows[0] as
    { state: string; epoch: number } | undefined;
}

/** Turns AI back on only if a previous step left it off (keeps one failure from cascading into the next test). */
export async function ensureSpaceAiAllowed(projectId: string) {
  const row = await spaceAiRow(projectId);
  if (row?.state !== 'allowed') await setSpaceAi(projectId, 'allowed');
}
