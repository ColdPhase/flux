import type { PlanModelEntry } from '@flux/contracts';
import { FAKE_CLAUDE_MODELS, FAKE_CODEX_MODELS } from '../../../apps/runtime/src/fakes/fake-models.js';
import { reduceClaudeModels, reduceCodexModels } from '../../../apps/runtime/src/supervisor/models.js';

// TEST SUPPORT ONLY (#1332): what the supervisor's reading of the fake CLIs leaves in a signed-in plan's row: the same reduction the slot
// applies to the shapes the pinned CLIs gave (Claude Code 2.1.285's `initialize` answer, Codex 0.160.1's `model/list`).

export const FAKE_PLAN_MODELS: Record<'claude_code' | 'codex', PlanModelEntry[]> = {
  claude_code: reduceClaudeModels(FAKE_CLAUDE_MODELS),
  codex: reduceCodexModels(FAKE_CODEX_MODELS),
};

/** Stores a plan's model list as a reading of its CLI would (listed now), for a connection a test signed in by hand. */
export async function seedPlanModels(pool: { query(text: string, values: unknown[]): Promise<{ rows: { id?: string }[] }> }, bindingId: string, client: 'claude_code' | 'codex',
  listed: readonly PlanModelEntry[] = FAKE_PLAN_MODELS[client], retired: readonly { id: string; name: string }[] = []) {
  const connection = (await pool.query(`UPDATE agent_runtime_connections SET models_status = 'listed', models_checked_at = now() WHERE binding_id = $1 AND client = $2 RETURNING id`,
    [bindingId, client])).rows[0]?.id;
  if (!connection) throw new Error('No connection to seed the models of');
  await pool.query('DELETE FROM agent_runtime_connection_models WHERE connection_id = $1', [connection]);
  const rows = [...listed.map((entry, index) => [entry.id, index, entry.name, entry.note, entry.default, entry.seesPictures, false] as const),
    ...retired.map((entry, index) => [entry.id, 1000 + index, entry.name, '', false, true, true] as const)];
  for (const row of rows) {
    await pool.query(`INSERT INTO agent_runtime_connection_models(connection_id, model_id, position, name, note, is_default, sees_pictures, retired) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [connection, ...row]);
  }
}
