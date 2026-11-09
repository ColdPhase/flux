import { agentQuestionAnswerPath, ownWorkingAgentsPath, projectAgentQuestionsPath, projectAgentStopsPath,
  type AgentQuestion, type AgentQuestions, type AgentStop, type AgentStops, type AnswerAgentQuestionCommand, type OwnWorkingAgents,
  type StopAgentCommand } from '@flux/contracts';
import { request } from '../api/client';

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
export const answerAgentQuestion = (questionId: string, command: AnswerAgentQuestionCommand, idempotencyKey: string, keepalive = false) =>
  request<AgentQuestion>(agentQuestionAnswerPath(questionId), { method: 'POST', body: command, headers: { 'idempotency-key': idempotencyKey }, keepalive });
