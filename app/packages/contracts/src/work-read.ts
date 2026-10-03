import type { ProjectAccess } from './access.js';
import type { Decision, NamedPrincipal, ObjectLink, ResultFinding, WorkItem, WorkObjectType, WorkResult, WorkStatus } from './work.js';

/** Bounded native reads (#155/#151/#136). These projections are NOT full WorkItem DTOs. */
export const projectWorkSummaryPath = (projectId: string) => `/api/v1/projects/${projectId}/work-summary`;
export const projectWorkViewPath = (projectId: string) => `/api/v1/projects/${projectId}/work-view`;
export const projectWorkAssociationsPath = (projectId: string) => `/api/v1/projects/${projectId}/work-associations`;
export const projectWorkRelationsPath = (projectId: string) => `/api/v1/projects/${projectId}/work-relations`;
export const projectWorkDetailPath = (projectId: string, kind: WorkObjectType, id: string) =>
  `/api/v1/projects/${projectId}/work-objects/${kind}/${id}`;

export const WORK_GROUPS = ['needs', 'in_progress', 'blocked', 'open', 'parked', 'finished', 'rules', 'results'] as const;
export type WorkGroup = typeof WORK_GROUPS[number];
export type WorkCounts = Record<WorkGroup, number>;
export const WORK_READ_LIMITS = { defaultPage: 50, page: 100, sourceIds: 100, relationObjects: 100, edges: 100, query: 200, cursor: 512, owners: 3 } as const;

export interface WorkReadQuery {
  /** 1..100, default 50. A row page never hydrates implicit unlimited links. */
  limit?: number;
  /** Closed, scope-bound bidirectional keyset; not an authority capability. */
  cursor?: string;
}

/** Flat URL fields are closed: combinations not in this union are invalid. */
export type ProjectWorkViewQuery = WorkReadQuery & (
  | { purpose?: 'tasks'; group?: 'all' | WorkGroup; mine?: boolean }
  | { purpose: 'choices'; choice: 'accepted_decisions' | 'pivot_work'; q?: string }
  | { purpose: 'choices'; choice: 'result_work'; q?: string; selected?: string }
  | { purpose: 'choices'; choice: 'parked_work'; decisionId: string; q?: string }
  | { purpose: 'choices'; choice: 'doc_refs'; kind: WorkObjectType; q?: string }
);

/** Exactly one source selector. messageIds is a comma-separated, normalized set of UUIDs. */
export type WorkAssociationQuery = WorkReadQuery & {
  relation?: 'source' | 'any';
  /** Continuation only within the current selected object window; it also binds that window. */
  edgeCursor?: string;
} & (
  | { messageIds: string; conversationId?: never; sourceCursor?: never }
  | { conversationId: string; messageIds?: never; sourceCursor?: string }
);

/** objects is a comma-separated set of native work:<id>,decision:<id>,result:<id> refs. */
export interface WorkRelationQuery extends WorkReadQuery {
  objects: string;
  /** Default all; a specific role selects that complete native relation subset. */
  role?: ObjectLink['role'];
}

export interface WorkReadRef { kind: WorkObjectType; id: string; title: string }
export interface WorkRelationCounts {
  /** Visible native edges; distinct objects are counted separately below. */
  edges: number;
  sourceMessages: number;
  sourceMaterials: number;
  decisions: number;
  results: number;
}

interface NativeRowBase {
  id: string;
  projectId: string;
  workspaceId: string;
  audience: { kind: 'project'; projectId: string };
  title: string;
  createdAt: string;
  relations: WorkRelationCounts;
}

export interface WorkRowProjection extends NativeRowBase {
  kind: 'work';
  /** Direct native task prerequisites only; page rows never hydrate the graph. */
  prerequisiteCounts: { total: number; unmet: number };
  status: WorkStatus;
  owner: NamedPrincipal | null;
  blocker: string | null;
  parked: WorkItem['parked'];
  parkedBy: WorkReadRef | null;
  rule: WorkReadRef | null;
  version: number;
  updatedAt: string;
}

export interface DecisionRowProjection extends NativeRowBase {
  kind: 'decision';
  status: Decision['status'];
  proposedBy: NamedPrincipal;
  decidedBy: NamedPrincipal | null;
  decidedAt: string | null;
  supersedes: string | null;
  supersededAt: string | null;
  supersededBy: string | null;
  version: number;
  updatedAt: string;
}

export interface ResultRowProjection extends NativeRowBase {
  kind: 'result';
  finding: ResultFinding;
  createdBy: NamedPrincipal;
}
export type NativeWorkRow = WorkRowProjection | DecisionRowProjection | ResultRowProjection;

export interface ProjectWorkSummary {
  projectId: string;
  /** Per-request coherent native DB observation, not a durable snapshot or permissions proof. */
  observedAt: string;
  /** Final current-policy access; counts/refs below describe the data observation. */
  access: ProjectAccess;
  all: WorkCounts;
  mine: WorkCounts;
  workTotal: number;
  /** Unparked open/in-progress/blocked work; the Tasks tab count. */
  unfinishedTotal: number;
  state: {
    rule: WorkReadRef | null;
    proposal: WorkReadRef | null;
    active: { count: number; first: WorkReadRef | null; owners: NamedPrincipal[]; ownerTotal: number };
    blocked: { count: number; first: WorkReadRef | null };
    open: { count: number; first: WorkReadRef | null };
    history: { completed: number; notPursued: number; parked: number; firstWork: WorkReadRef | null;
      decisionCount: number; firstDecision: WorkReadRef | null };
    result: (WorkReadRef & { finding: ResultFinding }) | null;
  };
}

export interface WorkPage<T> {
  items: T[];
  total: number;
  limit: number;
  /** Number of currently selected objects preceding the first displayed item in this observation. */
  before: number;
  nextCursor: string | null;
  previousCursor: string | null;
}

export interface ProjectWorkView extends WorkPage<NativeWorkRow> {
  /** Atomic combined page + summary from the same native read transaction. */
  summary: ProjectWorkSummary;
  /** result_work only: explicit deep selection, outside eligible total/page, at most 1 additional row. */
  selected: NativeWorkRow | null;
}

export interface SourceAssociationCounts {
  messageId: string;
  /** Distinct native object identities; relation edge counts are separate. */
  work: number;
  decisions: number;
  results: number;
  edges: number;
}

export interface WorkAssociations extends WorkPage<NativeWorkRow> {
  observedAt: string;
  /** Exact scoped totals per selected message (or per returned conversation message window). */
  sources: SourceAssociationCounts[];
  sourceTotal: number;
  /** Conversation scopes page their message-count window independently; at most 100 entries. */
  sourceNextCursor: string | null;
  sourcePreviousCursor: string | null;
  /** One GLOBAL matched-edge window for the current object page, at most 100 edges. */
  edges: WorkPage<ObjectLink>;
  /** Exact matching edges across the entire native source scope, not only the current object window. */
  edgeTotal: number;
}

export interface WorkRelations extends WorkPage<ObjectLink> { observedAt: string }

export type WorkDetailObject =
  | ({ kind: 'work' } & Omit<WorkItem, 'links'>)
  | ({ kind: 'decision' } & Omit<Decision, 'links'>)
  | ({ kind: 'result' } & Omit<WorkResult, 'links'>);

export interface WorkDetailProjection {
  observedAt: string;
  access: ProjectAccess;
  object: WorkDetailObject;
  relations: WorkRelationCounts;
  /** At most 3 actual native parked-by/earlier/later decision references. */
  context: WorkReadRef[];
}

/** Private, documented cursor envelope; wire clients treat it as opaque. */
export interface WorkReadCursor {
  v: 1;
  direction: 'next' | 'previous';
  /** SHA-256 of normalized project/principal/endpoint/selector/window; not raw source lists. */
  scope: string;
  /** Rank includes native kind/status bands; timestamps preserve PostgreSQL precision. */
  boundary: { rank: number; createdAt: string; id: string };
}
