import { createHash } from 'node:crypto';
import { AGENT_OPERATIONS, AGENT_OPERATION_CLASSES, AGENT_PEER_REQUEST_CLASSES,
  type AgentCommandReceipt, type AgentExecutionCommand, type AgentJsonValue,
  type AgentPostcondition, type AuthenticatedAgentRuntime } from '@flux/contracts';
import { DomainError, InvalidInputError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';

export interface NormalizedAgentExecutionCommand extends AgentExecutionCommand { fingerprint: string }
export interface AgentExecutionScope<Tx> {
  readonly transaction: Tx;
  readonly context: AuthenticatedAgentRuntime;
  readonly now: Date;
  readonly replay: AgentCommandReceipt | null;
}
export interface AgentExecutionOutcome<T extends AgentJsonValue = AgentJsonValue> {
  value: T;
  postconditions: AgentPostcondition[];
}
/** Bound to one already-open outer transaction and trusted verified bearer identity. */
export interface AgentExecutionPort<Tx> {
  prepare(command: NormalizedAgentExecutionCommand): Promise<AgentExecutionScope<Tx>>;
  /** Check canonical post-state/current authority, debit once and store the one receipt. No commit/events. */
  complete(scope: AgentExecutionScope<Tx>, outcome: AgentExecutionOutcome): Promise<void>;
}

const FIELDS = ['runtimeSessionId', 'grantId', 'clientCommandId', 'projectId', 'operation', 'peerRequestClass', 'audience', 'objectId', 'sources', 'payload'];
function uuid(value: unknown, field: string): string {
  if (!isUuid(value)) throw new InvalidInputError(`${field} must be a UUID`);
  return value.toLowerCase();
}
function json(value: unknown, depth = 0): AgentJsonValue {
  if (depth > 12) throw new InvalidInputError('The command payload is too deeply nested');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 200) throw new InvalidInputError('A command payload array is at most 200 items');
    return value.map((item) => json(item, depth + 1));
  }
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length > 100) throw new InvalidInputError('A command payload object is at most 100 fields');
    return Object.fromEntries(entries.map(([key, item]) => [key, json(item, depth + 1)]));
  }
  throw new InvalidInputError('The command payload must be finite JSON');
}
export function normalizeAgentExecution(command: AgentExecutionCommand): NormalizedAgentExecutionCommand {
  if (!command || typeof command !== 'object' || Object.keys(command).some((key) => !FIELDS.includes(key)))
    throw new InvalidInputError('A typed execution command is required');
  if (!AGENT_OPERATIONS.includes(command.operation) || !AGENT_PEER_REQUEST_CLASSES.includes(command.peerRequestClass))
    throw new InvalidInputError('Unknown operation or peer request class');
  if (!AGENT_OPERATION_CLASSES[command.operation].includes(command.peerRequestClass))
    throw new InvalidInputError('This operation is unavailable to that request class');
  const projectId = uuid(command.projectId, 'projectId');
  if (!command.audience || command.audience.kind !== 'project' || command.audience.projectId?.toLowerCase() !== projectId
    || Object.keys(command.audience).some((key) => !['kind', 'projectId'].includes(key)))
    throw new InvalidInputError('The audience must be this exact project');
  if (!Array.isArray(command.sources) || command.sources.length > 50) throw new InvalidInputError('At most 50 source versions are allowed');
  const sources = command.sources.map((source) => {
    if (!source || Object.keys(source).some((key) => !['materialId', 'version'].includes(key))
      || !Number.isSafeInteger(source.version) || source.version < 1 || source.version > 2_147_483_647)
      throw new InvalidInputError('Each source needs an exact positive version');
    return { materialId: uuid(source.materialId, 'source materialId'), version: source.version };
  }).sort((a, b) => a.materialId.localeCompare(b.materialId));
  if (new Set(sources.map((source) => source.materialId)).size !== sources.length) throw new InvalidInputError('Source IDs must be distinct');
  const normalized: AgentExecutionCommand = { runtimeSessionId: uuid(command.runtimeSessionId, 'runtimeSessionId'),
    grantId: uuid(command.grantId, 'grantId'), clientCommandId: uuid(command.clientCommandId, 'clientCommandId'), projectId,
    operation: command.operation, peerRequestClass: command.peerRequestClass, audience: { kind: 'project', projectId },
    objectId: command.objectId === null ? null : uuid(command.objectId, 'objectId'), sources, payload: json(command.payload) };
  const creates = ['work.create', 'map.create', 'result.record', 'decision.propose', 'doc.create', 'conversation.create'];
  if (creates.includes(command.operation) ? normalized.objectId !== null : normalized.objectId === null)
    throw new InvalidInputError('Creates have no existing target; changes require their exact canonical target ID');
  const serialized = JSON.stringify(normalized);
  if (serialized.length > 200_000) throw new InvalidInputError('The command payload is too large');
  return { ...normalized, fingerprint: createHash('sha256').update(serialized).digest('hex') };
}

/** Stable JSON for durable outcomes; jsonb object key ordering cannot alter replay equality. */
export function agentOutcomeFingerprint(outcome: AgentExecutionOutcome): string {
  return createHash('sha256').update(JSON.stringify(json({ value: outcome.value, postconditions: outcome.postconditions }))).digest('hex');
}

const POSTCONDITIONS: Record<AgentExecutionCommand['operation'], readonly AgentPostcondition['kind'][]> = {
  'work.create': ['work'], 'work.update': ['work'], 'result.record': ['result'], 'decision.propose': ['decision'],
  'map.create': ['map'], 'map.rename': ['map'], 'map.thought.create': ['thought', 'map_checkpoint'],
  'map.thought.update': ['thought', 'map_checkpoint'], 'map.thought.delete': ['map_checkpoint'],
  'map.positions.update': ['thought', 'map_checkpoint'], 'map.link.create': ['map_checkpoint'], 'map.link.delete': ['map_checkpoint'],
  'doc.create': ['doc'], 'doc.update': ['doc'], 'conversation.create': ['message'], 'conversation.reply': ['message'],
  'cowork.claim': ['cowork.claim_state'], 'cowork.renew': ['cowork.claim_state'], 'cowork.release': ['cowork.claim_state'],
  'cowork.request': ['cowork.request_state'],
};
function postconditionInvalid(): never {
  throw new DomainError(409, 'COMMAND_POSTSTATE_INVALID', 'A command needs its exact canonical produced post-state');
}
function integer(value: unknown, minimum = 1): boolean {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= 2_147_483_647;
}
function iso(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
/** Internal adapter boundary: validate persisted/produced shapes before any row lookup or receipt write. */
export function validateAgentPostconditions(operation: AgentExecutionCommand['operation'], value: unknown): asserts value is AgentPostcondition[] {
  if (!Array.isArray(value) || !value.length || value.length > 201) postconditionInvalid();
  const counts = new Map<AgentPostcondition['kind'], number>(); const identities = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || !POSTCONDITIONS[operation]?.includes(raw.kind)) postconditionInvalid();
    const condition = raw as AgentPostcondition;
    const identity = `${condition.kind}:${condition.kind === 'cowork.request_state' ? condition.requestId : 'id' in condition ? condition.id : condition.unitId}`;
    if (identities.has(identity)) postconditionInvalid();
    identities.add(identity); counts.set(condition.kind, (counts.get(condition.kind) ?? 0) + 1);
    let fields: string[];
    if (condition.kind === 'cowork.claim_state') {
      fields = ['kind', 'workspaceId', 'projectId', 'connectionId', 'unitId', 'role', 'version', 'generation', 'state', 'leaseId', 'leaseSessionId', 'leaseExpiresAt', 'checkpointId'];
      if (![condition.workspaceId, condition.projectId, condition.connectionId, condition.unitId].every(isUuid)
        || !AGENT_PEER_REQUEST_CLASSES.includes(condition.role) || !integer(condition.version) || !integer(condition.generation, 0)
        || !['pending', 'claimed', 'paused', 'completed', 'stopped'].includes(condition.state)
        || condition.checkpointId !== null && !isUuid(condition.checkpointId)) postconditionInvalid();
      if (condition.state === 'claimed'
        ? !isUuid(condition.leaseId) || !isUuid(condition.leaseSessionId) || !iso(condition.leaseExpiresAt)
        : condition.leaseId !== null || condition.leaseSessionId !== null || condition.leaseExpiresAt !== null) postconditionInvalid();
    } else if (condition.kind === 'cowork.request_state') {
      fields = ['kind', 'workspaceId', 'projectId', 'connectionId', 'unitId', 'requestId', 'role', 'version', 'state'];
      if (![condition.workspaceId, condition.projectId, condition.connectionId, condition.unitId, condition.requestId].every(isUuid)
        || !AGENT_PEER_REQUEST_CLASSES.includes(condition.role) || !integer(condition.version)
        || !['queued', 'deferred', 'claimed', 'resolved', 'declined', 'superseded', 'expired', 'cancelled'].includes(condition.state)) postconditionInvalid();
    } else {
      if (!isUuid(condition.id)) postconditionInvalid();
      if (condition.kind === 'result' || condition.kind === 'message') fields = ['kind', 'id'];
      else if (condition.kind === 'map_checkpoint') {
        fields = ['kind', 'id', 'updatedAt'];
        if (!iso(condition.updatedAt)) postconditionInvalid();
      } else {
        fields = ['kind', 'id', 'version'];
        if (!integer(condition.version)) postconditionInvalid();
      }
    }
    if (Object.keys(raw).length !== fields.length || Object.keys(raw).some((key) => !fields.includes(key))) postconditionInvalid();
  }
  for (const kind of POSTCONDITIONS[operation]) {
    const count = counts.get(kind) ?? 0;
    if (operation === 'map.positions.update' && kind === 'thought' ? count > 200 : count !== 1) postconditionInvalid();
  }
}

/** Both native actions and #153 stage their domain outcome through this same receipt port. */
export function agentExecutionUseCases<Tx>(port: AgentExecutionPort<Tx>) {
  return {
    async run<T extends AgentJsonValue>(command: AgentExecutionCommand,
      effect: (scope: AgentExecutionScope<Tx>) => Promise<AgentExecutionOutcome<T>>): Promise<T> {
      const scope = await port.prepare(normalizeAgentExecution(command));
      const result = await effect(scope);
      await port.complete(scope, result);
      return result.value;
    },
  };
}
