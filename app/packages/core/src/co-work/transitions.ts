import type { CoWorkSourceRef } from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError } from '../access/errors.js';
import type { CoWorkReviewSeparation } from './admission.js';
import type { CoWorkContext, CoWorkLease, CoWorkRole } from './claims.js';
import { stoppedError } from './claims.js';
import { normalizeCoWorkSource } from './requests.js';

/** The holder's live claim on its own unit at the exact version it last read. */
export interface CoWorkHolderFence { expectedVersion: number; generation: number; leaseId: string }
/**
 * Exactly `{ expectedVersion, generation, leaseId, outcome }` to complete, or
 * `{ expectedVersion, generation, leaseId, assignmentConnectionId }` to transfer.
 */
export type CoWorkUnitTransitionInput =
  | (CoWorkHolderFence & { operation: 'complete'; outcome: CoWorkSourceRef })
  | (CoWorkHolderFence & { operation: 'transfer'; assignmentConnectionId: string });
/** Server-owned policy; never read from a payload, peer message or client metadata. */
export interface CoWorkUnitTransitionPolicy { reviewSeparation: CoWorkReviewSeparation }
export interface CoWorkTransitionUnit {
  id: string;
  projectId: string;
  taskId: string;
  lineageTaskId: string;
  runId: string;
  role: CoWorkRole;
  assignmentConnectionId: string;
  state: 'pending' | 'claimed' | 'paused' | 'completed' | 'stopped';
  version: number;
  generation: number;
  lease: CoWorkLease | null;
}
/** Facts read under the complete retained connection/slot/task/unit locks; `now` is fresh DB wall time after them. */
export interface CoWorkUnitTransitionFacts {
  /** The unit with this ID in this project, whatever its assignment; null when there is none. */
  unit: CoWorkTransitionUnit | null;
  /** Requests addressed to the unit that are queued, deferred or claimed and unexpired. */
  openRequests: number;
  /** Transfer only: the assignee when it is a live connection of this workspace with this project selected and the execute scope. */
  assignee: { id: string; ownerUserId: string } | null;
  /** Every unit of the unit's run, with its assignee's owner (null when that connection no longer exists). */
  runUnits: readonly { id: string; role: CoWorkRole; assignmentConnectionId: string; ownerUserId: string | null }[];
  now: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never { throw new InvalidInputError('Unit transition fields or fences are invalid'); }
function exactly(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) invalid();
  return value as Record<string, unknown>;
}
function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value.toLowerCase();
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) invalid();
  return value as number;
}
function fence(value: Record<string, unknown>): CoWorkHolderFence {
  return { expectedVersion: positive(value.expectedVersion), generation: positive(value.generation), leaseId: uuid(value.leaseId) };
}

/**
 * Strict payloads: copied prompts, lineage/run/state fields, budgets or authority fields are refused before any write.
 * An outcome is one exact native reference; a GitHub reference stays unavailable until #74's verified recipient adapter.
 */
export function normalizeCoWorkUnitTransition(operation: 'complete' | 'transfer', payload: unknown): CoWorkUnitTransitionInput {
  if (operation === 'complete') {
    const value = exactly(payload, ['expectedVersion', 'generation', 'leaseId', 'outcome']);
    const outcome = ((): CoWorkSourceRef => {
      try { return normalizeCoWorkSource(value.outcome); } catch { return invalid(); }
    })();
    if (outcome.type === 'github_pr') throw new NotFoundError('Unit outcome', 'COWORK_OUTCOME_UNAVAILABLE');
    return { operation, ...fence(value), outcome };
  }
  const value = exactly(payload, ['expectedVersion', 'generation', 'leaseId', 'assignmentConnectionId']);
  return { operation, ...fence(value), assignmentConnectionId: uuid(value.assignmentConnectionId) };
}
export function validateCoWorkUnitTransitionPolicy(policy: CoWorkUnitTransitionPolicy): void {
  if (!policy || (policy.reviewSeparation !== 'distinct_connection' && policy.reviewSeparation !== 'distinct_owner'))
    throw new Error('Current co-work unit transition policy is required');
}

function separated(unit: CoWorkTransitionUnit, assignee: { id: string; ownerUserId: string }, facts: CoWorkUnitTransitionFacts,
  separation: CoWorkReviewSeparation): boolean {
  const opposite = unit.role === 'review' ? 'execute' : unit.role === 'execute' ? 'review' : null;
  if (!opposite) return true;
  return facts.runUnits.filter((other) => other.id !== unit.id && other.role === opposite).every((other) =>
    other.assignmentConnectionId !== assignee.id
    // A deleted connection's owner is unknown: fail closed under the stricter policy.
    && (separation !== 'distinct_owner' || (other.ownerUserId !== null && other.ownerUserId !== assignee.ownerUserId)));
}

/**
 * Pure rules for the current holder's completion or transfer. Only the connection the unit is assigned to, holding its
 * claim live in this runtime session with exactly this generation and lease at fresh database time, may finish or hand
 * it over; nothing addressed to the unit may be left open. A transfer gives the assignee a pending unit and no authority.
 */
export function requireCoWorkUnitTransition(context: CoWorkContext, facts: CoWorkUnitTransitionFacts, input: CoWorkUnitTransitionInput,
  policy: CoWorkUnitTransitionPolicy): CoWorkTransitionUnit {
  const { unit, now } = facts;
  if (!unit || unit.projectId !== context.projectId || unit.assignmentConnectionId !== context.connectionId)
    throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
  if (!Number.isFinite(now.getTime())) throw new Error('Missing database wall time');
  if (unit.version !== input.expectedVersion)
    throw new ConflictError('The unit changed; recover current state', 'COWORK_VERSION_CONFLICT');
  if (unit.state === 'stopped') throw stoppedError();
  if (unit.state !== 'claimed' || unit.generation !== input.generation || !unit.lease || unit.lease.id !== input.leaseId
    || unit.lease.runtimeSessionId !== context.runtimeSessionId || !(unit.lease.expiresAt.getTime() > now.getTime()))
    throw new ConflictError('The claim is no longer live; recover before continuing', 'COWORK_CLAIM_LOST');
  if (!Number.isSafeInteger(facts.openRequests) || facts.openRequests < 0) throw new Error('Invalid open request count');
  if (facts.openRequests > 0)
    throw new ConflictError('Resolve or decline the requests addressed to this unit first', 'COWORK_UNIT_REQUESTS_OPEN');
  if (input.operation === 'transfer') {
    if (input.assignmentConnectionId === context.connectionId)
      throw new ConflictError('A unit is transferred to another connection', 'COWORK_ASSIGNMENT_REFUSED');
    if (!facts.assignee || facts.assignee.id !== input.assignmentConnectionId)
      throw new NotFoundError('Unit assignee', 'COWORK_ASSIGNEE_UNAVAILABLE');
    if (!separated(unit, facts.assignee, facts, policy.reviewSeparation))
      throw new ConflictError('An author cannot be its own reviewer in this run', 'COWORK_REVIEW_SEPARATION');
  }
  return unit;
}
