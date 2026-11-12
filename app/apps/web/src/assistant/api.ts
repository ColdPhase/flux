import {
  ASSISTANT_RUNS_PATH, PERSONAL_ASSISTANT_PATH, agentAssistantStatusPath,
  assistantRunPath, assistantRunRetryPath, assistantRunStopPath,
  conversationAssistantRunsPath,
  agentAssistantRunsPath, assistantChangeActionPath, assistantOperatorRequestPath, assistantRunChangesActionPath, assistantRunChangesPath, assistantRunDismissPath,
  assistantRunShowPath, conversationAssistantChangesPath, dmAssistantRunsPath, dmThreadAssistantRunsPath, projectAssistantChangesPath, projectAssistantRunsPath,
  type AssistantChange, type AssistantChangeDecision, type AssistantChangeScope, type AssistantChangesDecided, type AssistantRunUndone,
  type AssistantPlace, type AssistantRun, type InvokeAssistantRunCommand,
  type Page, type PersonalAssistantStatus, type ShowAnswerResult,
} from '@flux/contracts';
import { request } from '../api/client';

// The personal assistant API (#68, O-008). Every call acts as the signed-in person: the server
// resolves the owner, agent and key connection from the session, never from these bodies.

export const getAssistantStatus = (signal?: AbortSignal) => request<PersonalAssistantStatus>(PERSONAL_ASSISTANT_PATH, { signal });
/** One agent's own status (C-3), for its private chat: another agent's removed connection never pauses it. */
export const getAgentStatus = (agentId: string, signal?: AbortSignal) => request<PersonalAssistantStatus>(agentAssistantStatusPath(agentId), { signal });

/** "Tell whoever runs Flux": one Needs-you item to the workspace's owners (F-027 Journey 6). */
export const tellOperator = (workspaceId: string, client: 'claude_code' | 'codex' | null | undefined) =>
  request<{ sent: number }>(assistantOperatorRequestPath(workspaceId), { method: 'POST', body: client === 'codex' ? { client } : {} });

/** Where `/ai` is asked (#842): a conversation or a space's main conversation, a direct message, or an agent's private chat. */
export type AskPlace = AssistantPlace;
const askPath = (place: AskPlace) => place.kind === 'dm' ? (place.threadRootId ? dmThreadAssistantRunsPath(place.dmId, place.threadRootId) : dmAssistantRunsPath(place.dmId)) : place.kind === 'chat' ? agentAssistantRunsPath(place.agentId)
  : place.conversationId ? conversationAssistantRunsPath(place.conversationId) : projectAssistantRunsPath(place.projectId);
const placeQuery = (place: AskPlace) => place.kind === 'dm' ? `dmId=${place.dmId}${place.threadRootId ? `&dmThreadRootId=${place.threadRootId}` : ''}` : place.kind === 'chat' ? `chatAgentId=${place.agentId}`
  : place.conversationId ? `conversationId=${place.conversationId}` : `spaceId=${place.projectId}`;
export const askAssistant = (place: AskPlace, command: InvokeAssistantRunCommand) => request<AssistantRun>(askPath(place), { method: 'POST', body: command });
export const getRun = (runId: string, signal?: AbortSignal) => request<AssistantRun>(assistantRunPath(runId), { signal });
/** The caller's own runs at one place, newest first: the private answers of a conversation, or the turns of an agent's chat. */
export const listPlaceRuns = (place: AskPlace, options: { limit?: number; offset?: number } = {}, signal?: AbortSignal) =>
  request<Page<AssistantRun>>(`${ASSISTANT_RUNS_PATH}?${placeQuery(place)}&limit=${options.limit ?? 20}&offset=${options.offset ?? 0}`, { signal });
export const listOwnRuns = (signal?: AbortSignal) => request<Page<AssistantRun>>(`${ASSISTANT_RUNS_PATH}?limit=10`, { signal });
/** Show everyone: the answer becomes the asker's own message, "Ada · via Assistant" (#842). */
export const showAnswer = (runId: string) => request<ShowAnswerResult>(assistantRunShowPath(runId), { method: 'POST' });
/** Dismiss: puts an answer, or the line of a run that ended, away (#842). */
export const dismissAnswer = (runId: string) => request<AssistantRun>(assistantRunDismissPath(runId), { method: 'POST' });
/** One run's changes with their Undo: the change line on the asker's answer (#842). */
export const listRunChanges = (runId: string, signal?: AbortSignal) => request<{ items: AssistantChange[] }>(assistantRunChangesPath(runId), { signal });
export const stopRun = (runId: string) => request<AssistantRun>(assistantRunStopPath(runId), { method: 'POST' });
export const retryRun = (runId: string, clientRunId: string) => request<AssistantRun>(assistantRunRetryPath(runId), { method: 'POST', body: { clientRunId } });

// An agent's changes (F-036 AG-3): the change line and Undo on its message, and what waits. Only their owner, in their own
// signed-in session, approves, edits or skips a waiting change.
export const listConversationChanges = (conversationId: string, signal?: AbortSignal) =>
  request<{ items: AssistantChange[] }>(conversationAssistantChangesPath(conversationId), { signal });
/** A local client's changes to one task, Wiki page or map, with their change line and Undo (#868). */
export const listObjectChanges = (projectId: string, kind: AssistantChangeScope, id: string, signal?: AbortSignal) =>
  request<{ items: AssistantChange[] }>(`${projectAssistantChangesPath(projectId)}?kind=${kind}&id=${id}`, { signal });
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
