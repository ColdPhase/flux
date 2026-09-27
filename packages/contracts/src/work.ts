import type { PrincipalRef, VersionPrecondition } from './access.js';

/**
 * Work items, decisions and results of a project (issue #101, foundation 8.5/8.6).
 * They are distinct objects with stable ids, connected to each other and to conversation
 * messages and material versions by many-to-many links. Everything is visible exactly to the
 * people and agents with current access to the project; there is no second audience.
 */
export const projectWorkPath = (projectId: string) => `/api/v1/projects/${projectId}/work`;
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

export const WORK_LIMITS = { title: 200, outcome: 4000, blocker: 2000, rationale: 20_000, evidence: 20_000, links: 50 } as const;

/** A stable reference to something in the same project. Material references pin a version. */
export type ObjectRef =
  | { type: 'message'; id: string }
  | { type: 'material'; id: string; version: number }
  | { type: WorkObjectType; id: string };

/**
 * `source`: created from, or based on, a message or material version (the source stays in place).
 * `affects`: a decision concerns this work. `still_applies`: at a pivot, work that remains useful.
 * `about`: a result reports on this work or decision. `related`: any other connection.
 */
export type LinkRole = 'source' | 'affects' | 'still_applies' | 'about' | 'related';

export interface ObjectLink {
  id: string;
  projectId: string;
  role: LinkRole;
  from: { type: WorkObjectType; id: string };
  to: ObjectRef;
  /** Current titles of both ends (a message's opening words), so a reader can follow the link. */
  fromTitle: string;
  toTitle: string;
  /** The conversation of a message target, else null. */
  conversationId: string | null;
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

export interface WorkItem extends ProjectObject {
  title: string;
  /** What finishing it should achieve; may be empty for small tasks. */
  outcome: string;
  status: WorkStatus;
  /** Only while blocked. */
  blocker: string | null;
  owner: NamedPrincipal | null;
  /** Set when a pivot parked the work. Parking keeps the status: parked work is not done. */
  parked: { decisionId: string; at: string } | null;
  createdBy: NamedPrincipal;
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
  title: string;
  outcome?: string;
  owner?: PrincipalRef | null;
  status?: WorkStatus;
  blocker?: string;
  /** Messages or material versions the work comes from. They are linked, never moved or copied. */
  sources?: ObjectRef[];
  /** Other objects of the project to connect (thoughts, decisions, results, messages). */
  related?: ObjectRef[];
}

export interface UpdateWorkCommand extends VersionPrecondition {
  title?: string;
  outcome?: string;
  owner?: PrincipalRef | null;
  status?: WorkStatus;
  blocker?: string | null;
  /** `false` takes parked work back into the plan. Parking happens only through a pivot. */
  parked?: false;
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
  title: string;
  finding: ResultFinding;
  evidence?: string;
  sources?: ObjectRef[];
  work?: string[];
  decisions?: string[];
  /** A work item of `work` this result finishes (its status becomes done), e.g. a negative experiment. */
  finishes?: string;
}

export interface CreateLinkCommand {
  from: { type: WorkObjectType; id: string };
  to: ObjectRef;
}
