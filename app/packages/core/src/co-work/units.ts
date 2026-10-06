import { createHash } from 'node:crypto';
import { ConflictError, InvalidInputError, NotFoundError } from '../access/errors.js';
import type { CoWorkReviewSeparation } from './admission.js';
import type { CoWorkContext, CoWorkLease, CoWorkRole } from './claims.js';

/** The creator's live claim on a unit of the same lineage; absent for a root unit, which opens its own run. */
export interface CoWorkUnitParentFence { unitId: string; generation: number; leaseId: string }
/** Exactly `{ unitKey, expectedTaskVersion, assignmentConnectionId, parent }`; the role is the command class. */
export interface CoWorkUnitCreateInput {
  unitKey: string;
  expectedTaskVersion: number;
  assignmentConnectionId: string;
  parent: CoWorkUnitParentFence | null;
}
/** Server-owned policy; never read from a payload, peer message or client metadata. */
export interface CoWorkUnitPolicy {
  maximumRunUnits: number;
  reviewSeparation: CoWorkReviewSeparation;
}
export interface CoWorkCreationUnit {
  id: string;
  projectId: string;
  taskId: string;
  lineageTaskId: string;
  runId: string;
  unitKey: string;
  role: CoWorkRole;
  assignmentConnectionId: string;
  state: 'pending' | 'claimed' | 'paused' | 'completed' | 'stopped';
  version: number;
  generation: number;
  lease: CoWorkLease | null;
}
/** Facts read under the complete retained connection/slot/task/parent locks; `now` is fresh DB wall time after them. */
export interface CoWorkUnitCreationFacts {
  task: { id: string; version: number; status: string } | null;
  /** The parent unit when it is the creator's own unit in this project; null otherwise or for a root. */
  parent: CoWorkCreationUnit | null;
  /** The assignee when it is a live connection of this workspace with this project selected and the execute scope. */
  assignee: { id: string; ownerUserId: string } | null;
  /** The unit already holding this exact intent (task, run, unit key), if any. */
  existing: CoWorkCreationUnit | null;
  /** Every unit of the target run, with its assignee's owner (null when that connection no longer exists). */
  runUnits: readonly { id: string; role: CoWorkRole; assignmentConnectionId: string; ownerUserId: string | null }[];
  /** Open (pending/claimed/paused) units on the task, in any run. */
  openTaskUnits: readonly { id: string; role: CoWorkRole }[];
  now: Date;
}
export type CoWorkUnitDecision =
  | { kind: 'create'; lineageTaskId: string; runId: string }
  | { kind: 'existing'; unit: CoWorkCreationUnit };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[a-zA-Z0-9_:.-]{1,200}$/;

function invalid(): never { throw new InvalidInputError('Unit creation fields or fences are invalid'); }
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
/** Strict payload: copied prompts, lineage/run IDs, states, budgets or authority fields are refused before any write. */
export function normalizeCoWorkUnitCreate(payload: unknown): CoWorkUnitCreateInput {
  const value = exactly(payload, ['unitKey', 'expectedTaskVersion', 'assignmentConnectionId', 'parent']);
  if (typeof value.unitKey !== 'string' || !KEY.test(value.unitKey)) invalid();
  const parent = value.parent === null ? null : exactly(value.parent, ['unitId', 'generation', 'leaseId']);
  return { unitKey: value.unitKey, expectedTaskVersion: positive(value.expectedTaskVersion),
    assignmentConnectionId: uuid(value.assignmentConnectionId),
    parent: parent ? { unitId: uuid(parent.unitId), generation: positive(parent.generation), leaseId: uuid(parent.leaseId) } : null };
}
export function validateCoWorkUnitPolicy(policy: CoWorkUnitPolicy): void {
  if (!policy || !Number.isSafeInteger(policy.maximumRunUnits) || policy.maximumRunUnits < 1 || policy.maximumRunUnits > 64
    || (policy.reviewSeparation !== 'distinct_connection' && policy.reviewSeparation !== 'distinct_owner'))
    throw new Error('Current co-work unit policy is required');
}

/**
 * The run a root unit opens. The same creator, task and intent key always name the same run, so a re-issued root
 * intent meets its earlier unit at the database's (task, run, unit key) uniqueness instead of opening a second run.
 * RFC 9562 version 8 layout over a namespaced SHA-256; it carries no readable identifiers.
 */
export function coWorkRootRunId(creatorConnectionId: string, taskId: string, unitKey: string): string {
  const digits = createHash('sha256').update(JSON.stringify(['flux.cowork.root-run.v1', uuid(creatorConnectionId),
    uuid(taskId), unitKey])).digest('hex').slice(0, 32).split('');
  digits[12] = '8';
  digits[16] = ((parseInt(digits[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = digits.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function separated(role: CoWorkRole, assignee: { id: string; ownerUserId: string }, facts: CoWorkUnitCreationFacts,
  separation: CoWorkReviewSeparation): boolean {
  const opposite = role === 'review' ? 'execute' : role === 'execute' ? 'review' : null;
  if (!opposite) return true;
  return facts.runUnits.filter((unit) => unit.role === opposite).every((unit) => unit.assignmentConnectionId !== assignee.id
    // A deleted connection's owner is unknown: fail closed under the stricter policy.
    && (separation !== 'distinct_owner' || (unit.ownerUserId !== null && unit.ownerUserId !== assignee.ownerUserId)));
}

/**
 * Pure creation rules. A root opens a new run for its own assignee only; a child inherits the lineage and run of
 * the creator's live-claimed parent on the same task. Creating a unit grants nobody a claim: the assignee still needs
 * its own `cowork.claim` grant. An existing intent passes the same fences and creates nothing.
 */
export function requireCoWorkUnitCreation(context: CoWorkContext, facts: CoWorkUnitCreationFacts, input: CoWorkUnitCreateInput,
  target: { taskId: string; role: CoWorkRole; rootRunId: string }, policy: CoWorkUnitPolicy): CoWorkUnitDecision {
  const { task, parent, assignee, existing, now } = facts;
  if (!Number.isFinite(now.getTime())) throw new Error('Missing database wall time');
  if (input.parent) {
    if (!parent || parent.id !== input.parent.unitId || parent.assignmentConnectionId !== context.connectionId
      || parent.projectId !== context.projectId || parent.taskId !== target.taskId)
      throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
    if (parent.state !== 'claimed' || parent.generation !== input.parent.generation || !parent.lease
      || parent.lease.id !== input.parent.leaseId || parent.lease.runtimeSessionId !== context.runtimeSessionId
      || !(parent.lease.expiresAt.getTime() > now.getTime()))
      throw new ConflictError('The parent claim is no longer live; recover before creating units', 'COWORK_CLAIM_LOST');
  }
  if (!task || task.id !== target.taskId) throw new NotFoundError('Project object', 'OBJECT_NOT_FOUND');
  if (task.version !== input.expectedTaskVersion)
    throw new ConflictError('The task changed; recover its current version', 'COWORK_VERSION_CONFLICT');
  if (task.status === 'done' || task.status === 'not_pursued')
    throw new ConflictError('The task is closed', 'COWORK_TASK_CLOSED');
  if (!input.parent && input.assignmentConnectionId !== context.connectionId)
    throw new ConflictError('Only its own assignee opens a new run', 'COWORK_ASSIGNMENT_REFUSED');
  if (!assignee || assignee.id !== input.assignmentConnectionId)
    throw new NotFoundError('Unit assignee', 'COWORK_ASSIGNEE_UNAVAILABLE');
  const lineageTaskId = parent ? parent.lineageTaskId : target.taskId;
  const runId = parent ? parent.runId : target.rootRunId;
  if (existing) {
    if (existing.taskId !== target.taskId || existing.lineageTaskId !== lineageTaskId || existing.runId !== runId
      || existing.unitKey !== input.unitKey || existing.role !== target.role || existing.assignmentConnectionId !== assignee.id)
      throw new ConflictError('This unit key was used for another unit', 'COWORK_UNIT_CONFLICT');
    return { kind: 'existing', unit: existing };
  }
  if (!input.parent && facts.openTaskUnits.some((unit) => unit.role === target.role))
    throw new ConflictError('An open unit with this role already exists on the task', 'COWORK_UNIT_TAKEN');
  if (facts.runUnits.length >= policy.maximumRunUnits)
    throw new ConflictError('The run unit budget is exhausted', 'COWORK_BUDGET_EXHAUSTED');
  if (!separated(target.role, assignee, facts, policy.reviewSeparation))
    throw new ConflictError('An author cannot be its own reviewer in this run', 'COWORK_REVIEW_SEPARATION');
  return { kind: 'create', lineageTaskId, runId };
}
