import type { DecisionStatus, LinkOwnerType, LinkRole, ObjectRef, ResultFinding, TaskPlanIntent, WorkStatus } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { PlanIntentRecord, TaskGraphReader } from './task-graph.js';

/**
 * Ports of the work, decision and result use cases (issues #101, #46). Core states what it
 * needs; the server implements them with the access policy (`authorize`, `evaluateProject`,
 * `visibleFilter`), the `@flux/db` work rows and `recordEvent`, and passes them in. Nothing in
 * `packages/core/src/work` imports those adapters.
 */

/** A person or an agent as stored on a row. */
export interface ActorRef {
  kind: 'human' | 'agent';
  id: string;
}

export interface WorkRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  outcome: string;
  status: WorkStatus;
  blocker: string | null;
  owner: ActorRef | null;
  parked: { decisionId: string; at: Date } | null;
  /** Distinct trimmed statements; `[]` for tasks that never had any (#152). */
  criteria: string[];
  createdBy: ActorRef;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DecisionRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  rationale: string;
  status: DecisionStatus;
  proposedBy: ActorRef;
  decidedBy: string | null;
  decidedAt: Date | null;
  supersedesId: string | null;
  supersededById: string | null;
  supersededAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResultRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  finding: ResultFinding;
  evidence: string;
  createdBy: ActorRef;
  createdAt: Date;
}

export interface ObjectLinkRecord {
  id: string;
  projectId: string;
  role: LinkRole;
  fromType: LinkOwnerType;
  fromId: string;
  toType: ObjectRef['type'];
  toId: string;
  toVersion: number | null;
  createdAt: Date;
}

export type NewWork = Omit<WorkRecord, 'version' | 'createdAt' | 'updatedAt' | 'parked' | 'criteria'> & {
  criteria?: string[];
  clientCommandId?: string;
  requestFingerprint?: string;
};
export interface TaskCreationNoticeRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  workId: string;
  workTitle: string;
  createdBy: ActorRef;
  sources: ObjectRef[];
  createdAt: Date;
}
export type WorkChanges = Partial<Pick<WorkRecord, 'title' | 'outcome' | 'status' | 'blocker' | 'owner' | 'parked' | 'criteria'>>;
export type NewDecision = Pick<DecisionRecord, 'id' | 'workspaceId' | 'projectId' | 'title' | 'rationale' | 'proposedBy' | 'supersedesId'>;
export type DecisionChanges = Partial<Pick<DecisionRecord, 'status' | 'decidedBy' | 'decidedAt' | 'supersededById' | 'supersededAt'>>;
export type NewResult = Omit<ResultRecord, 'createdAt'>;
export interface NewObjectLink {
  id: string;
  workspaceId: string;
  projectId: string;
  role: LinkRole;
  from: { type: LinkOwnerType; id: string };
  to: ObjectRef;
  createdBy: ActorRef;
}

/** What a task presents of its plan: its direct prerequisites with their current state and its intent. */
export interface TaskPlanRecord {
  /** Ascending by id. */
  prerequisites: { id: string; title: string; status: WorkStatus; parked: boolean }[];
  planIntent: TaskPlanIntent | null;
}

export interface Paged<T> { items: T[]; total: number }
export interface PageWindow { limit: number; offset: number }

/** Adapter over the core access policy. It never reveals objects the principal cannot see. */
export interface WorkAccess {
  /**
   * Throws NotFoundError when the project is invisible to the principal and ForbiddenError when
   * `write` is not allowed. Inside a change pass `lock` so a concurrent revocation waits or is
   * seen. Returns the project's workspace.
   */
  requireProject(principal: Principal, action: 'read' | 'write', projectId: string, options?: { lock?: boolean }): Promise<{ workspaceId: string }>;
  /** Throws NotFoundError unless the principal is active in the workspace. */
  requireWorkspace(principal: Principal, workspaceId: string): Promise<void>;
  /** Whether a prospective owner can currently read the project. */
  canRead(candidate: ActorRef, projectId: string): Promise<boolean>;
}

/** Rows only; the repository makes no access decisions (the use cases ask {@link WorkAccess}). */
export interface WorkRepository extends TaskGraphReader {
  /** The project of an object, whoever may read it; callers must authorize before using it. */
  locate(type: 'work' | 'decision' | 'result', id: string): Promise<{ projectId: string } | null>;
  listWork(projectId: string, page: PageWindow): Promise<Paged<WorkRecord>>;
  /**
   * Unfinished, unparked work owned by `owner` in the projects of `workspaceId` that pass the
   * policy's list filter (`visibleFilter`) for `principal`, applied before the page and the total.
   */
  listAssignedVisible(principal: Principal, workspaceId: string, owner: ActorRef, page: PageWindow): Promise<Paged<WorkRecord>>;
  findWork(id: string, options?: { lock?: boolean }): Promise<WorkRecord | null>;
  insertWork(work: NewWork): Promise<WorkRecord>;
  /** Acquires the durable retry lock before looking up an earlier creation. */
  createdWork(projectId: string, by: ActorRef, commandId: string): Promise<{ work: WorkRecord; fingerprint: string } | null>;
  /** Called in the same transaction as the work row, links and stream event. */
  insertCreationNotice(work: WorkRecord, sources: ObjectRef[]): Promise<void>;
  listTaskNotices(projectId: string, page: PageWindow): Promise<Paged<TaskCreationNoticeRecord>>;
  /** Applies the changes and increments the version; the caller has checked the version. */
  updateWork(id: string, changes: WorkChanges): Promise<WorkRecord>;
  /**
   * Locks the task rows of the workspace in ascending id order and returns those that exist with their
   * project. Callers hold the project graph locks first; this is the complete sorted task pass.
   */
  lockTasks(workspaceId: string, ids: readonly string[]): Promise<{ id: string; projectId: string }[]>;
  /** Replaces the direct prerequisites of one task. Ids are validated, locked and cycle-checked by the caller. */
  replaceDependencies(scope: { workspaceId: string; projectId: string }, taskId: string, prerequisiteIds: readonly string[]): Promise<void>;
  /** Prerequisites with their state and the plan intent of each task; tasks with neither are absent. */
  taskPlans(taskIds: readonly string[]): Promise<Map<string, TaskPlanRecord>>;
  /** Share-locks the plan material of the project and returns its current version, or null when it is not there. */
  lockPlanSource(workspaceId: string, projectId: string, materialId: string): Promise<{ currentVersion: number } | null>;
  findPlanIntent(projectId: string, intent: TaskPlanIntent): Promise<PlanIntentRecord | null>;
  insertPlanIntent(scope: { workspaceId: string; projectId: string }, intent: TaskPlanIntent, record: PlanIntentRecord): Promise<void>;
  listDecisions(projectId: string, page: PageWindow): Promise<Paged<DecisionRecord>>;
  findDecision(id: string, options?: { lock?: boolean }): Promise<DecisionRecord | null>;
  insertDecision(decision: NewDecision): Promise<DecisionRecord>;
  updateDecision(id: string, changes: DecisionChanges): Promise<DecisionRecord>;
  listResults(projectId: string, page: PageWindow): Promise<Paged<ResultRecord>>;
  findResult(id: string): Promise<ResultRecord | null>;
  insertResult(result: NewResult): Promise<ResultRecord>;
  /** Links from or to any of these ids, oldest first. */
  links(ids: string[]): Promise<ObjectLinkRecord[]>;
  /** Inserts links; an identical existing link is kept. */
  insertLinks(links: NewObjectLink[]): Promise<void>;
  /** Whether the referenced message, material version or object exists in the project. */
  targetExists(projectId: string, ref: ObjectRef): Promise<boolean>;
  /**
   * Titles of linked objects keyed by `<type>:<id>` (a message's opening words and its
   * conversation, a material version's title, a doc's current title, a project sketch's title).
   * Only for references inside `projectId`; private sketches and their thoughts are never included.
   */
  titles(projectId: string, refs: ObjectRef[]): Promise<Map<string, { title: string; conversationId?: string; sketchId?: string }>>;
  /** Display names keyed by `<kind>:<id>`. */
  names(refs: ActorRef[]): Promise<Map<string, string>>;
}

export type WorkEventKind =
  | 'project.work_created.v1'
  | 'project.work_updated.v1'
  | 'project.decision_proposed.v1'
  | 'project.decision_accepted.v1'
  | 'project.result_recorded.v1'
  | 'project.link_created.v1';

/** Records a versioned project event in the unit of work (identifiers only, never content). */
export interface WorkEventLog {
  record(principal: Principal, workspaceId: string, kind: WorkEventKind, projectId: string, data: Record<string, unknown>): Promise<void>;
}

export interface WorkPorts {
  access: WorkAccess;
  work: WorkRepository;
  events: WorkEventLog;
  backgroundComparison: {
    /** A candidate only: the outbox never grants permission to call a provider. */
    enqueueHumanNegative(resultId: string, projectId: string, authorId: string): Promise<number>;
  };
}

/**
 * Runs `work` in one transaction: the decision, the change and its event commit together or not
 * at all. Called on an open transaction (such as an idempotency scope) it nests in it.
 */
export interface WorkUnitOfWork {
  run<T>(work: (ports: WorkPorts) => Promise<T>): Promise<T>;
}
