import { AGENT_MAY_DO_LABELS, assistantModelName, type AssistantModelChoice, type MyAgent } from '@flux/contracts';

/** "Opus", and with the connection "Opus · Claude plan" when the person has more than one (the list's second line). */
export function modelLine(agent: Pick<MyAgent, 'model'>, choice: AssistantModelChoice | null): { name: string; connection: string } {
  const group = choice?.groups.find((item) => item.connection === agent.model.connection);
  const option = group?.options.find((item) => item.id === agent.model.model);
  return { name: option?.name ?? assistantModelName(agent.model.model), connection: group?.label ?? '' };
}

/** Its tag: "Ask me first on" or "Ask me first off", the name of the switch on its page (AG-3, #1419, #1424). */
export const mayDoLabel = (agent: Pick<MyAgent, 'mayDo'>) => AGENT_MAY_DO_LABELS[agent.mayDo];

/** The first line of the instructions, as the one line about what the agent is for in the list. */
export const jobLine = (agent: Pick<MyAgent, 'instructions'>): string => agent.instructions.split('\n').map((line) => line.trim()).find(Boolean) ?? '';

/** The one label of an agent everywhere (final design §1): "Planner · Ada's agent". */
export const agentLabel = (name: string, ownerFirstName: string) => `${name} · ${ownerFirstName}'s agent`;
