import { AGENT_MAY_DO_LABELS, assistantModelName, type AssistantModelChoice, type MyAgent } from '@flux/contracts';

/**
 * What an agent runs on, in words (#1424, founder decision 2026-11-14: agents use "your AI"). "Opus", and "Opus · Claude plan" only for a person
 * who has several connections. An agent whose connection is gone says "Needs a connection" and never the name of a model of a key that is no
 * longer there; while the choice is still loading there is nothing to say yet.
 */
export function modelLine(agent: Pick<MyAgent, 'model'>, choice: AssistantModelChoice | null): { name: string; connection: string; needsConnection: boolean } {
  if (!choice) return { name: '', connection: '', needsConnection: false };
  const group = choice.groups.find((item) => item.connection === agent.model.connection);
  if (!group) return { name: 'Needs a connection', connection: '', needsConnection: true };
  const option = group.options.find((item) => item.id === agent.model.model);
  return { name: option?.name ?? assistantModelName(agent.model.model), connection: choice.groups.length > 1 ? group.label : '', needsConnection: false };
}

/** Its tag: "Do it and tell me", or "Ask me first" with that switch on (AG-3, #1419). */
export const mayDoLabel = (agent: Pick<MyAgent, 'mayDo'>) => AGENT_MAY_DO_LABELS[agent.mayDo];

/** The first line of the instructions, as the one line about what the agent is for in the list. */
export const jobLine = (agent: Pick<MyAgent, 'instructions'>): string => agent.instructions.split('\n').map((line) => line.trim()).find(Boolean) ?? '';

/** The one label of an agent everywhere (final design §1): "Planner · Ada's agent". */
export const agentLabel = (name: string, ownerFirstName: string) => `${name} · ${ownerFirstName}'s agent`;
