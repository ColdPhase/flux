import type { AgentColour } from '@flux/contracts';
import { useShellData } from '../app/data';
import type { AgentHue } from '../ui';

/** An agent as a read names it: every read gives an agent its colour (#1528); an agent without one (a local client's) is ink. */
export type ColouredAgent = { id: string; colour?: AgentColour | undefined };

/**
 * An agent's own colour, wherever it appears and for whoever reads it (final design §2: Messages, the Owner picker, a task's owner and
 * discussion, Home, the Inbox and Settings › AI). The read that names the agent carries it; the shell's list of the reader's own agents
 * answers for a place that names one of them by its id alone (the Owner picker's options).
 */
export function useAgentHue(): (agent: ColouredAgent | string | null | undefined) => AgentHue | undefined {
  const { agents } = useShellData();
  return (agent) => {
    if (!agent) return undefined;
    if (typeof agent !== 'string' && agent.colour) return agent.colour;
    const id = typeof agent === 'string' ? agent : agent.id;
    return agents.find((own) => own.id === id)?.colour;
  };
}
