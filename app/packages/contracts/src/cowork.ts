/** Coordination references only; source contents and current authority stay in their domains. */
export type CoWorkSourceRef =
  | { type: 'message' | 'result'; id: string }
  | { type: 'material' | 'doc' | 'work' | 'thought'; id: string; version: number }
  | { type: 'github_pr'; bindingId: string; linkId: string; headSha: string };
export type CoWorkRequestKind = 'help' | 'review' | 'fix' | 'handoff';
export type CoWorkRequestState = 'queued' | 'deferred' | 'claimed' | 'resolved' | 'declined' | 'superseded' | 'expired' | 'cancelled';
export interface CoWorkRequestLimits {
  maximumRequests: number;
  maximumDepth: number;
  maximumReviewRounds: number;
}
/** Input for the core/transaction adapter, not a new public tool or authority envelope. */
export interface CoWorkEnqueueCommand {
  commandId: string;
  unitId: string;
  expectedUnitVersion: number;
  recipientConnectionId: string;
  intentKey: string;
  parentRequestId: string | null;
  kind: CoWorkRequestKind;
  target: CoWorkSourceRef;
  sourceRefs: CoWorkSourceRef[];
  criteriaRefs: CoWorkSourceRef[];
  priority: number;
  peerUnblocking: boolean;
  lifetimeSeconds: number;
}
export interface CoWorkRequestRecord {
  id: string;
  lineageId: string;
  workspaceId: string;
  projectId: string;
  taskId: string;
  unitId: string;
  senderConnectionId: string;
  recipientConnectionId: string;
  senderOwnerId: string;
  recipientOwnerId: string;
  intentKey: string;
  parentRequestId: string | null;
  kind: CoWorkRequestKind;
  target: CoWorkSourceRef;
  sourceRefs: CoWorkSourceRef[];
  criteriaRefs: CoWorkSourceRef[];
  depth: number;
  reviewRound: number;
  priority: number;
  peerUnblocking: boolean;
  expiresAt: Date;
  state: CoWorkRequestState;
  version: number;
  reason: string | null;
  nextBoundary: string | null;
  dependencyRef: CoWorkSourceRef | null;
  claimedGeneration: number | null;
  responseRef: CoWorkSourceRef | null;
  createdAt: Date;
}
export interface CoWorkInboxRecord extends CoWorkRequestRecord {
  effectiveState: CoWorkRequestState;
  readinessReason: 'claim_lost' | 'request_expired' | 'unit_closed' | 'assignment_changed' | null;
}
/**
 * The coordination records of one task as its people may read them (#153 AC-4, #400 AC-4/AC-5): each request card's
 * kind, sender -> recipient, exact target and state, and each review verdict with whether it still applies to the
 * target's current version. Records only: no prompts, claims, leases or heartbeats.
 */
export interface TaskCoordinationRequest {
  id: string;
  kind: CoWorkRequestKind;
  state: CoWorkRequestState;
  reason: string | null;
  target: CoWorkSourceRef;
  responseRef: CoWorkSourceRef | null;
  sender: { connectionId: string; name: string };
  recipient: { connectionId: string; name: string };
  createdAt: string;
  updatedAt: string;
}
export type CoWorkReviewVerdictValue = 'passed' | 'changes_requested';
export interface TaskCoordinationVerdict {
  requestId: string;
  verdict: CoWorkReviewVerdictValue;
  target: CoWorkSourceRef;
  criteriaRefs: CoWorkSourceRef[];
  evidenceRef: CoWorkSourceRef;
  reviewer: { connectionId: string; name: string };
  author: { connectionId: string; name: string };
  /** False once the reviewed target has a newer version: the verdict no longer applies. */
  current: boolean;
  createdAt: string;
}
export interface TaskCoordination { taskId: string; requests: TaskCoordinationRequest[]; verdicts: TaskCoordinationVerdict[] }
export const taskCoordinationPath = (workId: string) => `/api/v1/work/${workId}/coordination`;
