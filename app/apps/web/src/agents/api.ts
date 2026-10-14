import { agentProjectPolicyPath, agentQuestionAnswerPath, ownWorkingAgentsPath, projectAgentQuestionsPath, projectAgentStopsPath, projectAgentsPath,
  type AgentProjectPolicy, type AgentQuestion, type AgentQuestions, type AgentStop, type AgentStops, type AnswerAgentQuestionCommand, type OwnWorkingAgents,
  type ProjectAgents, type PublishAgentProjectPolicyCommand, type StopAgentCommand } from '@flux/contracts';
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

/** Who stopped which agent's work in a project, newest first (S13, #347). */
export const getAgentStops = (projectId: string, signal?: AbortSignal) => request<AgentStops>(projectAgentStopsPath(projectId), { signal });

/**
 * Ends an agent's hold on a task. The key makes a retry after a lost answer stop once; a task the agent no longer holds
 * is `409 AGENT_NOT_WORKING` and a person who may not stop it `403 STOP_NOT_ALLOWED`.
 */
export const stopAgent = (projectId: string, command: StopAgentCommand, idempotencyKey: string) =>
  request<AgentStop>(projectAgentStopsPath(projectId), { method: 'POST', body: command, headers: { 'idempotency-key': idempotencyKey } });

/** The person's own agents working on a task now, across their projects (the sidebar card). */
export const getOwnWorkingAgents = (signal?: AbortSignal) => request<OwnWorkingAgents>(ownWorkingAgentsPath, { signal });

/** Questions agents asked in a project, newest first (S14, #347). */
export const getAgentQuestions = (projectId: string, signal?: AbortSignal) => request<AgentQuestions>(projectAgentQuestionsPath(projectId), { signal });

/** The asked person's answer: an option or their own words. The same answer again returns the stored one (`409 QUESTION_ANSWERED` for another). */
export const answerAgentQuestion = (questionId: string, command: AnswerAgentQuestionCommand, idempotencyKey: string) =>
  request<AgentQuestion>(agentQuestionAnswerPath(questionId), { method: 'POST', body: command, headers: { 'idempotency-key': idempotencyKey } });
