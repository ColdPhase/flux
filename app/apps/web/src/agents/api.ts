import { agentQuestionAnswerPath, ownWorkingAgentsPath, projectAgentQuestionsPath, projectAgentPausesPath, projectAgentStopsPath, projectAgentsPath,
  taskCoordinationCancelPath, taskCoordinationPacketPath, taskCoordinationPath, type TaskCoordination, type TaskCoordinationRequest,
  type AgentQuestion, type AgentQuestions, type AgentStop, type AgentStops, type AnswerAgentQuestionCommand, type OwnWorkingAgents,
  type ProjectAgents, type StopAgentCommand, type AgentPause, type PauseAgentCommand } from '@flux/contracts';
import { request, send } from '../api/client';

/** The Agents view of a project (UI116-2, #136): current connections. */
export const getProjectAgents = (projectId: string, signal?: AbortSignal) => request<ProjectAgents>(projectAgentsPath(projectId), { signal });

/** Who stopped which agent's work in a project, newest first (S13, #347). */
export const getAgentStops = (projectId: string, signal?: AbortSignal) => request<AgentStops>(projectAgentStopsPath(projectId), { signal });

/**
 * Ends an agent's hold on a task. The key makes a retry after a lost answer stop once; a task the agent no longer holds
 * is `409 AGENT_NOT_WORKING` and a person who may not stop it `403 STOP_NOT_ALLOWED`.
 */
export const stopAgent = (projectId: string, command: StopAgentCommand, idempotencyKey: string) =>
  request<AgentStop>(projectAgentStopsPath(projectId), { method: 'POST', body: command, headers: { 'idempotency-key': idempotencyKey } });

/** Pause (`paused: true`) or resume an agent's work on a task it holds (#160 AC-5); a resume answers 204. */
export const pauseAgent = (projectId: string, command: PauseAgentCommand, idempotencyKey: string) =>
  request<AgentPause | null>(projectAgentPausesPath(projectId), { method: 'POST', body: command, headers: { 'idempotency-key': idempotencyKey } });

/** The person's own agents working on a task now, across their projects (the sidebar card). */
export const getOwnWorkingAgents = (signal?: AbortSignal) => request<OwnWorkingAgents>(ownWorkingAgentsPath, { signal });

/** Questions agents asked in a project, newest first (S14, #347). */
export const getAgentQuestions = (projectId: string, signal?: AbortSignal) => request<AgentQuestions>(projectAgentQuestionsPath(projectId), { signal });

/** The asked person's answer: an option or their own words. The same answer again returns the stored one (`409 QUESTION_ANSWERED` for another). */
export const answerAgentQuestion = (questionId: string, command: AnswerAgentQuestionCommand, idempotencyKey: string, keepalive = false) =>
  request<AgentQuestion>(agentQuestionAnswerPath(questionId), { method: 'POST', body: command, headers: { 'idempotency-key': idempotencyKey }, keepalive });

/** A task's request cards and review verdicts (#153, #400 AC-4); whoever can read the task reads them. */
export const getTaskCoordination = (workId: string, signal?: AbortSignal) => request<TaskCoordination>(taskCoordinationPath(workId), { signal });
/** A request's handoff packet as a file to save; null when the server refuses it. */
export async function getCoordinationPacket(workId: string, requestId: string): Promise<Blob | null> {
  const response = await send(taskCoordinationPacketPath(workId, requestId));
  return response.ok ? await response.blob() : null;
}
/** Cancels an open request at the version the person saw. Repeating it after a lost answer succeeds without a second change. */
export const cancelCoWorkRequest = (workId: string, requestId: string, expectedVersion: number) =>
  request<TaskCoordinationRequest>(taskCoordinationCancelPath(workId, requestId), { method: 'POST', body: { expectedVersion } });
