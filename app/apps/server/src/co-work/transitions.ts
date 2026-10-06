import type { AgentExecutionCommand, AgentJsonValue, AgentPeerRequestClass, AgentPostcondition, CoWorkSourceRef } from '@flux/contracts';
import { coworkAdmissionRows, coworkUnitTransitionRows } from '@flux/db';
import { agentOutcomeFingerprint, ConflictError, InvalidInputError, normalizeAgentExecution, normalizeCoWorkUnitTransition,
  NotFoundError, requireCoWorkUnitTransition, validateCoWorkUnitTransitionPolicy, type CoWorkContext,
  type CoWorkUnitTransitionPolicy, type Transaction } from '@flux/core';
import { agentExecutionInTransaction } from '../agent-connection/execution.js';
import type { FluxMcpClaims } from '../agent-connection/context.js';
import { coWorkTaskGraphLocks } from './graph.js';

export type { CoWorkUnitTransitionPolicy } from '@flux/core';
/** Content-free result of a completion or transfer; the outcome itself lives in its native record. */
export interface CoWorkUnitTransition {
  unitId: string;
  taskId: string;
  role: AgentPeerRequestClass;
  /** After a transfer, the new assignee; after a completion, the holder. */
  assignmentConnectionId: string;
  version: number;
  state: 'pending' | 'completed';
  outcomeRef: CoWorkSourceRef | null;
}
type UnitPostcondition = Extract<AgentPostcondition, { kind: 'cowork.unit_state' }>;
const OPERATIONS = { 'cowork.unit.complete': 'complete', 'cowork.unit.transfer': 'transfer' } as const;
const FIELDS = ['unitId', 'taskId', 'role', 'assignmentConnectionId', 'version', 'state', 'outcomeRef'];
function wire(value: CoWorkUnitTransition): AgentJsonValue {
  return Object.fromEntries(FIELDS.map((key) => [key, value[key as keyof CoWorkUnitTransition]])) as AgentJsonValue;
}
function restored(value: AgentJsonValue): CoWorkUnitTransition {
  const v = value as unknown as CoWorkUnitTransition;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !['pending', 'completed'].includes(v.state) || typeof v.unitId !== 'string'
    || agentOutcomeFingerprint({ value: wire(v), postconditions: [] }) !== agentOutcomeFingerprint({ value, postconditions: [] }))
    throw new Error('Invalid persisted unit transition');
  return v;
}
function outcomeUnavailable() { return new NotFoundError('Unit outcome', 'COWORK_OUTCOME_UNAVAILABLE'); }

/**
 * Internal caller-owned composition of the holder's `cowork.unit.complete` / `cowork.unit.transfer`. The owner's
 * standing grant to this connection (class = the unit's actual role, optional exact unit) is the authority; only the
 * unit's current holder, under its live claim, may finish or hand it over. A transfer grants the assignee nothing: it
 * still needs its own `cowork.claim` grant. No HTTP cache, new transaction, model wake or event flush. Errors must
 * escape the caller's transaction so a refusal leaves no unit change, slot row, grant use or receipt. Not a public tool.
 */
export async function coWorkUnitTransitionInTransaction(tx: Transaction, claims: FluxMcpClaims,
  raw: AgentExecutionCommand, policy: CoWorkUnitTransitionPolicy): Promise<CoWorkUnitTransition> {
  const command = normalizeAgentExecution(raw);
  const operation = OPERATIONS[command.operation as keyof typeof OPERATIONS];
  if (!operation || !command.objectId) throw new InvalidInputError('An exact co-work unit transition and unit are required');
  const unitId = command.objectId;
  const input = normalizeCoWorkUnitTransition(operation, command.payload);
  policy = Object.freeze({ reviewSeparation: policy?.reviewSeparation });
  validateCoWorkUnitTransitionPolicy(policy);
  const rows = coworkUnitTransitionRows(tx);
  let locked = false;
  const execution = agentExecutionInTransaction(tx, claims, {
    // Canonical post-state under the retained locks: the unit's task, lineage, run, role, assignment, version and state.
    // The unit is read by its ID, so a former holder's transfer receipt stays observable until the unit changes again.
    async coordinationUnitPostcondition(_tx, context, _command, condition: UnitPostcondition) {
      if (_tx !== tx || !locked || condition.unitId !== unitId) return false;
      const unit = await rows.unit(context.workspaceId, condition.projectId, condition.unitId);
      return !!unit && unit.taskId === condition.taskId && unit.lineageTaskId === condition.lineageTaskId
        && unit.runId === condition.runId && unit.role === condition.role
        && unit.assignmentConnectionId === condition.assignmentConnectionId
        && unit.version === condition.version && unit.state === condition.state;
    },
  });
  // Current identity/grant/one-command ledger preparation precedes the assignee row, slots, graphs, tasks and the unit.
  const prepared = await execution.prepare(command);
  const runtime = prepared.context;
  const context: CoWorkContext = { workspaceId: runtime.workspaceId, projectId: command.projectId,
    connectionId: runtime.connectionId, agentId: runtime.agentId, ownerId: runtime.ownerUserId, runtimeSessionId: runtime.id };
  const scope = { workspaceId: context.workspaceId, projectId: context.projectId, holderConnectionId: context.connectionId, unitId,
    assigneeConnectionId: input.operation === 'transfer' ? input.assignmentConnectionId : null };
  const facts = await rows.lock(scope, (units) => coWorkTaskGraphLocks(tx, context.workspaceId, units));
  locked = true;
  // The role never changes; a grant of another class names no unit here.
  if (!facts.unit || facts.unit.role !== command.peerRequestClass) throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
  const readable = (ref: CoWorkSourceRef) => coworkAdmissionRows(tx).referencesReadable(context.workspaceId, context.projectId, [ref]);

  if (prepared.replay) {
    // Observation only: no fence, update or debit. `complete` rechecks current authority and the post-state hook
    // rejects a unit that has changed since (for a transfer, the assignee's claim) as stale.
    const original = restored(prepared.replay.value);
    if (original.unitId !== unitId) throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
    if (original.outcomeRef && !await readable(original.outcomeRef)) throw outcomeUnavailable();
    await execution.complete(prepared, { value: prepared.replay.value, postconditions: prepared.replay.postconditions });
    return original;
  }

  requireCoWorkUnitTransition(context, facts, input, policy);
  const fence = { expectedVersion: input.expectedVersion, generation: input.generation, leaseId: input.leaseId, runtimeSessionId: runtime.id };
  if (input.operation === 'complete' && !await readable(input.outcome)) throw outcomeUnavailable();
  // #238 seam: completion and transfer are persisted unit uses. The lifecycle/use fence joins at this conditional
  // update, inside this same transaction, when it lands; it is not implemented here.
  const saved = input.operation === 'complete' ? await rows.complete(scope, fence, input.outcome)
    : await rows.transfer(scope, fence, input.assignmentConnectionId);
  if (!saved) throw new ConflictError('The claim is no longer live; recover before continuing', 'COWORK_CLAIM_LOST');
  if (saved.state !== (input.operation === 'complete' ? 'completed' : 'pending')) throw new Error('Persistence returned another transition');
  const transition: CoWorkUnitTransition = { unitId: saved.id, taskId: saved.taskId, role: saved.role,
    assignmentConnectionId: saved.assignmentConnectionId, version: saved.version, state: saved.state as CoWorkUnitTransition['state'],
    outcomeRef: saved.outcomeRef };
  const postcondition: UnitPostcondition = { kind: 'cowork.unit_state', workspaceId: context.workspaceId,
    projectId: context.projectId, unitId: saved.id, taskId: saved.taskId, lineageTaskId: saved.lineageTaskId, runId: saved.runId,
    role: saved.role, assignmentConnectionId: saved.assignmentConnectionId, version: saved.version, state: saved.state };
  await execution.complete(prepared, { value: wire(transition), postconditions: [postcondition] });
  return transition;
}
