import {
  ASSISTANT_MORNING_SUMMARY_PATH, assistantJobHistoryPath, assistantJobNotePath, assistantJobPath, assistantJobPreviewPath, assistantJobRestorePath, assistantJobRunNowPath,
  assistantJobsPath, projectConversationsPath,
  type AssistantBackgroundNote, type AssistantJob, type AssistantJobPreview, type AssistantJobRun, type AssistantJobSchedule, type AssistantMorningSummary,
  type ConversationSummary, type CreateAssistantJob, type Page, type SetMorningSummaryByAssistant, type UpdateAssistantJob,
} from '@flux/contracts';
import { request } from '../api/client';

// "On a schedule" and the morning summary written by the assistant (F-027 AST-7, A8 #408). Every call is the signed-in owner's own;
// the server resolves the owner from the session and answers anyone else with the 404 of a schedule that does not exist.

export interface ScheduleScope { workspaceId: string; ownerId: string }

export const listSchedules = ({ workspaceId, ownerId }: ScheduleScope, signal?: AbortSignal) =>
  request<{ items: AssistantJob[] }>(assistantJobsPath(workspaceId, ownerId), { signal }).then((result) => result.items);
export const createSchedule = ({ workspaceId, ownerId }: ScheduleScope, body: CreateAssistantJob) =>
  request<AssistantJob>(assistantJobsPath(workspaceId, ownerId), { method: 'POST', body });
export const updateSchedule = ({ workspaceId, ownerId }: ScheduleScope, id: string, body: UpdateAssistantJob) =>
  request<AssistantJob>(assistantJobPath(workspaceId, ownerId, id), { method: 'PATCH', body });
export const deleteSchedule = ({ workspaceId, ownerId }: ScheduleScope, id: string) =>
  request<AssistantJob>(assistantJobPath(workspaceId, ownerId, id), { method: 'DELETE' });
export const restoreSchedule = ({ workspaceId, ownerId }: ScheduleScope, id: string) =>
  request<AssistantJob>(assistantJobRestorePath(workspaceId, ownerId, id), { method: 'POST' });
export const runScheduleNow = ({ workspaceId, ownerId }: ScheduleScope, id: string) =>
  request<{ job: AssistantJob; run: AssistantJobRun }>(assistantJobRunNowPath(workspaceId, ownerId, id), { method: 'POST' });
export const scheduleHistory = ({ workspaceId, ownerId }: ScheduleScope, id: string, signal?: AbortSignal) =>
  request<{ items: AssistantJobRun[] }>(assistantJobHistoryPath(workspaceId, ownerId, id), { signal }).then((result) => result.items);
export const previewSchedule = ({ workspaceId, ownerId }: ScheduleScope, schedule: AssistantJobSchedule, timeZone: string, signal?: AbortSignal) =>
  request<AssistantJobPreview>(assistantJobPreviewPath(workspaceId, ownerId), { method: 'POST', body: { schedule, timeZone }, signal });
export const getBackgroundNote = ({ workspaceId, ownerId }: ScheduleScope, signal?: AbortSignal) =>
  request<AssistantBackgroundNote>(assistantJobNotePath(workspaceId, ownerId), { signal });

export const getMorningSummary = (signal?: AbortSignal) => request<AssistantMorningSummary>(ASSISTANT_MORNING_SUMMARY_PATH, { signal });
export const setMorningSummary = (body: SetMorningSummaryByAssistant) =>
  request<{ byAssistant: boolean }>(ASSISTANT_MORNING_SUMMARY_PATH, { method: 'PUT', body });

/** The project's recent conversations, for "Post the result in" under More. */
export const recentConversations = (projectId: string, signal?: AbortSignal) =>
  request<Page<ConversationSummary>>(`${projectConversationsPath(projectId)}?limit=10`, { signal }).then((page) => page.items);
