import type { AgentExecutionCommand, AgentJsonValue, AgentPeerRequestClass, AgentPostcondition } from '@flux/contracts';
import { coworkUnitCreationRows } from '@flux/db';
import { agentOutcomeFingerprint, ConflictError, coWorkRootRunId, InvalidInputError, normalizeAgentExecution,
  normalizeCoWorkUnitCreate, requireCoWorkUnitCreation, validateCoWorkUnitPolicy, type CoWorkContext,
  type CoWorkUnitPolicy, type Transaction } from '@flux/core';
import { agentExecutionInTransaction } from '../agent-connection/execution.js';
import type { FluxMcpClaims } from '../agent-connection/context.js';
import { coWorkTaskGraphLocks } from './graph.js';

export type { CoWorkUnitPolicy } from '@flux/core';
/** Content-free result of a unit creation; the unit is control metadata bound to its native task. */
export interface CoWorkUnitCreation {
  status: 'created' | 'existing';
  unitId: string;
  taskId: string;
  lineageTaskId: string;
  runId: string;
  role: AgentPeerRequestClass;
  assignmentConnectionId: string;
  version: number;
  state: 'pending' | 'claimed' | 'paused' | 'completed' | 'stopped';
}
type UnitPostcondition = Extract<AgentPostcondition, { kind: 'cowork.unit_state' }>;
const FIELDS = ['status', 'unitId', 'taskId', 'lineageTaskId', 'runId', 'role', 'assignmentConnectionId', 'version', 'state'];
function wire(value: CoWorkUnitCreation): AgentJsonValue {
  return Object.fromEntries(FIELDS.map((key) => [key, value[key as keyof CoWorkUnitCreation]])) as AgentJsonValue;
}
function restored(value: AgentJsonValue): CoWorkUnitCreation {
  const v = value as unknown as CoWorkUnitCreation;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !['created', 'existing'].includes(v.status) || typeof v.unitId !== 'string'
    || agentOutcomeFingerprint({ value: wire(v), postconditions: [] }) !== agentOutcomeFingerprint({ value, postconditions: [] }))
    throw new Error('Invalid persisted unit creation');
  return v;
}

/**
 * Internal caller-owned composition of #152's `cowork.unit.create`. The owner's standing grant to this connection
 * (class = the created unit's role, optional exact task) is the authority; nothing here grants the creator or the
 * assignee a claim. No HTTP cache, new transaction, model wake or event flush. Errors must escape the caller's
 * transaction so a refusal leaves no unit, slot row, grant use or receipt. Not a public tool.
 */
export async function coWorkUnitCreateInTransaction(tx: Transaction, claims: FluxMcpClaims,
  raw: AgentExecutionCommand, policy: CoWorkUnitPolicy): Promise<CoWorkUnitCreation> {
  const command = normalizeAgentExecution(raw);
  if (command.operation !== 'cowork.unit.create' || !command.objectId)
    throw new InvalidInputError('An exact co-work unit creation operation and task are required');
  const taskId = command.objectId;
  const input = normalizeCoWorkUnitCreate(command.payload);
  policy = Object.freeze({ maximumRunUnits: policy?.maximumRunUnits, reviewSeparation: policy?.reviewSeparation });
  validateCoWorkUnitPolicy(policy);
  const rows = coworkUnitCreationRows(tx);
  let locked = false;
  const execution = agentExecutionInTransaction(tx, claims, {
    // Canonical post-state under the retained locks: the unit's task, lineage, run, role, assignment, version and state.
    async coordinationUnitPostcondition(_tx, context, _command, condition: UnitPostcondition) {
      if (_tx !== tx || !locked) return false;
      const unit = await rows.unit(context.workspaceId, condition.projectId, condition.unitId);
      return !!unit && unit.taskId === condition.taskId && unit.lineageTaskId === condition.lineageTaskId
        && unit.runId === condition.runId && unit.role === condition.role
        && unit.assignmentConnectionId === condition.assignmentConnectionId
        && unit.version === condition.version && unit.state === condition.state;
    },
  });
  // Current identity/grant/task-target/one-command ledger preparation precedes the assignee row, slots, graphs and tasks.
  const prepared = await execution.prepare(command);
  const runtime = prepared.context;
  const context: CoWorkContext = { workspaceId: runtime.workspaceId, projectId: command.projectId,
    connectionId: runtime.connectionId, agentId: runtime.agentId, ownerId: runtime.ownerUserId, runtimeSessionId: runtime.id };
  const rootRunId = coWorkRootRunId(context.connectionId, taskId, input.unitKey);
  const facts = await rows.lock({ workspaceId: context.workspaceId, projectId: context.projectId,
    creatorConnectionId: context.connectionId, assigneeConnectionId: input.assignmentConnectionId, taskId,
    parentUnitId: input.parent?.unitId ?? null, rootRunId, unitKey: input.unitKey },
  (units) => coWorkTaskGraphLocks(tx, context.workspaceId, units));
  locked = true;

  if (prepared.replay) {
    // Observation only: no fence, insert or debit. `complete` rechecks current authority and the post-state hook
    // rejects a unit that has changed since (claimed, renewed, released or stopped) as stale.
    const original = restored(prepared.replay.value);
    await execution.complete(prepared, { value: prepared.replay.value, postconditions: prepared.replay.postconditions });
    return original;
  }

  const role = command.peerRequestClass;
  const decision = requireCoWorkUnitCreation(context, facts, input, { taskId, role, rootRunId }, policy);
  const unit = decision.kind === 'existing' ? decision.unit : await rows.insert(context, { taskId,
    lineageTaskId: decision.lineageTaskId, runId: decision.runId, unitKey: input.unitKey, role,
    assignmentConnectionId: input.assignmentConnectionId });
  if (!unit) throw new ConflictError('This unit key was used for another unit', 'COWORK_UNIT_CONFLICT');
  const creation: CoWorkUnitCreation = { status: decision.kind === 'existing' ? 'existing' : 'created', unitId: unit.id,
    taskId: unit.taskId, lineageTaskId: unit.lineageTaskId, runId: unit.runId, role: unit.role,
    assignmentConnectionId: unit.assignmentConnectionId, version: unit.version, state: unit.state };
  const postcondition: UnitPostcondition = { kind: 'cowork.unit_state', workspaceId: context.workspaceId,
    projectId: context.projectId, unitId: unit.id, taskId: unit.taskId, lineageTaskId: unit.lineageTaskId, runId: unit.runId,
    role: unit.role, assignmentConnectionId: unit.assignmentConnectionId, version: unit.version, state: unit.state };
  await execution.complete(prepared, { value: wire(creation), postconditions: [postcondition] });
  return creation;
}
