import { clientAvailability, runtimePayer, type AgentRuntimeConfig, type PersonalRuntimeAvailability, type PersonalRuntimeClient } from '@flux/core';
import { personalRuntimeRow, type Database } from '@flux/db';

/**
 * What the worker knows of the owner's own Claude Code or Codex when it starts a schedule's run (F-022 AIM-3, F-027 A8): off
 * unless the operator enabled that CLI; otherwise the owner's sign-in as their slot's CLI last reported it. The same reading as
 * the API's (apps/server/src/personal-runs/runtime.ts); the two composition roots do not import each other.
 */
export function workerRuntimeAvailability(config: AgentRuntimeConfig, db: Database): PersonalRuntimeAvailability {
  const available = (): PersonalRuntimeClient[] => {
    const states = clientAvailability(config);
    return (['claude_code', 'codex'] as const).filter((client) => states[client] === 'available');
  };
  return {
    async standing(ownerUserId, client) {
      const clients = available();
      if (!config.manager || !clients.length || (client && !clients.includes(client))) return { state: 'off', payer: null, accountLabel: null, client: null };
      const row = await personalRuntimeRow(db, ownerUserId, client ? [client] : clients);
      return { state: row.state, payer: row.state === 'signed_in' ? runtimePayer(row.authMethod) : null, accountLabel: row.accountLabel, client: row.client };
    },
  };
}
