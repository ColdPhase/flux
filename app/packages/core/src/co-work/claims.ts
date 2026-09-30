import { randomUUID } from 'node:crypto';
import { ConflictError, InvalidInputError, NotFoundError } from '../access/errors.js';

/** Trusted #152 adapter context, never populated from a peer message or tool payload. */
export interface CoWorkContext {
  workspaceId: string;
  projectId: string;
  connectionId: string;
  agentId: string;
  ownerId: string;
  runtimeSessionId: string;
}

export type CoWorkRole = 'execute' | 'review' | 'plan';
export type UnitState = 'pending' | 'claimed' | 'paused' | 'completed' | 'stopped';
export interface CoWorkLease {
  id: string;
  runtimeSessionId: string;
  expiresAt: Date;
}
export interface CoWorkUnit {
  id: string;
  taskId: string;
  workspaceId: string;
  projectId: string;
  assignmentConnectionId: string;
  role: CoWorkRole;
  state: UnitState;
  generation: number;
  version: number;
  lease: CoWorkLease | null;
  checkpointId: string | null;
}
export interface ClaimFence {
  unitId: string;
  expectedVersion: number;
  generation: number;
  leaseId: string;
}
export interface ClaimCommand {
  commandId: string;
  unitId: string;
  expectedVersion: number;
}
export interface RenewCommand extends ClaimFence { commandId: string }
export interface ReleaseCommand extends RenewCommand {
  /** Canonical persisted checkpoint; no copied conversation or model transcript. */
  checkpointId: string;
}
export type ClaimOperation = 'claim' | 'renew' | 'release';
export type ClaimInput = ClaimCommand | RenewCommand | ReleaseCommand;
export interface ClaimOutcome {
  unitId: string;
  generation: number;
  version: number;
  state: UnitState;
  lease: CoWorkLease | null;
  checkpointId: string | null;
}

/**
 * Scope is constructed under current authorization and locks by the #153 adapter.
 * `now` is fresh DB wall time AFTER lock acquisition. activeConnectionUnits counts
 * every role/session in every project for this connection, excluding this unit.
 */
export interface LockedClaimScope {
  unit: CoWorkUnit;
  now: Date;
  activeConnectionUnits: number;
  maximumConnectionUnits: number;
  leaseSeconds: number;
  /** Replayed receipt is reauthorized; it never means its historical lease is live. */
  replay: ClaimOutcome | null;
  /** Checkpoint must belong to this exact unit/generation/session and be readable now. */
  requireCheckpoint(id: string, fence: ClaimFence): Promise<void>;
  /** Conditional SQL write rechecks current fencing/expiry with DB wall time;
   * a stale scope snapshot must not publish after waiting on another lock. */
  save(unit: CoWorkUnit): Promise<void>;
  saveReceipt(outcome: ClaimOutcome): Promise<void>;
}

/**
 * One real transaction: current #152 authorization -> durable command identity
 * (including operation, payload and original session) -> sorted connection slots
 * -> complete sorted native task set -> unit/request rows. Reject changed command
 * fingerprints; never wrap this in the existing 24-hour HTTP idempotency cache.
 * Keep request claim/release metadata atomic with save; write stream events last.
 * Checks the actual unit role against its execution/review/plan grant.
 * Throws on expired/revoked/incompatible authority, before returning any replay.
 */
export interface CoWorkClaimUnitOfWork {
  run<T>(context: CoWorkContext, operation: ClaimOperation, input: ClaimInput,
    effect: (scope: LockedClaimScope) => Promise<T>): Promise<T>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function identifier(value: string): boolean { return typeof value === 'string' && UUID.test(value); }
function validate(input: ClaimInput): void {
  if (!input || !identifier(input.unitId) || !identifier(input.commandId)
    || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1)
    throw new InvalidInputError('A unit, durable command ID and positive expected version are required');
}
function normalized<T extends ClaimInput>(input: T): T {
  validate(input);
  return { ...input, commandId: input.commandId.toLowerCase(), unitId: input.unitId.toLowerCase(),
    ...('leaseId' in input && typeof input.leaseId === 'string' ? { leaseId: input.leaseId.toLowerCase() } : {}),
    ...('checkpointId' in input && typeof input.checkpointId === 'string' ? { checkpointId: input.checkpointId.toLowerCase() } : {}) };
}
function scopeUnit(context: CoWorkContext, scope: LockedClaimScope, requestedUnitId: string): CoWorkUnit {
  const unit = scope.unit;
  if (unit.id !== requestedUnitId || unit.workspaceId !== context.workspaceId || unit.projectId !== context.projectId
    || unit.assignmentConnectionId !== context.connectionId)
    throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
  if (!Number.isFinite(scope.now.getTime())) throw new Error('Missing database wall time');
  if ((unit.state === 'claimed') !== (unit.lease !== null)
    || (unit.lease && !Number.isFinite(unit.lease.expiresAt.getTime())))
    throw new Error('Invalid persisted claim state');
  if (scope.replay && scope.replay.unitId !== requestedUnitId)
    throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
  return unit;
}
function version(unit: CoWorkUnit, expected: number): void {
  if (unit.version !== expected) throw new ConflictError('The unit changed; recover current state', 'COWORK_VERSION_CONFLICT');
}
function fence(context: CoWorkContext, scope: LockedClaimScope, input: RenewCommand): CoWorkUnit {
  const unit = scopeUnit(context, scope, input.unitId);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1 || !identifier(input.leaseId))
    throw new InvalidInputError('A claim generation and lease ID are required');
  version(unit, input.expectedVersion);
  if (unit.state !== 'claimed' || unit.generation !== input.generation
    || unit.lease?.id !== input.leaseId || unit.lease.runtimeSessionId !== context.runtimeSessionId
    || !Number.isFinite(unit.lease.expiresAt.getTime())
    || unit.lease.expiresAt.getTime() <= scope.now.getTime())
    throw new ConflictError('The claim is no longer live; recover before continuing', 'COWORK_CLAIM_LOST');
  return unit;
}
function deadline(scope: LockedClaimScope): Date {
  if (!Number.isSafeInteger(scope.leaseSeconds) || scope.leaseSeconds < 1 || scope.leaseSeconds > 300)
    throw new Error('Invalid authorized lease duration');
  return new Date(scope.now.getTime() + scope.leaseSeconds * 1000);
}
function outcome(unit: CoWorkUnit): ClaimOutcome {
  return { unitId: unit.id, generation: unit.generation, version: unit.version,
    state: unit.state, lease: unit.lease, checkpointId: unit.checkpointId };
}
async function commit(scope: LockedClaimScope, unit: CoWorkUnit): Promise<ClaimOutcome> {
  await scope.save(unit);
  const result = outcome(unit);
  await scope.saveReceipt(result);
  return result;
}

/** Pure core commands. SQL/current grants and real client activation remain adapter responsibilities. */
export function coWorkClaimUseCases(uow: CoWorkClaimUnitOfWork) {
  return {
    async claim(context: CoWorkContext, input: ClaimCommand): Promise<ClaimOutcome> {
      input = normalized(input);
      return uow.run(context, 'claim', input, async (scope) => {
        const unit = scopeUnit(context, scope, input.unitId);
        if (scope.replay) return scope.replay;
        version(unit, input.expectedVersion);
        if (unit.state === 'completed' || unit.state === 'stopped')
          throw new ConflictError('This unit is no longer claimable', 'COWORK_UNIT_CLOSED');
        if (unit.state === 'claimed' && unit.lease && unit.lease.expiresAt.getTime() > scope.now.getTime())
          throw new ConflictError('This unit already has a live claim', 'COWORK_UNIT_BUSY');
        if (!Number.isSafeInteger(scope.maximumConnectionUnits) || scope.maximumConnectionUnits < 1
          || !Number.isSafeInteger(scope.activeConnectionUnits) || scope.activeConnectionUnits < 0)
          throw new Error('Invalid current connection capacity');
        if (scope.activeConnectionUnits >= scope.maximumConnectionUnits)
          throw new ConflictError('Finish or checkpoint current work before claiming another unit', 'COWORK_CONNECTION_BUSY');
        return commit(scope, { ...unit, state: 'claimed', generation: unit.generation + 1,
          version: unit.version + 1, lease: { id: randomUUID(), runtimeSessionId: context.runtimeSessionId,
            expiresAt: deadline(scope) } });
      });
    },
    async renew(context: CoWorkContext, input: RenewCommand): Promise<ClaimOutcome> {
      input = normalized(input);
      return uow.run(context, 'renew', input, async (scope) => {
        scopeUnit(context, scope, input.unitId);
        if (scope.replay) return scope.replay;
        const unit = fence(context, scope, input);
        return commit(scope, { ...unit, version: unit.version + 1,
          lease: { ...unit.lease!, expiresAt: deadline(scope) } });
      });
    },
    async release(context: CoWorkContext, input: ReleaseCommand): Promise<ClaimOutcome> {
      input = normalized(input);
      if (!identifier(input.checkpointId)) throw new InvalidInputError('A persisted checkpoint is required');
      return uow.run(context, 'release', input, async (scope) => {
        scopeUnit(context, scope, input.unitId);
        if (scope.replay) return scope.replay;
        const unit = fence(context, scope, input);
        await scope.requireCheckpoint(input.checkpointId, input);
        return commit(scope, { ...unit, state: 'paused', lease: null, generation: unit.generation + 1,
          version: unit.version + 1, checkpointId: input.checkpointId });
      });
    },
  };
}
