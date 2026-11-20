import { AI_PROVIDERS } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';

// Where a run belongs (#842, F-036 AG-4). A space has its own AI switch and the people who read it; a direct message has its two or more
// participants and each one's "AI off" (C-73); the private chat with an agent has only its owner. The processors ask these two questions at every
// standing check, so a run outside a space is not held to a space's switch and a run in a space is held to it exactly as before.

type Placed = Pick<RunRecord, 'ownerUserId' | 'agentId' | 'projectId' | 'dmId' | 'aiEpoch'>;

/**
 * The one AI question of a run, asked at every standing check and by the model gateway before every model request. AG-10: AI is on in
 * the run's space at the epoch it was admitted under. C-73 (#1591): no direct message whose words the run reads or was given (its own,
 * or one its private chat read) has AI off; nothing of such a conversation may reach a model.
 */
export async function aiSwitchAllows(ports: PersonalRunPorts, run: Placed & Pick<RunRecord, 'id'>, lock: boolean): Promise<boolean> {
  if (run.projectId !== null) {
    const ai = await ports.access.spaceAi(run.projectId, { lock });
    return ai.state === 'allowed' && ai.epoch === run.aiEpoch;
  }
  return !(await ports.runs.readsDmWithAiOff(run, { lock }));
}

/** Who receives a conversation when AI is used on it: "Claude", "ChatGPT", or the key's provider (#842, the line of a DM). */
export const aiCompany = (engine: string, provider: string) => engine === 'runtime' ? (provider === 'openai' ? 'ChatGPT' : 'Claude')
  : provider === 'anthropic' ? 'Claude' : AI_PROVIDERS[provider as keyof typeof AI_PROVIDERS]?.label ?? 'an AI provider';

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
