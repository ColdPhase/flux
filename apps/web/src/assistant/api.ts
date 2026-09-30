import {
  ASSISTANT_RUNS_PATH, PERSONAL_ASSISTANT_AGENTS_PATH, PERSONAL_ASSISTANT_PATH, PERSONAL_ASSISTANT_PAUSE_PATH, PERSONAL_ASSISTANT_RESUME_PATH,
  assistantProposalAcceptPath, assistantProposalDismissPath, assistantRunPath, assistantRunRetryPath, assistantRunStopPath,
  conversationAssistantAnswersPath, conversationAssistantRunsPath, projectAssistantProposalsPath,
  type AssistantAnswer, type AssistantProposal, type AssistantRun, type EnablePersonalRunsCommand, type InvokeAssistantRunCommand,
  type Page, type PersonalAssistantStatus, type UpdatePersonalRunsCommand,
} from '@flux/contracts';
import { request } from '../api/client';

// The personal assistant API (#68, O-008). Every call acts as the signed-in person: the server
// resolves the owner, agent and key connection from the session, never from these bodies.

export const getAssistantStatus = (signal?: AbortSignal) => request<PersonalAssistantStatus>(PERSONAL_ASSISTANT_PATH, { signal });
export const enableAssistant = (command: EnablePersonalRunsCommand) => request<PersonalAssistantStatus>(PERSONAL_ASSISTANT_PATH, { method: 'POST', body: command });
export const updateAssistant = (command: UpdatePersonalRunsCommand) => request<PersonalAssistantStatus>(PERSONAL_ASSISTANT_PATH, { method: 'PATCH', body: command });
export const selectAssistantAgent = (agentId: string) => request<PersonalAssistantStatus>(PERSONAL_ASSISTANT_AGENTS_PATH, { method: 'PUT', body: { agentId } });
export const pauseAssistant = () => request<PersonalAssistantStatus>(PERSONAL_ASSISTANT_PAUSE_PATH, { method: 'POST' });
export const resumeAssistant = () => request<PersonalAssistantStatus>(PERSONAL_ASSISTANT_RESUME_PATH, { method: 'POST' });
export const removeAssistant = () => request<null>(PERSONAL_ASSISTANT_PATH, { method: 'DELETE' });

export const askAssistant = (conversationId: string, command: InvokeAssistantRunCommand) =>
  request<AssistantRun>(conversationAssistantRunsPath(conversationId), { method: 'POST', body: command });
export const getRun = (runId: string, signal?: AbortSignal) => request<AssistantRun>(assistantRunPath(runId), { signal });
export const listOwnRuns = (signal?: AbortSignal) => request<Page<AssistantRun>>(`${ASSISTANT_RUNS_PATH}?limit=10`, { signal });
export const stopRun = (runId: string) => request<AssistantRun>(assistantRunStopPath(runId), { method: 'POST' });
export const retryRun = (runId: string, clientRunId: string) => request<AssistantRun>(assistantRunRetryPath(runId), { method: 'POST', body: { clientRunId } });

export const listAnswers = (conversationId: string, offset = 0, signal?: AbortSignal) =>
  request<Page<AssistantAnswer>>(`${conversationAssistantAnswersPath(conversationId)}?limit=100&offset=${offset}`, { signal });
export const listProposals = (projectId: string, signal?: AbortSignal) =>
  request<Page<AssistantProposal>>(`${projectAssistantProposalsPath(projectId)}?limit=100`, { signal });
export const acceptProposal = (proposal: AssistantProposal) =>
  request<AssistantProposal>(assistantProposalAcceptPath(proposal.id), { method: 'POST', body: { expectedVersion: proposal.version } });
export const dismissProposal = (proposal: AssistantProposal) =>
  request<AssistantProposal>(assistantProposalDismissPath(proposal.id), { method: 'POST', body: { expectedVersion: proposal.version } });
