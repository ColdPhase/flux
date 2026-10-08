import type { PrincipalRef, VersionPrecondition } from './access.js';
import type { SendMessageCommand } from './conversation.js';
import type { GithubTaskRule } from './github.js';

/**
 * Work items, decisions and results of a project (issue #101, foundation 8.5/8.6).
 * They are distinct objects with stable ids, connected to each other and to conversation
 * messages and material versions by many-to-many links. Everything is visible exactly to the
 * people and agents with current access to the project; there is no second audience.
 */
export const projectWorkPath = (projectId: string) => `/api/v1/projects/${projectId}/work`;
export const projectTaskNoticesPath = (projectId: string) => `/api/v1/projects/${projectId}/task-notices`;
export const taskDiscussionPath = (workId: string) => `/api/v1/work/${workId}/discussion`;

/**
 * A direct public contribution to a task thread. `handoff` marks an explicit public instruction to the next
 * person or agent; it carries no authority by itself. Blocker and result contributions are never sent this way:
 * they come from saving a blocker or publishing a result.
 */
export interface TaskContributionCommand extends SendMessageCommand {
  kind?: 'text' | 'handoff';
}

/** Explicit canonical root, also returned outside the bounded newest-message window. */
export interface TaskDiscussion {
  workId: string;
  workspaceId: string;
  projectId: string;
  conversationId: string | null;
  rootMessageId: string | null;
  root: import('./conversation.js').ConversationMessage | null;
  messages: import('./conversation.js').ConversationMessage[];
  messagePage: import('./conversation.js').Conversation['messagePage'];
}
export const workItemPath = (workId: string) => `/api/v1/work/${workId}`;
export const projectDecisionsPath = (projectId: string) => `/api/v1/projects/${projectId}/decisions`;
export const decisionPath = (decisionId: string) => `/api/v1/decisions/${decisionId}`;
export const decisionAcceptPath = (decisionId: string) => `${decisionPath(decisionId)}/accept`;
export const projectResultsPath = (projectId: string) => `/api/v1/projects/${projectId}/results`;
export const resultPath = (resultId: string) => `/api/v1/results/${resultId}`;
export const projectLinksPath = (projectId: string) => `/api/v1/projects/${projectId}/links`;
/** Work owned by the caller across every project of the workspace they can currently read. */
export const workspaceAssignedWorkPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/work/assigned`;

export const WORK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'not_pursued'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export type DecisionStatus = 'proposed' | 'accepted' | 'superseded';
export type ResultFinding = 'positive' | 'negative';
export type WorkObjectType = 'work' | 'decision' | 'result';
/** Objects that own links: work objects and project docs (#112). */
export type LinkOwnerType = WorkObjectType | 'doc';

/**
 * `criteria`, `dependencies` and `intentKey` bound a native task's plan fields (#152): at most 20 distinct
 * trimmed criteria of 1-`criterion` characters, at most 50 same-project prerequisites and a trimmed 1-120
 * character plan intent key.
 */
export const WORK_LIMITS = { title: 200, outcome: 4000, blocker: 2000, rationale: 20_000, evidence: 20_000, links: 50,
  criteria: 20, criterion: 1000, dependencies: 50, intentKey: 120 } as const;

/** A stable reference to something in the same project. Material references pin a version. */
export type ObjectRef =
  | { type: 'message'; id: string }
  /** A thought on one of the project's sketches (#69); private sketches are never linkable. */
  | { type: 'thought'; id: string }
  | { type: 'material'; id: string; version: number }
  /** A project doc (#112) as it currently reads, or a project sketch (#69). */
  | { type: 'doc'; id: string }
  | { type: 'sketch'; id: string }
  | { type: WorkObjectType; id: string };

/**
 * `source`: created from, or based on, a message or material version (the source stays in place).
 * `affects`: a decision concerns this work. `still_applies`: at a pivot, work that remains useful.
 * `about`: a result reports on this work or decision. `related`: any other connection.
 * `mentions`: the current text of a doc refers to it (#112); rewritten with each doc version.
 */
export type LinkRole = 'source' | 'affects' | 'still_applies' | 'about' | 'related' | 'mentions';

export interface ObjectLink {
  id: string;
  projectId: string;
  role: LinkRole;
  from: { type: LinkOwnerType; id: string };
  to: ObjectRef;
  /** Current titles of both ends (a message's opening words), so a reader can follow the link. */
  fromTitle: string;
  toTitle: string;
  /** The conversation of a message target, else null. */
  conversationId: string | null;
  /** The sketch of a thought or sketch target, else null. */
  sketchId: string | null;
  createdAt: string;
}

/** A person or an agent (#29 principal) with its display name. */
export interface NamedPrincipal {
  kind: 'human' | 'agent';
  id: string;
  name: string;
}

interface ProjectObject {
  id: string;
  projectId: string;
  workspaceId: string;
  audience: { kind: 'project'; projectId: string };
  /** Every link from or to this object, oldest first. */
  links: ObjectLink[];
  createdAt: string;
}

/**
 * The exact plan revision a task was created for, and a key within that revision (#152). It is an immutable
 * correlation shared by people and agents: it neither instructs nor authorizes anything, and an ordinary
 * material or wiki page never becomes approved policy through it.
 */
export interface TaskPlanIntent {
  materialId: string;
  version: number;
  intentKey: string;
}

/** The current state of a direct prerequisite. It is met only while it is `done` and not parked. */
export interface TaskPrerequisite {
  id: string;
  title: string;
  status: WorkStatus;
  parked: boolean;
  met: boolean;
}

export interface WorkItem extends ProjectObject {
  /** The task's number in its project, shown as "#12" (#276): given at creation, never reused or changed. */
  number: number;
  title: string;
  /** What finishing it should achieve; may be empty for small tasks. */
  outcome: string;
  /** What should hold when it is done. Listing a criterion never records that it is satisfied. */
  criteria: string[];
  /** Direct prerequisites in this project, ascending; none for tasks that never named any. */
  dependencyIds: string[];
  /** The same prerequisites with their current state, so one task shows what it is waiting for. */
  prerequisites: TaskPrerequisite[];
  /** Null for tasks created without a plan intent, including every task from before this existed. */
  planIntent: TaskPlanIntent | null;
  status: WorkStatus;
  /** Only while blocked. */
  blocker: string | null;
  owner: NamedPrincipal | null;
  /** Set when a pivot parked the work. Parking keeps the status: parked work is not done. */
  parked: { decisionId: string; at: string } | null;
  createdBy: NamedPrincipal;
  /** "Let linked PRs move this task" (#74 G-1a); null when nobody turned it on. */
  githubRule: GithubTaskRule | null;
  version: number;
  updatedAt: string;
}

export interface Decision extends ProjectObject {
  title: string;
  rationale: string;
  status: DecisionStatus;
  proposedBy: NamedPrincipal;
  /** The person who accepted it. Agents can propose but never accept. */
  decidedBy: NamedPrincipal | null;
  decidedAt: string | null;
  /** The earlier decision this one replaces once accepted. History is never rewritten. */
  supersedes: string | null;
  supersededBy: string | null;
  supersededAt: string | null;
  version: number;
  updatedAt: string;
}

export interface WorkResult extends ProjectObject {
  title: string;
  finding: ResultFinding;
  evidence: string;
  createdBy: NamedPrincipal;
}

export interface CreateWorkCommand {
  /** Durable domain retry identity, reused by every entry point for this exact creation. */
  clientCommandId?: string;
  title: string;
  outcome?: string;
  owner?: PrincipalRef | null;
  status?: WorkStatus;
  blocker?: string;
  /** Messages, sketch thoughts or material versions the work comes from. They are linked, never moved or copied. */
  sources?: ObjectRef[];
  /** Other objects of the project to connect (thoughts, decisions, results, messages). */
  related?: ObjectRef[];
  /** At most 20 distinct trimmed statements of 1-1,000 characters. */
  criteria?: string[];
  /** At most 50 distinct tasks of the same project that must be done (and unparked) first. */
  dependencyIds?: string[];
  /**
   * Correlates this creation with one revision of a plan material. The revision must be the material's
   * current version. The same canonical creation returns the same task; another payload for the same
   * intent is 409 TASK_INTENT_CONFLICT and an edited task 409 TASK_INTENT_STALE.
   */
  planIntent?: TaskPlanIntent | null;
}

/** Creation activity is separate from any canonical discussion message/root. */
export interface TaskCreationNotice {
  id: string;
  workspaceId: string;
  projectId: string;
  workId: string;
  kind: 'task.created';
  /** Current task label; the exact historical identity/creator/sources below are retained. */
  workTitle: string;
  /** The task's number in its project, "#12" (#276), so the announcement names it from the start. */
  workNumber: number;
  createdBy: NamedPrincipal;
  sources: ObjectRef[];
  createdAt: string;
}

export interface UpdateWorkCommand extends VersionPrecondition {
  /**
   * Durable domain retry identity of this exact change (#154). A retry with the same UUID returns the original
   * outcome and never contributes the saved blocker twice; a changed payload conflicts. Without it the
   * version precondition alone fences a stale identical retry.
   */
  clientCommandId?: string;
  /**
   * Optional second precondition for a change of status, blocker or parking on a task with a GitHub rule: the rule
   * `revision` the person saw (0: no rule). A mismatch is a 409 with the current task and rule, so a person overrides
   * the state they saw, not a newer automatic change. Without it the change is an explicit manual override.
   */
  expectedGithubRuleRevision?: number;
  title?: string;
  outcome?: string;
  owner?: PrincipalRef | null;
  status?: WorkStatus;
  blocker?: string | null;
  /** `false` takes parked work back into the plan. Parking happens only through a pivot. */
  parked?: false;
  /** Replaces the whole list. */
  criteria?: string[];
  /**
   * Replaces the whole set. A task that is in progress or done keeps every prerequisite done and unparked;
   * cycles, itself and tasks of other projects are rejected. A plan intent can never be changed here.
   */
  dependencyIds?: string[];
}

export interface ProposeDecisionCommand {
  title: string;
  rationale?: string;
  /** An accepted decision of the same project that this one replaces when accepted. */
  supersedes?: string;
  /** The messages and material versions the decision is based on. */
  sources?: ObjectRef[];
  /** Work items the decision affects. */
  affects?: string[];
}

/**
 * Accepting a decision that supersedes another is a pivot: the earlier decision becomes
 * superseded, `stillApplies` work is marked as still useful and `park` work is parked.
 */
export interface AcceptDecisionCommand extends VersionPrecondition {
  stillApplies?: string[];
  park?: string[];
}

export interface CreateResultCommand {
  /** Durable domain retry identity of this exact publication (#154); a retry never duplicates the result or its task messages. */
  clientCommandId?: string;
  title: string;
  finding: ResultFinding;
  evidence?: string;
  sources?: ObjectRef[];
  work?: string[];
  decisions?: string[];
  /**
   * A work item of `work` this result finishes (its status becomes done), e.g. a negative
   * experiment, with the version the author saw. A stale version is 409 VERSION_CONFLICT; work
   * that is not pursued or parked is 409 WORK_NOT_FINISHABLE (un-park it first).
   */
  finishes?: { id: string; expectedVersion: number };
}

export interface CreateObjectLinkCommand {
  from: { type: WorkObjectType; id: string };
  to: ObjectRef;
}
