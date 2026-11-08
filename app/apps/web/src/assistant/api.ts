import {
  ASSISTANT_RUNS_PATH, PERSONAL_ASSISTANT_PATH,
  assistantProposalAcceptPath, assistantProposalDismissPath, assistantRunPath, assistantRunRetryPath, assistantRunStopPath,
  conversationAssistantAnswersPath, conversationAssistantRunsPath, projectAssistantProposalsPath,
  assistantChangeActionPath, assistantOperatorRequestPath, assistantRunChangesActionPath, conversationAssistantActivityPath, conversationAssistantChangesPath,
  type AssistantActivity, type AssistantChange, type AssistantChangeDecision, type AssistantChangesDecided, type AssistantRunUndone,
  type AssistantAnswer, type AssistantProposal, type AssistantRun, type InvokeAssistantRunCommand,
  type Page, type PersonalAssistantStatus,
} from '@flux/contracts';
import { request } from '../api/client';

// The personal assistant API (#68, O-008). Every call acts as the signed-in person: the server
// resolves the owner, agent and key connection from the session, never from these bodies.

export const getAssistantStatus = (signal?: AbortSignal) => request<PersonalAssistantStatus>(PERSONAL_ASSISTANT_PATH, { signal });

/** "Tell whoever runs Flux": one Needs-you item to the workspace's owners (F-027 Journey 6). */
export const tellOperator = (workspaceId: string, client: 'claude_code' | 'codex' | null | undefined) =>
  request<{ sent: number }>(assistantOperatorRequestPath(workspaceId), { method: 'POST', body: client === 'codex' ? { client } : {} });

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

// An agent's changes (F-036 AG-3): the change line and Undo on its message, and what waits. Only their owner, in their own
// signed-in session, approves, edits or skips a waiting change.
export const listConversationChanges = (conversationId: string, signal?: AbortSignal) =>
  request<{ items: AssistantChange[] }>(conversationAssistantChangesPath(conversationId), { signal });
/** Approve one waiting change (Delete, for a deletion). */
export const applyChange = (change: Pick<AssistantChange, 'id' | 'version'>) =>
  request<AssistantChangeDecision>(assistantChangeActionPath(change.id, 'apply'), { method: 'POST', body: { expectedVersion: change.version } });
/** Skip one waiting change (Keep, for a deletion). */
export const skipChange = (change: Pick<AssistantChange, 'id' | 'version'>) =>
  request<AssistantChangeDecision>(assistantChangeActionPath(change.id, 'skip'), { method: 'POST', body: { expectedVersion: change.version } });
/** Edit a task proposed for another person before approving it. */
export const editChange = (change: Pick<AssistantChange, 'id' | 'version'>, title: string) =>
  request<AssistantChangeDecision>(assistantChangeActionPath(change.id, 'edit'), { method: 'POST', body: { expectedVersion: change.version, title } });
/** Approve all of one run's waiting changes. */
export const applyRunChanges = (runId: string) => request<AssistantChangesDecided>(assistantRunChangesActionPath(runId, 'apply'), { method: 'POST', body: {} });
export const skipRunChanges = (runId: string) => request<AssistantChangesDecided>(assistantRunChangesActionPath(runId, 'skip'), { method: 'POST', body: {} });
// Undo: one change, or the whole message. The server refuses cleanly when the object changed since.
export const undoChange = (change: Pick<AssistantChange, 'id'>) =>
  request<AssistantChangeDecision>(assistantChangeActionPath(change.id, 'undo'), { method: 'POST', body: {} });
export const undoRunChanges = (runId: string) => request<AssistantRunUndone>(assistantRunChangesActionPath(runId, 'undo'), { method: 'POST', body: {} });
// Who has an assistant working in a conversation, for everyone who can read it: names only (AST-6 "Visible to everyone").
export const getAssistantActivity = (conversationId: string, signal?: AbortSignal) =>
  request<AssistantActivity>(conversationAssistantActivityPath(conversationId), { signal });
