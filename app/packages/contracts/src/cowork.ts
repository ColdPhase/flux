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
/**
 * What a person or sender may honestly say about a request (#153 AC-3): waiting in the recipient's inbox (`queued`), put
 * off by the recipient for a stated reason (`deferred`), being worked under a live claim (`working`), the recipient has
 * no live session or was revoked (`offline`), cancelled, or finished (resolved, declined, superseded, expired).
 * Derived from stored facts, never from a heartbeat or an acknowledgement.
 */
export type CoWorkRequestStatus = 'queued' | 'deferred' | 'working' | 'offline' | 'cancelled' | 'resolved' | 'declined' | 'superseded' | 'expired';
/** Status of a request already reduced to its effective state; `offline` needs a live-session fact only the server has. */
export function coWorkRequestStatus(effectiveState: CoWorkRequestState, recipientOffline = false): CoWorkRequestStatus {
  if (effectiveState === 'claimed') return 'working';
  if (['queued', 'deferred'].includes(effectiveState)) return recipientOffline ? 'offline' : effectiveState as 'queued' | 'deferred';
  return effectiveState as CoWorkRequestStatus;
}
export interface CoWorkInboxRecord extends CoWorkRequestRecord {
  status: CoWorkRequestStatus;
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
  /** The version the card was read at; a cancel names it so it never acts on a request that moved on. */
  version: number;
  /** Honest status: queued, deferred, working, offline, cancelled or the closing outcome. */
  status: CoWorkRequestStatus;
  reason: string | null;
  /** For a deferred request, the safe checkpoint at which the recipient will take it up. */
  nextBoundary: string | null;
  target: CoWorkSourceRef;
  /** The target's title while it still exists at the named version; null otherwise (nothing else about it is shown). */
  targetTitle: string | null;
  targetAvailable: boolean;
  responseRef: CoWorkSourceRef | null;
  /** A message the request names as its target or source and the reader may open, if any. */
  originalMessage: CoWorkOriginalMessage | null;
  sender: { connectionId: string; name: string; ownerName: string };
  recipient: { connectionId: string; name: string; ownerName: string };
  /** The person who cancelled it, for a cancelled request. */
  cancelledBy: { name: string } | null;
  /** Whether the reader may cancel it now: a project manager, or the owner of the sender or recipient, while it is open. */
  canCancel: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
/** A message in a conversation the reader can open: a person's conversation or a task's agents' thread. */
export interface CoWorkOriginalMessage { messageId: string; conversationId: string; space: 'people' | 'agents'; taskId: string | null }
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

/** Cancel an open request from its card (#400 AC-4). A manager, or the owner of the sender or recipient agent, may. */
export interface CancelCoWorkRequestCommand { expectedVersion: number }
export const taskCoordinationCancelPath = (workId: string, requestId: string) => `/api/v1/work/${workId}/coordination/requests/${requestId}/cancel`;

/**
 * A handoff packet (#153 AC-2): the references of one request, bounded and read for the person downloading it now.
 * It carries identities, titles that exist at the named versions and the unit's last checkpoint; never a credential,
 * grant, lease, fingerprint, prompt or the content of a source. A reference that no longer exists at its version is
 * listed as unavailable without a title.
 */
export interface CoWorkPacketReference { type: CoWorkSourceRef['type']; id: string | null; version: number | null; title: string | null; available: boolean }
export interface CoWorkHandoffPacket {
  schema: 'flux.cowork.packet/1';
  generatedAt: string;
  request: { id: string; kind: CoWorkRequestKind; state: CoWorkRequestState; status: CoWorkRequestStatus; reason: string | null;
    nextBoundary: string | null; priority: number; peerUnblocking: boolean; createdAt: string; expiresAt: string;
    sender: { name: string; ownerName: string }; recipient: { name: string; ownerName: string } };
  task: { id: string; number: number; title: string; status: string; version: number };
  target: CoWorkPacketReference;
  sources: CoWorkPacketReference[];
  criteria: CoWorkPacketReference[];
  response: CoWorkPacketReference | null;
  originalMessage: CoWorkOriginalMessage | null;
  checkpoint: { summary: string; nextAction: string; blocker: string | null; sources: { materialId: string; version: number }[]; createdAt: string } | null;
  verdict: { verdict: CoWorkReviewVerdictValue; current: boolean; createdAt: string } | null;
}
export const taskCoordinationPacketPath = (workId: string, requestId: string) => `/api/v1/work/${workId}/coordination/requests/${requestId}/packet`;

/** How separate a reviewer must be from the author: another connection (the default) or another owner. */
export type CoWorkReviewRule = 'distinct_connection' | 'distinct_owner';
export interface CoWorkReviewPolicy {
  projectId: string;
  reviewSeparation: CoWorkReviewRule;
  /** Null until a manager chose explicitly; the default then applies. */
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
}
export interface SetCoWorkReviewPolicyCommand { reviewSeparation: CoWorkReviewRule }
export const projectReviewPolicyPath = (projectId: string) => `/api/v1/projects/${projectId}/review-policy`;
