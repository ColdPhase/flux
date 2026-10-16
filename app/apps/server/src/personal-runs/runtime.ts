import { clientAvailability, runtimePayer, type AgentRuntimeConfig, type Database, type PersonalRuntimeAvailability, type PersonalRuntimeClient } from '@flux/core';
import { personalRuntimeRow } from '@flux/db';

/**
 * What the API knows of the owner's own Claude Code or Codex for their assistant (F-022 AIM-3, #280,
 * #281): off unless the operator enabled that CLI in the agent runtime; otherwise the owner's sign-in as
 * their slot's CLI last reported it, with the payer that implies. Never another person's. Without a
 * client, the owner's most recently signed-in available CLI.
 */
export function personalRuntimeAvailability(config: AgentRuntimeConfig, db: Database): PersonalRuntimeAvailability {
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
