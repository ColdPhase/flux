import type { Principal } from '../principal.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';

// Where a run belongs (#842, F-036 AG-4). A space has its own AI switch and the people who read it; a direct message has its two or more
// participants and no switch; the private chat with an agent has only its owner. The processors ask these two questions at every
// standing check, so a run outside a space is not held to a space's switch and a run in a space is held to it exactly as before.

type Placed = Pick<RunRecord, 'ownerUserId' | 'agentId' | 'projectId' | 'dmId' | 'aiEpoch'>;

/** AG-10, first: AI is on in the run's space at the epoch it was admitted under. A run in a DM or a chat has no space, so no switch. */
export async function spaceSwitchAllows(ports: PersonalRunPorts, run: Placed, lock: boolean): Promise<boolean> {
  if (run.projectId === null) return true;
  const ai = await ports.access.spaceAi(run.projectId, { lock });
  return ai.state === 'allowed' && ai.epoch === run.aiEpoch;
}

/**
 * The owner's standing at the run's place now, and the agent's where it reads: in a space the owner writes (the answer is theirs to post)
 * and the agent reads; in a DM the owner still takes part; in a chat there is nothing besides the agent itself, which the caller checks.
 * Throws the policy's refusal for an unreadable place; the caller reads that as `denied`.
 */
export async function placeAllows(ports: PersonalRunPorts, run: Placed, lock: boolean): Promise<boolean> {
  const owner: Principal = { kind: 'human', id: run.ownerUserId };
  if (run.projectId !== null) {
    const agent: Principal = { kind: 'agent', id: run.agentId };
    return (await ports.access.canUseProject(owner, 'write', run.projectId, { lock })) && (await ports.access.canUseProject(agent, 'read', run.projectId, { lock }));
  }
  if (run.dmId !== null) return ports.access.canUseDm(owner, run.dmId, { lock });
  return true;
}
