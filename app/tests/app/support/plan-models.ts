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
export async function seedPlanModels(pool: { query(text: string, values: unknown[]): Promise<unknown> }, bindingId: string, client: 'claude_code' | 'codex',
  listed: readonly PlanModelEntry[] = FAKE_PLAN_MODELS[client], retired: readonly { id: string; name: string }[] = []) {
  await pool.query(`UPDATE agent_runtime_connections SET models = $3::jsonb, models_status = 'listed', models_checked_at = now() WHERE binding_id = $1 AND client = $2`,
    [bindingId, client, JSON.stringify({ listed, retired })]);
}
