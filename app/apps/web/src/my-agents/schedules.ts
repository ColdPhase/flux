import {
  assistantJobHistoryPath, assistantJobNotePath, assistantJobPath, assistantJobRestorePath, assistantJobRunNowPath, assistantJobsPath,
  type AssistantBackgroundNote, type AssistantJob, type AssistantJobRun, type CreateAssistantJob, type UpdateAssistantJob,
} from '@flux/contracts';
import { request } from '../api/client';
import { browserZone } from '../app/timeZone';

// An agent's schedules (F-036 AG-9, #858). Every call is the signed-in owner's own; the server answers anyone else with the 404 of a
// schedule that does not exist.

export const listSchedules = (agentId: string, signal?: AbortSignal) => request<{ items: AssistantJob[] }>(assistantJobsPath(agentId), { signal }).then((result) => result.items);
export const createSchedule = (agentId: string, body: CreateAssistantJob) => request<AssistantJob>(assistantJobsPath(agentId), { method: 'POST', body });
export const updateSchedule = (agentId: string, id: string, body: UpdateAssistantJob) => request<AssistantJob>(assistantJobPath(agentId, id), { method: 'PATCH', body });
export const deleteSchedule = (agentId: string, id: string) => request<AssistantJob>(assistantJobPath(agentId, id), { method: 'DELETE' });
export const restoreSchedule = (agentId: string, id: string) => request<AssistantJob>(assistantJobRestorePath(agentId, id), { method: 'POST' });
export const runScheduleNow = (agentId: string, id: string) => request<{ job: AssistantJob; run: AssistantJobRun }>(assistantJobRunNowPath(agentId, id), { method: 'POST' });
export const scheduleHistory = (agentId: string, id: string, signal?: AbortSignal) => request<{ items: AssistantJobRun[] }>(assistantJobHistoryPath(agentId, id), { signal }).then((result) => result.items);
export const getBackgroundNote = (agentId: string, signal?: AbortSignal) => request<AssistantBackgroundNote>(assistantJobNotePath(agentId), { signal });

/**
 * A schedule's time in words, and its zone when this browser is in another one (#1168, C-57): "Weekdays at 9:00, Warsaw time". A schedule
 * keeps the zone it was made in, its owner's; the words and the next times are in that zone.
 */
export function scheduleWhen(job: Pick<AssistantJob, 'words' | 'timeZone'>) {
  if (job.timeZone === browserZone()) return job.words;
  return `${job.words}, ${job.timeZone === 'UTC' ? 'UTC' : `${job.timeZone.split('/').pop()!.replace(/_/g, ' ')} time`}`;
}

/** A moment in the schedule's zone: "Tue 14:02". */
export function whenText(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch { return iso; }
}
