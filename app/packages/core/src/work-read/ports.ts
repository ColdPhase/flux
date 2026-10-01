import type { NativeWorkRow, ObjectLink, PrincipalRef, ProjectAccess, ProjectWorkSummary, SourceAssociationCounts, WorkDetailProjection } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { WorkReadCursor } from '@flux/contracts';
import type { WorkReadSlice } from './cursor.js';
import type { WorkAssociationSelection, WorkReadObject, WorkRelationRead, WorkViewSelection } from './query.js';

/** Core owns the bounded read port. Adapters use native DB/policy; no events/commands are exposed. */
export interface WorkReadAccess {
  requireProject(principal: Principal, projectId: string): Promise<{ workspaceId: string; access: ProjectAccess }>;
}
export type WorkSummaryObservation = Omit<ProjectWorkSummary, 'access'>;
export type WorkDetailObservation = Omit<WorkDetailProjection, 'access'>;
export interface WorkAssociationObservation {
  objects: WorkReadSlice<NativeWorkRow>;
  sources: WorkReadSlice<SourceAssociationCounts>;
  edges: WorkReadSlice<ObjectLink>;
  edgeTotal: number;
  observedAt: string;
}
export interface WorkReadRepository {
  /** Fixed-size digest covering ALL relevant native endpoint visibility, including counted unseen sources. */
  sourceVisibilityFingerprint(projectId: string): Promise<string>;
  summary(projectId: string, caller: PrincipalRef): Promise<WorkSummaryObservation>;
  /** Native selector validation precedes totals, keys and bounded row hydration. No legacy unlimited links. */
  view(projectId: string, caller: PrincipalRef, selection: WorkViewSelection, limit: number, cursor?: WorkReadCursor): Promise<WorkReadSlice<NativeWorkRow>>;
  selectedWork(projectId: string, id: string): Promise<NativeWorkRow>;
  detail(projectId: string, object: WorkReadObject): Promise<WorkDetailObservation>;
  relations(projectId: string, selection: WorkRelationRead['selection'], limit: number, cursor?: WorkReadCursor): Promise<{ page: WorkReadSlice<ObjectLink>; observedAt: string }>;
  /** Source policy/existence validation must precede ALL count/page queries, including a zero-link source. */
  requireSources(projectId: string, selection: WorkAssociationSelection): Promise<void>;
  associationObjects(projectId: string, selection: WorkAssociationSelection, limit: number, cursor?: WorkReadCursor): Promise<WorkReadSlice<NativeWorkRow>>;
  associationSources(projectId: string, selection: WorkAssociationSelection, cursor?: WorkReadCursor): Promise<WorkReadSlice<SourceAssociationCounts>>;
  associationEdges(projectId: string, selection: WorkAssociationSelection, objects: readonly WorkReadObject[], cursor?: WorkReadCursor): Promise<WorkReadSlice<ObjectLink>>;
  associationEdgeTotal(projectId: string, selection: WorkAssociationSelection): Promise<number>;
  observedAt(): Promise<string>;
}
export interface WorkReadPorts { access: WorkReadAccess; rows: WorkReadRepository }
/** Every count/page/name/ref/policy query runs in ONE read-only REPEATABLE READ transaction. */
export interface WorkReadUnitOfWork { run<T>(read: (ports: WorkReadPorts) => Promise<T>): Promise<T> }
export interface WorkReadObservation<T> { value: T; sourceVisibility: string }

/** Outside that observation: require the SAME exact session, current project policy and source digest. */
export interface WorkReadFinalFence {
  check(principal: Principal, projectId: string, sourceVisibility: string): Promise<ProjectAccess>;
}
