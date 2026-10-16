import { IDEMPOTENCY_KEY_HEADER, IF_MATCH_HEADER, projectGoalPath, projectGoalReachedPath, projectGoalsPath, type ProjectGoal, type ProjectGoalList, type ProjectGoalState } from '@flux/contracts';
import { request } from '../api/client';
import { draftKey, keep, readKept } from '../docs/drafts';

// A project's optional goal (#520, F-028): the API calls, and the wrap-up page a reached goal offers.
// Every change carries the project version the person saw (If-Match) and its own Idempotency-Key.

const change = (path: string, method: 'PUT' | 'POST' | 'DELETE', version: number, body?: unknown) =>
  request<ProjectGoalState>(path, { method, body, headers: { [IF_MATCH_HEADER]: `"${version}"`, [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() } });

export const setProjectGoal = (projectId: string, title: string, version: number) => change(projectGoalPath(projectId), 'PUT', version, { title });
export const removeProjectGoal = (projectId: string, version: number) => change(projectGoalPath(projectId), 'DELETE', version);
export const reachProjectGoal = (projectId: string, version: number) => change(projectGoalReachedPath(projectId), 'POST', version);
export const reopenProjectGoal = (projectId: string, version: number) => change(projectGoalReachedPath(projectId), 'DELETE', version);
export const listProjectGoals = (projectId: string, signal?: AbortSignal) => request<ProjectGoalList>(projectGoalsPath(projectId), { signal });

/** A goal reached within this long may still celebrate on a device that has not seen it; older ones are history lines. */
export const GOAL_MOMENT_DAYS = 7;
export const recentlyReached = (goal: Pick<ProjectGoal, 'reachedAt'>, now = Date.now()) =>
  !!goal.reachedAt && now - Date.parse(goal.reachedAt) < GOAL_MOMENT_DAYS * 24 * 60 * 60 * 1000;

/**
 * "Write a wrap-up": a new Wiki page draft titled after the goal, through the ordinary new-page editor
 * (draft before save). Text the person already started for a new page is never replaced. Nothing is written
 * by AI: the page starts empty under its title.
 */
export function wrapUpDraft(userId: string, projectId: string, goalTitle: string): string {
  const key = draftKey(userId, null, projectId);
  const kept = readKept(key);
  if (!kept || (!kept.title.trim() && !kept.body.trim())) keep(key, { title: `Wrap-up: ${goalTitle}`, body: '', state: 'draft', reason: '', base: 0 });
  return `/projects/${projectId}/docs/new`;
}
