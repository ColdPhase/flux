import type { AgentExecutionCommand, AgentJsonValue, AgentPostcondition, CoWorkRequestLimits, CoWorkRequestState } from '@flux/contracts';
import { coworkAdmissionRows, coworkRequestRows, coworkResponseRows } from '@flux/db';
import { coWorkRequestFingerprint, ConflictError, InvalidInputError, normalizeAgentExecution, normalizeCoWorkAdmission,
  NotFoundError, requireCoWorkAdmission, validateCoWorkRequestLimits, type CoWorkContext, type CoWorkReviewSeparation,
  type Transaction } from '@flux/core';
import { agentExecutionInTransaction } from '../agent-connection/execution.js';
import type { FluxMcpClaims } from '../agent-connection/context.js';
import { coWorkTaskGraphLocks } from './graph.js';

/** Server-owned current policy; never supplied by MCP/clientInfo/peer request. */
export interface CoWorkRequestPolicy {
  limits: CoWorkRequestLimits;
  reviewSeparation: CoWorkReviewSeparation;
}
/** Content-free result of an admission; the request itself stays control metadata. */
export interface CoWorkRequestAdmission {
  status: 'created' | 'existing';
  requestId: string;
  deliveryIntentId: string;
  version: number;
  state: CoWorkRequestState;
  /** Earlier unclaimed requests of the same lineage, sender, recipient unit and kind that this creation replaced. */
  supersededRequestIds: string[];
}
type RequestPostcondition = Extract<AgentPostcondition, { kind: 'cowork.request_state' }>;
const REFUSED = { conflict: () => new ConflictError('This intent key was used for another request', 'COWORK_REQUEST_CONFLICT'),
  stale: () => new ConflictError('The recipient unit changed; recover current state', 'COWORK_VERSION_CONFLICT'),
  unavailable: () => new NotFoundError('Request recipient', 'COWORK_REQUEST_UNAVAILABLE'),
  budget_exhausted: () => new ConflictError('The request lineage budget is exhausted', 'COWORK_BUDGET_EXHAUSTED') };
function sourceUnavailable() { return new NotFoundError('Request source', 'COWORK_SOURCE_UNAVAILABLE'); }
function restored(value: AgentJsonValue): CoWorkRequestAdmission {
  const v = value as unknown as CoWorkRequestAdmission;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !['created', 'existing'].includes(v.status)
    || typeof v.requestId !== 'string' || typeof v.deliveryIntentId !== 'string' || !Array.isArray(v.supersededRequestIds))
    throw new Error('Invalid persisted request outcome');
  return v;
}

/**
 * Internal caller-owned composition of #152's `cowork.request`. No HTTP cache, new transaction, model
 * wake or event flush. Errors must escape the caller's transaction so a refusal leaves no request,
 * delivery intent, lineage count, grant use or receipt. Not a public tool.
 */
export async function coWorkRequestInTransaction(tx: Transaction, claims: FluxMcpClaims,
  raw: AgentExecutionCommand, policy: CoWorkRequestPolicy): Promise<CoWorkRequestAdmission> {
  const command = normalizeAgentExecution(raw);
  if (command.operation !== 'cowork.request' || !command.objectId)
    throw new InvalidInputError('An exact co-work request operation and sender unit are required');
  const senderUnitId = command.objectId;
  const input = normalizeCoWorkAdmission(command.payload, command.clientCommandId);
  policy = Object.freeze({ limits: Object.freeze({ ...policy.limits }), reviewSeparation: policy.reviewSeparation });
  validateCoWorkRequestLimits(policy.limits);
  if (policy.reviewSeparation !== 'distinct_connection' && policy.reviewSeparation !== 'distinct_owner')
    throw new Error('Current co-work request policy is required');
  const rows = coworkAdmissionRows(tx);
  let locked = false;
  const execution = agentExecutionInTransaction(tx, claims, {
    // Canonical post-state under the retained locks: request identity/version/state and the sender
    // unit's role, assignment and lineage. The request row itself does not store the sender unit.
    async coordinationRequestPostcondition(_tx, context, _command, condition: RequestPostcondition) {
      if (_tx !== tx || !locked) return false;
      const request = await rows.request(context.workspaceId, condition.projectId, condition.requestId);
      const unit = await rows.unit(context.workspaceId, condition.projectId, condition.unitId);
      return !!request && !!unit && request.senderConnectionId === condition.connectionId && request.version === condition.version
        && request.state === condition.state && unit.role === condition.role && unit.assignmentConnectionId === condition.connectionId
        && unit.lineageTaskId === request.lineageTaskId && unit.runId === request.runId;
    },
  });
  // Current identity/grant/source/one-command ledger preparation precedes all slots/graphs/tasks/units.
  const prepared = await execution.prepare(command);
  const runtime = prepared.context;
  const context: CoWorkContext = { workspaceId: runtime.workspaceId, projectId: command.projectId,
    connectionId: runtime.connectionId, agentId: runtime.agentId, ownerId: runtime.ownerUserId, runtimeSessionId: runtime.id };
  const facts = await rows.lock({ workspaceId: context.workspaceId, projectId: context.projectId, senderConnectionId: context.connectionId,
    senderUnitId, recipientConnectionId: input.request.recipientConnectionId, recipientUnitId: input.request.unitId,
    parentRequestId: input.request.parentRequestId }, (units) => coWorkTaskGraphLocks(tx, context.workspaceId, units));
  locked = true;
  if (!facts || facts.sender.role !== command.peerRequestClass) throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');

  if (prepared.replay) {
    // Observation only: no sender fence, request or debit. Current readability still applies.
    const original = restored(prepared.replay.value);
    const request = await rows.request(context.workspaceId, context.projectId, original.requestId);
    if (!request || !await rows.referencesReadable(context.workspaceId, context.projectId,
      [request.target, ...request.sourceRefs, ...request.criteriaRefs])) throw sourceUnavailable();
    await execution.complete(prepared, { value: prepared.replay.value, postconditions: prepared.replay.postconditions });
    return original;
  }

  requireCoWorkAdmission(context, facts, input, policy.reviewSeparation);
  const { target, sourceRefs, criteriaRefs } = input.request;
  if (!await rows.referencesReadable(context.workspaceId, context.projectId, [target, ...sourceRefs, ...criteriaRefs]))
    throw sourceUnavailable();
  const result = await coworkRequestRows(tx).enqueue({ workspaceId: context.workspaceId, projectId: context.projectId,
    connectionId: context.connectionId }, input.request, coWorkRequestFingerprint(input.request, context.connectionId), policy.limits);
  if (result.status !== 'created' && result.status !== 'existing') throw REFUSED[result.status]();
  if (result.request.senderConnectionId !== context.connectionId) throw new Error('Persistence returned another sender');
  // Only a newly created request supersedes; a re-issued intent replaces nothing. Claimed requests keep their history.
  const supersededRequestIds = result.status === 'created' ? await coworkResponseRows(tx).supersede(result.request.id) : [];
  const admission: CoWorkRequestAdmission = { status: result.status, requestId: result.request.id,
    deliveryIntentId: result.deliveryIntentId, version: result.request.version, state: result.request.state, supersededRequestIds };
  const postcondition: RequestPostcondition = { kind: 'cowork.request_state', workspaceId: context.workspaceId,
    projectId: context.projectId, connectionId: context.connectionId, unitId: facts.sender.id, requestId: admission.requestId,
    role: facts.sender.role, version: admission.version, state: admission.state };
  await execution.complete(prepared, { value: { ...admission, supersededRequestIds: [...supersededRequestIds] } as unknown as AgentJsonValue,
    postconditions: [postcondition] });
  return admission;
}
