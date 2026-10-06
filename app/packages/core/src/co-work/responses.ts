import type { AgentJsonValue, CoWorkRequestState, CoWorkSourceRef } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError } from '../access/errors.js';
import type { CoWorkContext, CoWorkLease, CoWorkRole } from './claims.js';
import { normalizeCoWorkSource } from './requests.js';

/** Bounded, content-free reasons; a decline never carries copied prose. */
export const COWORK_DECLINE_REASONS = ['capability', 'policy', 'scope', 'source_changed'] as const;
export type CoWorkDeclineReason = typeof COWORK_DECLINE_REASONS[number];
/** The recipient's live claim on its own unit plus the exact request it acts on. */
export interface CoWorkRequestClaimInput { generation: number; leaseId: string; requestId: string; expectedRequestVersion: number }
export type CoWorkResponseInput = CoWorkRequestClaimInput & (
  | { outcome: 'resolved'; response: { [key: string]: AgentJsonValue } }
  | { outcome: 'declined'; reason: CoWorkDeclineReason });
export interface CoWorkRecipientUnit {
  id: string;
  projectId: string;
  assignmentConnectionId: string;
  role: CoWorkRole;
  state: string;
  generation: number;
  lease: CoWorkLease | null;
}
export interface CoWorkLockedRequest {
  id: string;
  unitId: string;
  recipientConnectionId: string;
  state: CoWorkRequestState;
  version: number;
  claimedGeneration: number | null;
  /** `expires_at <= clock_timestamp()`, read after every lock wait. */
  expired: boolean;
}
/** Facts read under the complete retained slot/task/unit/request locks; `now` is fresh DB wall time after them. */
export interface CoWorkResponseFacts { unit: CoWorkRecipientUnit; request: CoWorkLockedRequest | null; now: Date }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fence(value: Record<string, unknown>): CoWorkRequestClaimInput {
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 1
    || typeof value.leaseId !== 'string' || !UUID.test(value.leaseId) || typeof value.requestId !== 'string' || !UUID.test(value.requestId)
    || !Number.isSafeInteger(value.expectedRequestVersion) || (value.expectedRequestVersion as number) < 1
    || (value.expectedRequestVersion as number) > 2147483647)
    throw new InvalidInputError('Request fence fields are invalid');
  return { generation: value.generation as number, leaseId: value.leaseId.toLowerCase(), requestId: value.requestId.toLowerCase(),
    expectedRequestVersion: value.expectedRequestVersion as number };
}
function exact(payload: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).sort().join(',') !== [...keys].sort().join(','))
    throw new InvalidInputError('Only the exact bounded request fields are allowed');
  return payload as Record<string, unknown>;
}
const FENCE = ['generation', 'leaseId', 'requestId', 'expectedRequestVersion'];
/** Exactly `{ generation, leaseId, requestId, expectedRequestVersion }`. */
export function normalizeCoWorkRequestClaim(payload: unknown): CoWorkRequestClaimInput {
  return fence(exact(payload, FENCE));
}
/** Resolve carries an opaque bounded `response` for the publication step; decline only a bounded reason. */
export function normalizeCoWorkResponse(payload: unknown): CoWorkResponseInput {
  const outcome = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>).outcome : undefined;
  if (outcome === 'resolved') {
    const value = exact(payload, [...FENCE, 'outcome', 'response']);
    if (!value.response || typeof value.response !== 'object' || Array.isArray(value.response)
      || JSON.stringify(value.response).length > 100_000) throw new InvalidInputError('A bounded response object is required');
    return { ...fence(value), outcome, response: value.response as { [key: string]: AgentJsonValue } };
  }
  if (outcome === 'declined') {
    const value = exact(payload, [...FENCE, 'outcome', 'reason']);
    if (!COWORK_DECLINE_REASONS.includes(value.reason as CoWorkDeclineReason)) throw new InvalidInputError('A bounded decline reason is required');
    return { ...fence(value), outcome, reason: value.reason as CoWorkDeclineReason };
  }
  throw new InvalidInputError('A response outcome is required');
}

/** The recipient's own unit, claimed live in this runtime session with exactly this generation and lease. */
function liveUnit(context: CoWorkContext, facts: CoWorkResponseFacts, input: CoWorkRequestClaimInput): CoWorkRecipientUnit {
  const { unit, now } = facts;
  if (unit.assignmentConnectionId !== context.connectionId || unit.projectId !== context.projectId)
    throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
  if (!Number.isFinite(now.getTime())) throw new Error('Missing database wall time');
  if (unit.state !== 'claimed' || unit.generation !== input.generation || !unit.lease || unit.lease.id !== input.leaseId
    || unit.lease.runtimeSessionId !== context.runtimeSessionId || !(unit.lease.expiresAt.getTime() > now.getTime()))
    throw new ConflictError('The unit claim is no longer live; recover before continuing', 'COWORK_CLAIM_LOST');
  return unit;
}
/** Addressed to exactly this connection and unit; anything else is the same content-free unavailable outcome. */
function addressed(context: CoWorkContext, facts: CoWorkResponseFacts, input: CoWorkRequestClaimInput): CoWorkLockedRequest {
  const request = facts.request;
  if (!request || request.id !== input.requestId || request.recipientConnectionId !== context.connectionId || request.unitId !== facts.unit.id)
    throw new NotFoundError('Request', 'COWORK_REQUEST_UNAVAILABLE');
  if (['resolved', 'declined', 'superseded', 'expired', 'cancelled'].includes(request.state))
    throw new ConflictError('This request is closed', 'COWORK_REQUEST_CLOSED');
  if (request.version !== input.expectedRequestVersion)
    throw new ConflictError('The request changed; recover current state', 'COWORK_VERSION_CONFLICT');
  if (request.expired) throw new ConflictError('This request expired', 'COWORK_REQUEST_EXPIRED');
  return request;
}

/** Queued, deferred, or claimed under an older generation (a lost claim is pending again). */
export function requireCoWorkRequestClaim(context: CoWorkContext, facts: CoWorkResponseFacts, input: CoWorkRequestClaimInput): void {
  const unit = liveUnit(context, facts, input);
  const request = addressed(context, facts, input);
  if (request.state === 'claimed' && request.claimedGeneration === unit.generation)
    throw new ConflictError('This request is already claimed under the live claim', 'COWORK_REQUEST_CLAIMED');
  if (!['queued', 'deferred', 'claimed'].includes(request.state)) throw new Error('Invalid persisted request state');
}

/** Respond only to a request claimed under the unit's live generation. */
export function requireCoWorkResponse(context: CoWorkContext, facts: CoWorkResponseFacts, input: CoWorkResponseInput): void {
  const unit = liveUnit(context, facts, input);
  const request = addressed(context, facts, input);
  if (request.state !== 'claimed') throw new ConflictError('Claim this request before responding', 'COWORK_REQUEST_NOT_CLAIMED');
  if (request.claimedGeneration !== unit.generation)
    throw new ConflictError('The request claim was lost; claim it again before responding', 'COWORK_CLAIM_LOST');
}

/** A produced response is an exact native reference: immutable result/message ID or a versioned object, never GitHub. */
export function normalizeCoWorkResponseRef(value: unknown): CoWorkSourceRef {
  let ref: CoWorkSourceRef;
  try { ref = normalizeCoWorkSource(value); } catch { throw new NotFoundError('Response', 'COWORK_RESPONSE_UNAVAILABLE'); }
  if (ref.type === 'github_pr') throw new NotFoundError('Response', 'COWORK_RESPONSE_UNAVAILABLE');
  return ref;
}
