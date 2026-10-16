import { projectPath } from './access.js';

// A project's optional shared goal (#520, F-028, docs/product/project-goals.md). One sentence the
// team may set; a person marks it reached. Goal state is never inferred from tasks, PRs, results or
// agent messages. The project goes on afterwards: no status, archive or read-only state. Agents and
// viewers read it; only a signed-in person who can write in the project changes it. No goal change
// creates a notification, an Inbox item, a badge or a push.

/** The longest goal, in characters: one sentence on one line. */
export const PROJECT_GOAL_MAX = 120;

/**
 * PUT: sets the project's current goal, or edits the current goal's title (same id).
 * DELETE: removes the current, unreached goal. Both need `If-Match` with the project's version.
 */
export const projectGoalPath = (projectId: string) => `${projectPath(projectId)}/goal`;
/** POST: marks the current goal reached. DELETE: reopens the latest reached goal while no goal is current (Undo). */
export const projectGoalReachedPath = (projectId: string) => `${projectGoalPath(projectId)}/reached`;
/** GET: the project's goals, newest first: the current one and the reached ones (the conversation's history lines). */
export const projectGoalsPath = (projectId: string) => `${projectPath(projectId)}/goals`;

/** Events of goal changes, on the project (identifiers only). They never notify anyone. */
export const PROJECT_GOAL_EVENTS = ['project.goal_set.v1', 'project.goal_removed.v1', 'project.goal_reached.v1', 'project.goal_reopened.v1'] as const;
export type ProjectGoalEvent = (typeof PROJECT_GOAL_EVENTS)[number];

/** A person named on a goal; "Former member" when the account is gone. */
export interface ProjectGoalPerson {
  id: string;
  name: string;
}

export interface ProjectGoal {
  id: string;
  projectId: string;
  /** One sentence, trimmed, 1–120 characters, no line breaks. */
  title: string;
  setBy: ProjectGoalPerson;
  setAt: string;
  /** When a person marked it reached; null while it is the current goal. */
  reachedAt: string | null;
  reachedBy: ProjectGoalPerson | null;
}

export interface SetProjectGoalCommand {
  title: string;
}

/** What a goal change answers: the project's new version (its ETag) and the goal `Project.goal` now shows. */
export interface ProjectGoalState {
  projectId: string;
  version: number;
  goal: ProjectGoal | null;
}

export interface ProjectGoalList {
  items: ProjectGoal[];
}
