import { clientAvailability, runtimePayer, type AgentRuntimeConfig, type Database, type PersonalRuntimeAvailability } from '@flux/core';
import { personalRuntimeRow } from '@flux/db';

/**
 * What the API knows of the owner's own Claude Code for their assistant (F-022 AIM-3, #280): off unless the
 * operator enabled Claude Code in the agent runtime; otherwise the owner's sign-in as their slot's CLI last
 * reported it, with the payer that implies. Never another person's.
 */
export function personalRuntimeAvailability(config: AgentRuntimeConfig, db: Database): PersonalRuntimeAvailability {
  return {
    async standing(ownerUserId) {
      if (!config.manager || clientAvailability(config).claude_code !== 'available') return { state: 'off', payer: null, accountLabel: null };
      const row = await personalRuntimeRow(db, ownerUserId);
      return { state: row.state, payer: row.state === 'signed_in' ? runtimePayer(row.authMethod) : null, accountLabel: row.accountLabel };
    },
  };
}
