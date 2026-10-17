import type { CoWorkRequestState, CoWorkReviewRule } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError } from '../access/errors.js';

/**
 * The rules of a task's request cards (#153 AC-4, #400 AC-4). A card is read from the durable request record; the one
 * thing a person can do to it is cancel it while it is open. Cancelling is not a claim, a response or an acknowledgement:
 * it only closes the request, so the recipient's next claim, defer or resolution is told `COWORK_REQUEST_CLOSED`.
 */
export const COWORK_OPEN_REQUEST_STATES: readonly CoWorkRequestState[] = ['queued', 'deferred', 'claimed'];

export interface CoWorkCancelActor {
  userId: string;
  /** May write in the project now (a viewer never cancels). */
  writer: boolean;
  /** Is a project manager now. */
  manager: boolean;
}
export interface CoWorkCancelFacts {
  senderOwnerId: string;
  recipientOwnerId: string;
  /** The effective state: a request past its expiry reads `expired`. */
  state: CoWorkRequestState;
  version: number;
}

/** A project manager, or the owner of the sender's or the recipient's agent, who can write in the project. */
export function mayCancelCoWorkRequest(actor: CoWorkCancelActor, request: Pick<CoWorkCancelFacts, 'senderOwnerId' | 'recipientOwnerId'>): boolean {
  return actor.writer && (actor.manager || request.senderOwnerId === actor.userId || request.recipientOwnerId === actor.userId);
}

/** What the card offers now: only an open request can be cancelled. */
export function canCancelCoWorkRequest(actor: CoWorkCancelActor, request: CoWorkCancelFacts): boolean {
  return mayCancelCoWorkRequest(actor, request) && COWORK_OPEN_REQUEST_STATES.includes(request.state);
}

export function normalizeCoWorkCancel(value: unknown): { expectedVersion: number } {
  const body = value as { expectedVersion?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'expectedVersion')
    || !Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1)
    throw new InvalidInputError('The request version you last read is required', 'INVALID_COMMAND');
  return { expectedVersion: Number(body.expectedVersion) };
}

/**
 * Authorization first, so a person who may not cancel learns nothing about the request's state. A request this person
 * (or anyone) already cancelled is a repeated command: nothing changes and it succeeds.
 */
export function requireCoWorkCancel(actor: CoWorkCancelActor, request: CoWorkCancelFacts, expectedVersion: number): 'cancel' | 'already_cancelled' {
  if (!mayCancelCoWorkRequest(actor, request))
    throw new ForbiddenError('Only a project manager or the owner of the sender or the recipient can cancel a request', 'COWORK_CANCEL_NOT_ALLOWED');
  if (request.state === 'cancelled') return 'already_cancelled';
  if (request.state === 'expired') throw new ConflictError('This request expired', 'COWORK_REQUEST_EXPIRED');
  if (!COWORK_OPEN_REQUEST_STATES.includes(request.state)) throw new ConflictError('This request is closed', 'COWORK_REQUEST_CLOSED');
  if (request.version !== expectedVersion) throw new ConflictError('The request changed; read it again', 'COWORK_VERSION_CONFLICT');
  return 'cancel';
}

/** A project's review rule: only a manager sets it, and only one of the two known values. */
export function normalizeCoWorkReviewRule(value: unknown): CoWorkReviewRule {
  const body = value as { reviewSeparation?: unknown } | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'reviewSeparation')
    || (body.reviewSeparation !== 'distinct_connection' && body.reviewSeparation !== 'distinct_owner'))
    throw new InvalidInputError('reviewSeparation must be distinct_connection or distinct_owner', 'INVALID_COMMAND');
  return body.reviewSeparation;
}
