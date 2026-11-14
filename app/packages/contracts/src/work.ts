import type { PrincipalRef, VersionPrecondition } from './access.js';
import type { AgentProjectOwner, SendMessageCommand } from './conversation.js';
import type { GithubTaskRule } from './github.js';

/**
 * Work items and decisions of a project (issue #101, foundation 8.5/8.6).
 * They are distinct objects with stable ids, connected to each other and to conversation
 * messages and material versions by many-to-many links. Everything is visible exactly to the
 * people and agents with current access to the project; there is no second audience.
 */
export const projectWorkPath = (projectId: string) => `/api/v1/projects/${projectId}/work`;
export const projectTaskNoticesPath = (projectId: string) => `/api/v1/projects/${projectId}/task-notices`;
/** The decisions a project's conversation announces (#694), newest first. */
export const projectObjectNoticesPath = (projectId: string) => `/api/v1/projects/${projectId}/object-notices`;
export const taskDiscussionPath = (workId: string) => `/api/v1/work/${workId}/discussion`;
/** The history of a task's status, owner, due date and title (#488), newest first. */
export const taskActivityPath = (workId: string) => `/api/v1/work/${workId}/activity`;

/**
 * A direct public contribution to a task thread. `handoff` marks an explicit public instruction to the next
 * person or agent; it carries no authority by itself. Blocker and "what came of it" contributions are never sent
 * this way: they come from saving a blocker or finishing a task with a line.
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
/** The person a blocked task waits for says they are done (#868): the task goes back to Doing by itself. */
export const taskWaitingDonePath = (workId: string) => `/api/v1/work/${workId}/waiting-done`;
export const taskCreationUndoPath = (workId: string) => `/api/v1/work/${workId}/creation-undo`;
export interface UndoTaskCreationCommand { clientCommandId: string; expectedVersion: number }
/** `own_creation` (#763 B1): a person's own unchanged, unused task, which the toast after creating it offers to undo. */
export type TaskCreationUndoReason = 'eligible' | 'own_creation' | 'not_ai_origin' | 'eligibility_unknown' | 'task_used' | 'creation_changed' | 'not_authorized' | 'already_reverted';
export interface TaskCreationUndoEligibility { eligible: boolean; reason: TaskCreationUndoReason }
export type TaskLifecycle = { state: 'active' } | { state: 'creation_reverted'; noticeId: string; revertedAt: string; revertedBy: NamedPrincipal };
export interface UndoTaskCreationResult { work: WorkItem; noticeId: string; clientCommandId: string }

export const workItemPath = (workId: string) => `/api/v1/work/${workId}`;
export const projectDecisionsPath = (projectId: string) => `/api/v1/projects/${projectId}/decisions`;
export const decisionPath = (decisionId: string) => `/api/v1/decisions/${decisionId}`;
export const decisionAcceptPath = (decisionId: string) => `${decisionPath(decisionId)}/accept`;
export const projectLinksPath = (projectId: string) => `/api/v1/projects/${projectId}/links`;
/** Work owned by the caller across every project of the workspace they can currently read. */
export const workspaceAssignedWorkPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/work/assigned`;

/** A task has four states (#868). A task that was dropped is `done` with `dropped` set and, when someone said so, a `cameOfIt` line. */
export const WORK_STATUSES = ['open', 'in_progress', 'blocked', 'done'] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];
export type DecisionStatus = 'proposed' | 'accepted' | 'superseded';
export type WorkObjectType = 'work' | 'decision';
/** Objects that own links: work objects and project docs (#112). */
export type LinkOwnerType = WorkObjectType | 'doc';

/**
 * `criteria`, `dependencies` and `intentKey` bound a native task's plan fields (#152): at most 20 distinct
 * trimmed criteria of 1-`criterion` characters, at most 50 same-project prerequisites and a trimmed 1-120
 * character plan intent key.
 */
export const WORK_LIMITS = { title: 200, outcome: 4000, blocker: 2000, rationale: 20_000, links: 50,
  criteria: 20, criterion: 1000, dependencies: 50, intentKey: 120, cameOfIt: 500 } as const;

/** A page of a task's activity (#488): `limit` 1-`max`, `default` when omitted. */
export const TASK_ACTIVITY_PAGE = { default: 30, max: 50 } as const;

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
 * `affects`: a decision concerns this work.
 * `related`: any other connection.
 * `mentions`: the current text of a doc refers to it (#112); rewritten with each doc version.
 */
export type LinkRole = 'source' | 'affects' | 'related' | 'mentions' | 'part_of';

/** One task that is part of another (#841): its state in words, and who has it. */
export interface TaskSubtask {
  id: string;
  number: number;
  title: string;
  status: WorkStatus;
  owner: NamedPrincipal | null;
}

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
  /**
   * Agents only, on native work rows and task details (#339 AC-2): the owner from the current
   * authorized project audience, the same boundary as `ConversationMessage` authors. Absent when
   * the owner is hidden or the agent is not in the audience; the browser never infers it otherwise.
   */
  projectOwner?: AgentProjectOwner;
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

/** The current state of a direct prerequisite. It is met only while it is `done`. */
export interface TaskPrerequisite {
  id: string;
  title: string;
  status: WorkStatus;
  met: boolean;
}

/**
 * What a blocked task waits for besides a person (#868): one decision or one other task of the same space. When the decision is accepted
 * or the task is done, the task goes back to Doing by itself.
 */
export type WaitingOn =
  | { kind: 'decision'; id: string; title: string }
  | { kind: 'task'; id: string; number: number; title: string };

/** What a task waits for, as a phrase after "waiting for": "the decision Use LoRa for the far beds" or "#7" (#868). */
export const waitingPhrase = (on: WaitingOn): string => on.kind === 'decision' ? `the decision ${on.title}` : `#${on.number}`;

export interface WorkItem extends ProjectObject {
  lifecycle?: TaskLifecycle;
  creationUndo?: TaskCreationUndoEligibility;
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
  /** Task detail only (#841): the tasks that are part of this one, by number. An agent or a person splits a task into these. */
  subtasks?: TaskSubtask[];
  /** Null for tasks created without a plan intent, including every task from before this existed. */
  planIntent: TaskPlanIntent | null;
  status: WorkStatus;
  /** Only while blocked. */
  blocker: string | null;
  /** Only while blocked: the one person it waits for (#550), a member of the project; null for no one. */
  waitingFor: NamedPrincipal | null;
  /** Only while blocked: the one decision or task it waits for (#868); never together with `waitingFor`. */
  waitingOn: WaitingOn | null;
  /** Only while done: the task was dropped, not finished (#868: "Not pursued" is Done with a "dropped" note). */
  dropped: boolean;
  /** Only while done: the one optional line, "what came of it" (#868); it was also written in the task's discussion. */
  cameOfIt: string | null;
  /**
   * The calendar day it is due (#488): `YYYY-MM-DD`, with no time zone and no time, so it is the same day for everyone;
   * null for none. Years 1970-9999.
   */
  dueOn: string | null;
  owner: NamedPrincipal | null;
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

export interface CreateWorkCommand {
  /** Durable domain retry identity, reused by every entry point for this exact creation. */
  clientCommandId?: string;
  title: string;
  outcome?: string;
  owner?: PrincipalRef | null;
  status?: WorkStatus;
  blocker?: string;
  /** Who a blocked task waits for (#550): a person with access to the project. Applies to blocked work only. */
  waitingFor?: PrincipalRef | null;
  /** A decision or a task of this space a blocked task waits for (#868); not together with `waitingFor`. */
  waitingOn?: { kind: 'decision' | 'task'; id: string } | null;
  /** The calendar day it is due (#488), `YYYY-MM-DD`; omitted or null for none. */
  dueOn?: string | null;
  /** Messages, sketch thoughts or material versions the work comes from. They are linked, never moved or copied. */
  sources?: ObjectRef[];
  /** Other objects of the project to connect (thoughts, decisions, messages). */
  related?: ObjectRef[];
  /** At most 20 distinct trimmed statements of 1-1,000 characters. */
  criteria?: string[];
  /** At most 50 distinct tasks of the same project that must be done first. */
  dependencyIds?: string[];
  /** #841: the task of this project this one is a subtask of. It is part of it; the parent does not wait for it. */
  parentId?: string;
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
  kind: 'task.created' | 'task.creation_reverted' | 'task.blocked' | 'task.unblocked' | 'task.resumed';
  /** For a blocked line (#550): who the task waits for and the reason, as the line said them. */
  waitingFor?: NamedPrincipal | null;
  /** For a blocked line, the reason; for a resumed line (#868), what was resolved: "the decision was accepted". */
  reason?: string | null;
  /** Current lifecycle; original notice identity and actor remain unchanged. */
  lifecycle?: TaskLifecycle;
  /** Current task label; the exact historical identity/creator/sources below are retained. */
  workTitle: string;
  /** The task's number in its project, "#12" (#276), so the announcement names it from the start. */
  workNumber: number;
  createdBy: NamedPrincipal;
  sources: ObjectRef[];
  createdAt: string;
}

/**
 * What the conversation says about a decision (#694, F-026 P5): one line with who and where it came
 * from, and the object as a card that opens in Details. Like a task notice it is information, never a message.
 * A decision has up to two: when it was proposed and when a person accepted it. `title` and the state are the
 * object's current ones; `by` and `createdAt` are who did it and when. The audience is the project's: only
 * people who can read the project read these.
 */
interface ObjectNoticeBase {
  /** Stable per object and moment, `<id>:proposed` or `<id>:accepted`. */
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  by: NamedPrincipal;
  /** What it was made from, in the order it was linked: messages, thoughts, material versions, docs, sketches. */
  sources: ObjectRef[];
  /** The conversation (root or thread) of the first message source, so a thread shows what came of it; null for none. */
  conversationId: string | null;
  createdAt: string;
}
export type ObjectNotice = ObjectNoticeBase & { kind: 'decision.proposed' | 'decision.accepted'; decisionId: string; status: DecisionStatus };

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
  /** Who a blocked task waits for (#550); `null` clears it. It also clears when the task leaves Blocked. */
  waitingFor?: PrincipalRef | null;
  /**
   * A decision still proposed, or a task not yet done, of this space that a blocked task waits for (#868); `null` clears it. A task waits
   * for one thing: naming one clears the other. It also clears when the task leaves Blocked.
   */
  waitingOn?: { kind: 'decision' | 'task'; id: string } | null;
  /** `true` with Done: the task was dropped, not finished (#868). It clears when the task leaves Done. */
  dropped?: boolean;
  /** One optional line at Done, "what came of it" (#868); a nonempty line is also written in the task's discussion. `null` clears it. */
  cameOfIt?: string | null;
  /** The calendar day it is due (#488), `YYYY-MM-DD`; `null` clears it. Changing only the due date is an ordinary versioned change. */
  dueOn?: string | null;
  /**
   * An Undo: this change puts back what an earlier one replaced. It contributes no blocker message, so Undo never
   * posts the same blocker twice (#550).
   */
  restore?: boolean;
  /** Replaces the whole list. */
  criteria?: string[];
  /**
   * Replaces the whole set. A task that is in progress or done keeps every prerequisite done;
   * cycles, itself and tasks of other projects are rejected. A plan intent can never be changed here.
   */
  dependencyIds?: string[];
}

/** What a task's activity keeps (#488): one entry per changed field. Creation is not an entry; readers derive it from `createdBy`/`createdAt`. */
export type TaskActivityKind = 'status' | 'owner' | 'due' | 'title';

export interface TaskActivityEntry {
  id: string;
  kind: TaskActivityKind;
  /** When the change was committed. */
  at: string;
  /** Who made it: the person or agent that acted, named as the task names its owner and creator. */
  actor: NamedPrincipal;
  /**
   * Set when the change was made by a task rule of a linked pull request on its author's behalf (`actor` is that author),
   * so a reader never mistakes it for the author's own action. `agent_deleted`: the owner deleted the agent that held the task
   * and it came back to them (#1003). `agent_unable`: the agent could not take or work on it (it needs a connection, it is paused, or it gave
   * up) and it came back to its owner (#1424); `agent_rule` is the agent's own hand-back when it finished.
   */
  automation?: 'github_rule' | 'agent_rule' | 'agent_unable' | 'agent_deleted' | 'wait_resolved';
  /**
   * `kind: 'status'`. `blocker`, `waitingFor` and `waitingOn` (a decision's or task's name, as the line said it) are what a move into Blocked said;
   * null for any other `to`. `dropped` is for a move into Done.
   */
  status?: { from: WorkStatus; to: WorkStatus; blocker: string | null; waitingFor: NamedPrincipal | null; waitingOn?: string | null; dropped?: boolean };
  /** `kind: 'owner'`. Null is nobody. */
  owner?: { from: NamedPrincipal | null; to: NamedPrincipal | null };
  /** `kind: 'due'`. Calendar dates, `YYYY-MM-DD`, or null for none. */
  due?: { from: string | null; to: string | null };
  /** `kind: 'title'`. */
  title?: { from: string; to: string };
}

/** One newest-first page of a task's activity. Pass `nextBefore` as `before` for the next older page; null at the end. */
export interface TaskActivityPage {
  workId: string;
  items: TaskActivityEntry[];
  nextBefore: string | null;
}

/** Query of `GET /api/v1/work/:workId/activity`. `before` is the opaque cursor of an earlier page. */
export interface TaskActivityQuery {
  limit?: number;
  before?: string;
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
 * Accepting a decision that replaces another marks the earlier one superseded. Nothing else changes:
 * Flux does not move or park tasks when a decision changes (#871).
 */
export type AcceptDecisionCommand = VersionPrecondition;

export interface CreateObjectLinkCommand {
  from: { type: WorkObjectType; id: string };
  to: ObjectRef;
}
