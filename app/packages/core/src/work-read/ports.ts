import type { NativeWorkRow, ObjectLink, ThoughtTaskRow, PrincipalRef, ProjectAccess, ProjectWorkSummary, SourceAssociationCounts, WorkDetailProjection } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { TaskCreationUndoFacts } from '../work/creation-undo.js';
import type { WorkReadCursor } from '@flux/contracts';
import type { WorkReadSlice } from './cursor.js';
import type { WorkAssociationSelection, WorkReadObject, WorkRelationRead, WorkViewSelection } from './query.js';

/** Core owns the bounded read port. Adapters use native DB/policy; no events/commands are exposed. */
export interface WorkReadAccess {
  requireProject(principal: Principal, projectId: string): Promise<{ workspaceId: string; access: ProjectAccess }>;
}
export type WorkSummaryObservation = Omit<ProjectWorkSummary, 'access'>;
/** A task detail also carries the facts its reader's Undo eligibility is decided from (#238); they are not returned. */
export type WorkDetailObservation = Omit<WorkDetailProjection, 'access'> & { undo?: TaskCreationUndoFacts };
export interface WorkReferenceObservation { items: NativeWorkRow[]; unavailable: WorkReadObject[] }
/** Selected project thoughts and their linked tasks: exact counts and one window of <=100 pairs. */
export interface WorkThoughtTasksObservation {
  /** The selected ids that are thoughts of this project's project-scoped sketches, sorted. */
  visible: string[];
  counts: { thoughtId: string; tasks: number }[];
  links: { thoughtId: string; workId: string }[];
  linkTotal: number;
  items: ThoughtTaskRow[];
}
export interface WorkAssociationObservation {
  objects: WorkReadSlice<NativeWorkRow>;
  sources: WorkReadSlice<SourceAssociationCounts>;
  edges: WorkReadSlice<ObjectLink>;
  edgeTotal: number;
  observedAt: string;
}
export interface WorkReadRepository {
  /** Fixed-size digest covering ALL relevant native endpoint visibility, including counted unseen sources. */
  sourceVisibilityFingerprint(projectId: string, sources?: WorkAssociationSelection): Promise<string>;
  summary(projectId: string, caller: PrincipalRef): Promise<WorkSummaryObservation>;
  /** Native selector validation precedes totals, keys and bounded row hydration. No legacy unlimited links. */
  view(projectId: string, caller: PrincipalRef, selection: WorkViewSelection, limit: number, cursor?: WorkReadCursor): Promise<WorkReadSlice<NativeWorkRow>>;
  selectedWork(projectId: string, id: string): Promise<NativeWorkRow>;
  /** Only selected same-project identities are hydrated; missing/foreign markers are opaque. */
  references(projectId: string, objects: readonly WorkReadObject[]): Promise<WorkReferenceObservation>;
  detail(projectId: string, object: WorkReadObject): Promise<WorkDetailObservation>;
  relations(projectId: string, selection: WorkRelationRead['selection'], limit: number, cursor?: WorkReadCursor): Promise<{ page: WorkReadSlice<ObjectLink>; observedAt: string }>;
  /** Source policy/existence validation must precede ALL count/page queries, including a zero-link source. */
  requireSources(projectId: string, selection: WorkAssociationSelection): Promise<void>;
  associationObjects(projectId: string, selection: WorkAssociationSelection, limit: number, cursor?: WorkReadCursor): Promise<WorkReadSlice<NativeWorkRow>>;
  associationSources(projectId: string, selection: WorkAssociationSelection, cursor?: WorkReadCursor): Promise<WorkReadSlice<SourceAssociationCounts>>;
  associationEdges(projectId: string, selection: WorkAssociationSelection, objects: readonly WorkReadObject[], limit: number, cursor?: WorkReadCursor): Promise<WorkReadSlice<ObjectLink>>;
  associationEdgeTotal(projectId: string, selection: WorkAssociationSelection): Promise<number>;
  /** Thoughts are validated structurally; missing/foreign ones are simply not visible. */
  thoughtTasks(projectId: string, thoughtIds: readonly string[]): Promise<WorkThoughtTasksObservation>;
  observedAt(): Promise<string>;
}
export interface WorkReadPorts { access: WorkReadAccess; rows: WorkReadRepository }
/** Every count/page/name/ref/policy query runs in ONE read-only REPEATABLE READ transaction. */
export interface WorkReadUnitOfWork { run<T>(read: (ports: WorkReadPorts) => Promise<T>): Promise<T> }
export interface WorkReadObservation<T> { value: T; sourceVisibility: string }
/** Owned normalized selectors must still exist in this project before releasing the observation. */
export interface WorkReadRequirements {
  sources?: WorkAssociationSelection;
  objects?: readonly WorkReadObject[];
  parkedDecisionId?: string;
  /** The selected found/marker partition must remain unchanged before release. */
  references?: { objects: readonly WorkReadObject[]; available: readonly WorkReadObject[] };
  /** The selected thoughts that are this project's thoughts must remain exactly these. */
  thoughts?: { requested: readonly string[]; visible: readonly string[] };
}

/** Outside that observation: require the SAME exact session, current project policy and source digest.
 * Represent native session rejection as DomainError(401), preserving the transport-neutral outcome.
 */
export interface WorkReadFinalFence {
  check(principal: Principal, projectId: string, sourceVisibility: string, required?: WorkReadRequirements): Promise<ProjectAccess>;
}
