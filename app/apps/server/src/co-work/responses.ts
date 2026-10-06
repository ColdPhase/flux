import type { AgentExecutionCommand, AgentJsonValue, AgentPostcondition, AuthenticatedAgentRuntime, CoWorkRequestState,
  CoWorkSourceRef } from '@flux/contracts';
import { coworkAdmissionRows, coworkResponseRows, coworkUnitRows } from '@flux/db';
import { agentOutcomeFingerprint, ConflictError, InvalidInputError, NotFoundError, normalizeAgentExecution,
  normalizeCoWorkRequestClaim, normalizeCoWorkResponse, normalizeCoWorkResponseRef, requireCoWorkRequestClaim,
  requireCoWorkResponse, type CoWorkContext, type CoWorkRequestClaimInput, type CoWorkResponseInput, type Transaction } from '@flux/core';
import { agentExecutionInTransaction } from '../agent-connection/execution.js';
import type { FluxMcpClaims } from '../agent-connection/context.js';
import { coWorkTaskGraphLocks } from './graph.js';

/**
 * Server-owned providers; never supplied by MCP/clientInfo/peer request. `publishResponse` produces the native
 * response INSIDE this transaction, after every coordination lock, touching only the request's (already locked)
 * task and the conversation/stream sequence, queueing event intents and never flushing. The production provider is
 * #154's actor-aware primitive; its grant is an open peer-review question. Public composition stays disabled until
 * that provider is wired and independently verified; a fixture provider is not its implementation.
 */
export interface CoWorkResponsePolicy {
  publishResponse(tx: Transaction, runtime: AuthenticatedAgentRuntime,
    request: { id: string; taskId: string; unitId: string }, response: { [key: string]: AgentJsonValue }): Promise<CoWorkSourceRef>;
}
/** Content-free transition outcome; the response itself lives in its native record. */
export interface CoWorkRequestTransition {
  requestId: string;
  version: number;
  state: CoWorkRequestState;
  responseRef: CoWorkSourceRef | null;
}
type RequestPostcondition = Extract<AgentPostcondition, { kind: 'cowork.request_state' }>;
const OPERATIONS = ['cowork.request.claim', 'cowork.request.respond'];
function changed() { return new ConflictError('The request or unit claim changed; recover current state', 'COWORK_REQUEST_CHANGED'); }
function sourceUnavailable() { return new NotFoundError('Request source', 'COWORK_SOURCE_UNAVAILABLE'); }
function responseUnavailable() { return new NotFoundError('Response', 'COWORK_RESPONSE_UNAVAILABLE'); }
function wire(value: CoWorkRequestTransition): AgentJsonValue {
  return { requestId: value.requestId, version: value.version, state: value.state,
    responseRef: value.responseRef as unknown as AgentJsonValue };
}
function restored(value: AgentJsonValue): CoWorkRequestTransition {
  const v = value as unknown as CoWorkRequestTransition;
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof v.requestId !== 'string' || !Number.isSafeInteger(v.version)
    || agentOutcomeFingerprint({ value: wire(v), postconditions: [] }) !== agentOutcomeFingerprint({ value, postconditions: [] }))
    throw new Error('Invalid persisted request transition');
  return v;
}

/**
 * Internal caller-owned composition of the recipient's `cowork.request.claim` / `cowork.request.respond`. No HTTP
 * cache, new transaction, model wake or event flush. Errors must escape the caller's transaction so a refusal leaves
 * the request, any publication, grant use and receipt unchanged. Not a public tool.
 */
export async function coWorkRequestResponseInTransaction(tx: Transaction, claims: FluxMcpClaims,
  raw: AgentExecutionCommand, policy: CoWorkResponsePolicy): Promise<CoWorkRequestTransition> {
  const command = normalizeAgentExecution(raw);
  if (!OPERATIONS.includes(command.operation) || !command.objectId)
    throw new InvalidInputError('An exact co-work request operation and recipient unit are required');
  const unitId = command.objectId;
  const input: CoWorkRequestClaimInput | CoWorkResponseInput = command.operation === 'cowork.request.claim'
    ? normalizeCoWorkRequestClaim(command.payload) : normalizeCoWorkResponse(command.payload);
  policy = Object.freeze({ ...policy });
  if (typeof policy.publishResponse !== 'function') throw new Error('Current co-work response providers are required');
  const rows = coworkResponseRows(tx), references = coworkAdmissionRows(tx);
  let locked: Awaited<ReturnType<ReturnType<typeof coworkUnitRows>['lock']>> = null;
  const execution = agentExecutionInTransaction(tx, claims, {
    // Canonical post-state under the retained locks: the recipient's request identity/version/state, its
    // addressing and unit, the unit's role/assignment and, for a claim, the still-current claimed generation.
    async coordinationRequestPostcondition(_tx, context, _command, condition: RequestPostcondition) {
      if (_tx !== tx || !locked) return false;
      const request = await rows.request(context.workspaceId, condition.projectId, condition.requestId);
      const unit = await locked.current();
      return !!request && !!unit && request.recipientConnectionId === condition.connectionId && request.unitId === condition.unitId
        && request.version === condition.version && request.state === condition.state && unit.id === condition.unitId
        && unit.role === condition.role && unit.assignmentConnectionId === condition.connectionId
        && (request.state !== 'claimed' || request.claimedGeneration === unit.generation);
    },
  });
  // Current identity/grant/one-command ledger preparation precedes the slot, graphs, tasks, units and request.
  const prepared = await execution.prepare(command);
  const runtime = prepared.context;
  const context: CoWorkContext = { workspaceId: runtime.workspaceId, projectId: command.projectId,
    connectionId: runtime.connectionId, agentId: runtime.agentId, ownerId: runtime.ownerUserId, runtimeSessionId: runtime.id };
  locked = await coworkUnitRows(tx).lock({ ...context, unitId }, (units) => coWorkTaskGraphLocks(tx, context.workspaceId, units));
  if (!locked || locked.unit.role !== command.peerRequestClass) throw new NotFoundError('Work unit', 'COWORK_UNIT_NOT_FOUND');
  const request = await rows.lockRequest(context.workspaceId, context.projectId, input.requestId);
  const readable = async (refs: readonly CoWorkSourceRef[]) => references.referencesReadable(context.workspaceId, context.projectId, refs);
  const current = async () => {
    const row = await rows.request(context.workspaceId, context.projectId, input.requestId);
    if (!row) throw new NotFoundError('Request', 'COWORK_REQUEST_UNAVAILABLE');
    return row;
  };

  if (prepared.replay) {
    // Observation only: no fence, transition, publication or debit. Current readability still applies;
    // the post-state hook rejects any later transition as stale.
    const original = restored(prepared.replay.value);
    if (!request || original.requestId !== request.id) throw new NotFoundError('Request', 'COWORK_REQUEST_UNAVAILABLE');
    const row = await current();
    if (original.state !== 'declined' && !await readable([row.target, ...row.sourceRefs, ...row.criteriaRefs])) throw sourceUnavailable();
    if (original.responseRef && !await readable([original.responseRef])) throw responseUnavailable();
    await execution.complete(prepared, { value: prepared.replay.value, postconditions: prepared.replay.postconditions });
    return original;
  }

  const facts = { unit: locked.unit, request, now: request?.now ?? locked.now };
  const fence = { requestId: input.requestId, expectedVersion: input.expectedRequestVersion, generation: input.generation,
    leaseId: input.leaseId, runtimeSessionId: runtime.id };
  const scope = { ...context, unitId };
  let result: { id: string; version: number; state: string } | null;
  let responseRef: CoWorkSourceRef | null = null;
  if (command.operation === 'cowork.request.claim') {
    requireCoWorkRequestClaim(context, facts, input);
    const row = await current();
    if (!await readable([row.target, ...row.sourceRefs, ...row.criteriaRefs])) throw sourceUnavailable();
    result = await rows.claim(scope, fence);
  } else {
    const response = input as CoWorkResponseInput;
    requireCoWorkResponse(context, facts, response);
    if (response.outcome === 'resolved') {
      const row = await current();
      if (!await readable([row.target, ...row.sourceRefs, ...row.criteriaRefs])) throw sourceUnavailable();
      // The native response and its resolution commit together, or neither does.
      responseRef = normalizeCoWorkResponseRef(await policy.publishResponse(tx, runtime,
        { id: row.id, taskId: locked.unit.taskId, unitId }, response.response));
      if (!await readable([responseRef])) throw responseUnavailable();
      result = await rows.respond(scope, fence, { state: 'resolved', responseRef });
    } else {
      result = await rows.respond(scope, fence, { state: 'declined', reason: response.reason });
    }
  }
  if (!result) throw changed();
  const transition: CoWorkRequestTransition = { requestId: result.id, version: result.version,
    state: result.state as CoWorkRequestState, responseRef };
  const postcondition: RequestPostcondition = { kind: 'cowork.request_state', workspaceId: context.workspaceId,
    projectId: context.projectId, connectionId: context.connectionId, unitId, requestId: transition.requestId,
    role: locked.unit.role, version: transition.version, state: transition.state };
  await execution.complete(prepared, { value: wire(transition), postconditions: [postcondition] });
  return transition;
}
