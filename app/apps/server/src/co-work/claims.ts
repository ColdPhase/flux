import type { AgentExecutionCommand, AgentJsonValue, AuthenticatedAgentRuntime } from '@flux/contracts';
import { coworkUnitRows, type CoWorkTaskLockInput } from '@flux/db';
import { agentOutcomeFingerprint, coWorkClaimPostcondition, coWorkClaimUseCases, ConflictError, DomainError, InvalidInputError,
  normalizeAgentExecution, type ClaimInput, type ClaimOperation, type ClaimOutcome, type CoWorkContext,
  type CoWorkUnit, type CoWorkClaimUnitOfWork, type LockedClaimScope, type Transaction } from '@flux/core';
import { agentExecutionInTransaction } from '../agent-connection/execution.js';
import type { FluxMcpClaims } from '../agent-connection/context.js';

type LockedUnit = NonNullable<Awaited<ReturnType<ReturnType<typeof coworkUnitRows>['lock']>>>;
type Checkpoint = NonNullable<Awaited<ReturnType<LockedUnit['checkpoint']>>>;
/** Server-owned current policy; never supplied by MCP/clientInfo/peer request.
 * Required even for a replay. Public composition remains disabled until real
 * graph/role/checkpoint providers are implemented and independently verified.
 */
export interface CoWorkClaimPolicy {
  maximumConnectionUnits: number;
  leaseSeconds: number;
  /** Sorted project graph locks, complete dependency discovery, before any task lock. */
  prepareTaskLocks(tx: Transaction, context: AuthenticatedAgentRuntime, units: readonly CoWorkTaskLockInput[]): Promise<readonly string[]>;
  /** Read under complete retained locks; no late upstream locks. Execute/review/plan differ. */
  requireEligible(tx: Transaction, context: AuthenticatedAgentRuntime, unit: CoWorkUnit,
    action: { operation: ClaimOperation; observation: boolean }): Promise<void>;
  /** Require exact currently readable source coverage from the already prepared command.
   * Never acquire an additional material/version/graph lock after task locks. */
  requireCheckpointSources(tx: Transaction, context: AuthenticatedAgentRuntime, checkpoint: Checkpoint, command: AgentExecutionCommand): Promise<void>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function inputOf(command: AgentExecutionCommand): { operation: ClaimOperation; input: ClaimInput } {
  if (!['cowork.claim', 'cowork.renew', 'cowork.release'].includes(command.operation) || !command.objectId)
    throw new InvalidInputError('An exact co-work claim operation and target are required');
  const operation = command.operation.slice('cowork.'.length) as ClaimOperation;
  const payload = command.payload;
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') throw new InvalidInputError('A bounded claim payload is required');
  const fields = operation === 'claim' ? ['expectedVersion'] : operation === 'renew'
    ? ['expectedVersion', 'generation', 'leaseId'] : ['expectedVersion', 'generation', 'leaseId', 'checkpointId'];
  if (Object.keys(payload).length !== fields.length || Object.keys(payload).some((key) => !fields.includes(key))
    || !Number.isSafeInteger(payload.expectedVersion) || (payload.expectedVersion as number) < 1
    || operation !== 'claim' && (!Number.isSafeInteger(payload.generation) || (payload.generation as number) < 1
      || typeof payload.leaseId !== 'string' || !UUID.test(payload.leaseId))
    || operation === 'release' && (typeof payload.checkpointId !== 'string' || !UUID.test(payload.checkpointId)))
    throw new InvalidInputError('Claim payload fields or fences are invalid');
  return { operation, input: { ...payload, commandId: command.clientCommandId, unitId: command.objectId } as unknown as ClaimInput };
}
function wire(outcome: ClaimOutcome): AgentJsonValue {
  return { unitId: outcome.unitId, generation: outcome.generation, version: outcome.version, state: outcome.state,
    checkpointId: outcome.checkpointId, lease: outcome.lease ? { ...outcome.lease, expiresAt: outcome.lease.expiresAt.toISOString() } : null };
}
function restored(value: AgentJsonValue): ClaimOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid persisted claim outcome');
  const original = value as unknown as ClaimOutcome;
  const outcome = { ...original, lease: original.lease ? { ...original.lease,
    expiresAt: new Date(original.lease.expiresAt as unknown as string) } : null };
  // Stored JSON must round-trip exactly; dates are hydrated only for core fencing.
  if (agentOutcomeFingerprint({ value: wire(outcome), postconditions: [] }) !== agentOutcomeFingerprint({ value, postconditions: [] }))
    throw new Error('Invalid persisted claim outcome');
  return outcome;
}

/** Internal caller-owned composition. No HTTP cache, new transaction, model wake or event flush.
 * The outer caller must let errors escape and finish all domain/debit/receipt/outgoing
 * writes before its one genuine native final-event flush. This is not a public tool.
 */
export async function coWorkClaimInTransaction(tx: Transaction, claims: FluxMcpClaims,
  raw: AgentExecutionCommand, policy: CoWorkClaimPolicy): Promise<ClaimOutcome> {
  const command = normalizeAgentExecution(raw);
  const { operation, input } = inputOf(command);
  policy = Object.freeze({ ...policy });
  if (!Number.isSafeInteger(policy.maximumConnectionUnits) || policy.maximumConnectionUnits < 1
    || !Number.isSafeInteger(policy.leaseSeconds) || policy.leaseSeconds < 1 || policy.leaseSeconds > 300
    || typeof policy.prepareTaskLocks !== 'function' || typeof policy.requireEligible !== 'function'
    || typeof policy.requireCheckpointSources !== 'function') throw new Error('Current co-work policy providers are required');
  let locked: Awaited<ReturnType<ReturnType<typeof coworkUnitRows>['lock']>> = null;
  const readable = async (context: AuthenticatedAgentRuntime, id: string) => {
    const checkpoint = await locked!.checkpoint(id);
    if (!checkpoint)
      throw new DomainError(404, 'COWORK_CHECKPOINT_NOT_FOUND', 'Checkpoint not found');
    await policy.requireCheckpointSources(tx, context, checkpoint, command);
    return checkpoint;
  };
  const execution = agentExecutionInTransaction(tx, claims, {
    async coordinationPostcondition(_tx, context, _command, condition) {
      if (_tx !== tx || !locked) return false;
      const unit = await locked.current();
      if (!unit || Object.entries(coWorkClaimPostcondition(unit)).some(([key, value]) =>
        value !== condition[key as keyof typeof condition])) return false;
      if (unit.checkpointId) await readable(context, unit.checkpointId);
      return true;
    },
  });
  // Actual identity/grant/source/one-command ledger preparation precedes all slots/tasks/units.
  const prepared = await execution.prepare(command);
  const runtime = prepared.context;
  const context: CoWorkContext = { workspaceId: runtime.workspaceId, projectId: command.projectId,
    connectionId: runtime.connectionId, agentId: runtime.agentId, ownerId: runtime.ownerUserId, runtimeSessionId: runtime.id };
  locked = await coworkUnitRows(tx).lock({ ...context, unitId: input.unitId },
    (units) => policy.prepareTaskLocks(tx, runtime, units));
  if (!locked || locked.unit.role !== command.peerRequestClass)
    throw new DomainError(404, 'COWORK_UNIT_NOT_FOUND', 'Work unit not found');
  await policy.requireEligible(tx, runtime, locked.unit, { operation, observation: prepared.replay !== null });
  let saved = locked.unit;
  let staged: ClaimOutcome | null = null;
  const uow: CoWorkClaimUnitOfWork = { async run<T>(_context: CoWorkContext, _operation: ClaimOperation,
    _input: ClaimInput, effect: (scope: LockedClaimScope) => Promise<T>) {
    if (_context !== context || _operation !== operation || _input.commandId !== input.commandId)
      throw new Error('Claim composition context changed');
    return effect({ unit: locked!.unit, now: locked!.now, activeConnectionUnits: locked!.activeConnectionUnits,
      maximumConnectionUnits: policy.maximumConnectionUnits, leaseSeconds: policy.leaseSeconds,
      replay: prepared.replay ? restored(prepared.replay.value) : null,
      async requireCheckpoint(id, fence) {
        const checkpoint = await readable(runtime, id);
        if (checkpoint.connectionId !== runtime.connectionId || checkpoint.generation !== fence.generation || checkpoint.runtimeSessionId !== runtime.id)
          throw new ConflictError('Checkpoint does not belong to the live claim', 'COWORK_CHECKPOINT_STALE');
      },
      async requireReadableCheckpoint(id, unitId) {
        if (unitId !== input.unitId) throw new Error('Checkpoint target changed');
        await readable(runtime, id);
      },
      async save(next) {
        const result = await locked!.save(next, { operation, expectedVersion: input.expectedVersion,
          ...('generation' in input ? { generation: input.generation, leaseId: input.leaseId } : {}),
          runtimeSessionId: runtime.id, leaseSeconds: policy.leaseSeconds, maximumConnectionUnits: policy.maximumConnectionUnits });
        if (!result) throw new ConflictError('The original claim fence changed', 'COWORK_CLAIM_LOST');
        saved = result; return result;
      },
      async saveReceipt(outcome) { if (staged) throw new Error('Claim effect staged twice'); staged = outcome; },
    });
  } };
  const cases = coWorkClaimUseCases(uow);
  const outcome = operation === 'claim' ? await cases.claim(context, input)
    : operation === 'renew' ? await cases.renew(context, input as Parameters<typeof cases.renew>[1])
      : await cases.release(context, input as Parameters<typeof cases.release>[1]);
  if (!prepared.replay && !staged) throw new Error('Claim effect was not staged');
  const postconditions = prepared.replay?.postconditions ?? [coWorkClaimPostcondition(saved)];
  await execution.complete(prepared, { value: prepared.replay?.value ?? wire(outcome), postconditions });
  return outcome;
}
