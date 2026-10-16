import type { ProjectGoalEvent } from '@flux/contracts';
import type { Principal } from '../principal.js';

/**
 * Ports of a project's goal (#520, F-028). Core states what it needs; the server implements them with
 * the access policy (`evaluateProject`), the `@flux/db` goal rows and `recordEvent`, and passes them
 * in. Nothing in `packages/core/src/project-goals` imports those.
 */

/** A stored goal with the names of the people on it (null when an account is gone). */
export interface ProjectGoalRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  setBy: string;
  setByName: string | null;
  setAt: Date;
  reachedAt: Date | null;
  reachedBy: string | null;
  reachedByName: string | null;
}

/** The access policy's answers. Both throw its non-leaking 404, and 403 for a visible project the caller may not change. */
export interface ProjectGoalAccess {
  /** `project.read` now. */
  read(principal: Principal, projectId: string): Promise<void>;
  /** `project.write` now, with the access rows locked until the unit of work commits. */
  write(principal: Principal, projectId: string): Promise<{ workspaceId: string }>;
}

/** Rows only; the repository makes no access decisions. */
export interface ProjectGoalRepository {
  /** Serializes goal changes of one project; taken before the access decision. */
  lockProject(projectId: string): Promise<void>;
  projectVersion(projectId: string): Promise<number>;
  /** Moves the project's version on and returns it. */
  bumpProject(projectId: string): Promise<number>;
  current(projectId: string): Promise<ProjectGoalRecord | null>;
  latestReached(projectId: string): Promise<ProjectGoalRecord | null>;
  list(projectId: string, limit: number): Promise<ProjectGoalRecord[]>;
  insert(goal: { id: string; workspaceId: string; projectId: string; title: string; setBy: string }): Promise<ProjectGoalRecord>;
  updateTitle(id: string, title: string): Promise<ProjectGoalRecord>;
  remove(id: string): Promise<void>;
  markReached(id: string, by: string): Promise<ProjectGoalRecord>;
  reopen(id: string): Promise<ProjectGoalRecord>;
}

/** Records one project event in the unit of work (identifiers only, never the goal's words). */
export interface ProjectGoalEventLog {
  record(principal: Principal, workspaceId: string, kind: ProjectGoalEvent, projectId: string, data: { goalId: string }): Promise<void>;
}

export interface ProjectGoalPorts {
  access: ProjectGoalAccess;
  goals: ProjectGoalRepository;
  events: ProjectGoalEventLog;
}

/**
 * Runs `work` in one transaction: the decision, the change, the version and its event commit
 * together or not at all. Called on an open transaction (an idempotency scope) it nests in it.
 */
export interface ProjectGoalUnitOfWork {
  run<T>(work: (ports: ProjectGoalPorts) => Promise<T>): Promise<T>;
}
