import { agentProjectPolicyPath, projectAgentsPath, type AgentProjectPolicy, type ProjectAgents, type PublishAgentProjectPolicyCommand } from '@flux/contracts';
import { request } from '../api/client';

/** The Agents view of a project (UI116-2, #136): current connections. */
export const getProjectAgents = (projectId: string, signal?: AbortSignal) => request<ProjectAgents>(projectAgentsPath(projectId), { signal });

/** The project's approved agent policy (#160, CW-1): null before the first publish. Every project reader may read it. */
export const getAgentPolicy = (projectId: string, signal?: AbortSignal) =>
  request<{ policy: AgentProjectPolicy | null }>(agentProjectPolicyPath(projectId), { signal });

/**
 * A project manager publishes the next revision from the one they loaded (`expectedRevision`). A stale revision is
 * `409 VERSION_CONFLICT` with the newer policy as `current`; the key makes a retry after a lost answer publish once.
 */
export const publishAgentPolicy = (projectId: string, command: PublishAgentProjectPolicyCommand, idempotencyKey: string) =>
  request<AgentProjectPolicy>(agentProjectPolicyPath(projectId), { method: 'PUT', body: command, headers: { 'idempotency-key': idempotencyKey } });
