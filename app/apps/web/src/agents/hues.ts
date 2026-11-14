import { useShellData } from '../app/data';
import type { AgentHue } from '../ui';

/**
 * An agent's own colour, wherever it appears (final design §2: Messages, the Owner picker, a task's owner and discussion, Home, the
 * Inbox and Settings › AI). The shell holds the colour of the person's own agents; another person's agent has none to show yet, so its
 * Kreska stays ink (as an answer posted before it had a colour does).
 */
export function useAgentHue(): (agentId: string | null | undefined) => AgentHue | undefined {
  const { agents } = useShellData();
  return (agentId) => (agentId ? agents.find((agent) => agent.id === agentId)?.colour : undefined);
}
