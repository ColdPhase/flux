/**
 * Stopping an external agent's work on one task (F-026 S13, #347; docs/product/mcp-cowork.md).
 * A person ends the hold and the co-work claim; Flux reports what it did and cannot kill the local client.
 */
export const projectAgentStopsPath = (projectId: string) => `/api/v1/projects/${projectId}/agent-stops`;

export interface StopAgentCommand {
  /** The task the agent holds now. */
  taskId: string;
  /** The agent the person means; a stale view that names a different holder is refused (`AGENT_NOT_WORKING`). */
  agentId: string;
}

export interface AgentStop {
  id: string;
  taskId: string;
  taskNumber: number;
  taskTitle: string;
  agent: { id: string; name: string };
  stoppedBy: { id: string; name: string };
  stoppedAt: string;
  /** How many unfinished co-work units of the agent's connections ended with it. */
  unitsStopped: number;
}

/** The newest stops of a project, newest first. */
export interface AgentStops {
  projectId: string;
  stops: AgentStop[];
}

/**
 * The signed-in person's own agents that work on a task now, across their projects (the sidebar's working card, S13).
 * Only tasks in projects the person can read are listed; an agent owned by someone else never is.
 */
export const ownWorkingAgentsPath = '/api/v1/working-agents';

export interface OwnWorkingAgent {
  agent: { id: string; name: string };
  task: { id: string; projectId: string; projectName: string; number: number; title: string };
  /** True when one of the agent's unrevoked connections has an open client session now (the same rule as the Agents view). */
  online: boolean;
  /** True when a client has ever opened a session for the agent; false means it was never signed in (#347 review N11). */
  signedIn: boolean;
}

export interface OwnWorkingAgents {
  items: OwnWorkingAgent[];
}
