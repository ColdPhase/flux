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
