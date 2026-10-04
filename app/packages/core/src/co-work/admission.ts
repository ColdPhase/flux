import type { CoWorkEnqueueCommand, CoWorkSourceRef } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError } from '../access/errors.js';
import type { CoWorkContext, CoWorkLease, CoWorkRole } from './claims.js';
import { normalizeCoWorkRequest } from './requests.js';

/** The sender's live claim fence for a `cowork.request`; it authorizes queued intent only. */
export interface CoWorkSenderFence { generation: number; leaseId: string }
export interface CoWorkAdmissionInput { fence: CoWorkSenderFence; request: CoWorkEnqueueCommand }
/** Server-owned project policy; never read from a payload or peer message. */
export type CoWorkReviewSeparation = 'distinct_connection' | 'distinct_owner';
export interface CoWorkAdmissionUnit {
  id: string;
  projectId: string;
  assignmentConnectionId: string;
  role: CoWorkRole;
  state: string;
  generation: number;
  lease: CoWorkLease | null;
  lineageTaskId: string;
  runId: string;
}
/** Facts read under the complete retained slot/task/unit locks; `now` is fresh DB wall time after them. */
export interface CoWorkAdmissionFacts {
  sender: CoWorkAdmissionUnit;
  recipient: CoWorkAdmissionUnit | null;
  recipientConnection: { id: string; ownerUserId: string } | null;
  now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Exactly `{ generation, leaseId, request }`; the durable client command ID becomes the request command ID. */
export function normalizeCoWorkAdmission(payload: unknown, commandId: string): CoWorkAdmissionInput {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new InvalidInputError('A bounded request payload is required');
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).sort().join(',') !== 'generation,leaseId,request'
    || !Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || typeof value.leaseId !== 'string' || !UUID.test(value.leaseId)
    || !value.request || typeof value.request !== 'object' || Array.isArray(value.request) || 'commandId' in value.request)
    throw new InvalidInputError('Request payload fields or sender fence are invalid');
  return { fence: { generation: value.generation as number, leaseId: value.leaseId.toLowerCase() },
    request: normalizeCoWorkRequest({ ...(value.request as Record<string, unknown>), commandId }) };
}

function github(refs: readonly CoWorkSourceRef[]): boolean { return refs.some((ref) => ref.type === 'github_pr'); }

/**
 * Pure admission rules. The sender must hold a live claim on its own unit, in this exact runtime session.
 * The recipient unit shares the sender's canonical lineage, so no unrelated budget can be opened or borrowed.
 * Selecting a recipient grants it nothing: no claim, grant or execution authority.
 */
export function requireCoWorkAdmission(context: CoWorkContext, facts: CoWorkAdmissionFacts, input: CoWorkAdmissionInput,
  separation: CoWorkReviewSeparation): void {
  const { sender, recipient, recipientConnection, now } = facts;
  if (sender.assignmentConnectionId !== context.connectionId || sender.projectId !== context.projectId)
    throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
  if (!Number.isFinite(now.getTime())) throw new Error('Missing database wall time');
  if (sender.state !== 'claimed' || sender.generation !== input.fence.generation || !sender.lease
    || sender.lease.id !== input.fence.leaseId || sender.lease.runtimeSessionId !== context.runtimeSessionId
    || !(sender.lease.expiresAt.getTime() > now.getTime()))
    throw new ConflictError('The sender claim is no longer live; recover before requesting', 'COWORK_CLAIM_LOST');
  if (input.request.recipientConnectionId === context.connectionId)
    throw new ConflictError('A connection cannot address a request to itself', 'COWORK_SELF_REQUEST');
  if (!recipientConnection || recipientConnection.id !== input.request.recipientConnectionId || !recipient
    || recipient.id !== input.request.unitId || recipient.projectId !== context.projectId
    || recipient.lineageTaskId !== sender.lineageTaskId || recipient.runId !== sender.runId)
    throw new NotFoundError('Request recipient', 'COWORK_REQUEST_UNAVAILABLE');
  const { target, sourceRefs, criteriaRefs } = input.request;
  if (github([target, ...sourceRefs, ...criteriaRefs]))
    throw new NotFoundError('Request source', 'COWORK_SOURCE_UNAVAILABLE');
  if (separation !== 'distinct_connection' && separation !== 'distinct_owner') throw new Error('Invalid review separation policy');
  if (input.request.kind === 'review' && separation === 'distinct_owner' && recipientConnection.ownerUserId === context.ownerId)
    throw new ConflictError('Project policy requires a reviewer of another owner', 'COWORK_REVIEW_SEPARATION');
}
