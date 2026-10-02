import { createHash } from 'node:crypto';
import type { CoWorkEnqueueCommand, CoWorkRequestLimits, CoWorkSourceRef } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function id(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new InvalidInputError('A canonical identifier is required');
  return value.toLowerCase();
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key)))
    throw new InvalidInputError('Only bounded coordination fields are allowed');
  return value as Record<string, unknown>;
}
function positive(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum)
    throw new InvalidInputError('A bounded positive integer is required');
  return Number(value);
}
export function normalizeCoWorkSource(value: unknown): CoWorkSourceRef {
  const type = object(value, ['type', 'id', 'version', 'bindingId', 'linkId', 'headSha']).type;
  if (type === 'github_pr') {
    const ref = object(value, ['type', 'bindingId', 'linkId', 'headSha']);
    if (typeof ref.headSha !== 'string' || !/^[0-9a-f]{40}$/i.test(ref.headSha))
      throw new InvalidInputError('The exact verified GitHub head is required');
    return { type, bindingId: id(ref.bindingId), linkId: id(ref.linkId), headSha: ref.headSha.toLowerCase() };
  }
  if (type === 'message' || type === 'result') {
    const ref = object(value, ['type', 'id']);
    return { type, id: id(ref.id) };
  }
  if (type === 'material' || type === 'doc' || type === 'work' || type === 'thought') {
    const ref = object(value, ['type', 'id', 'version']);
    return { type, id: id(ref.id), version: positive(ref.version, 2147483647) };
  }
  throw new InvalidInputError('Unsupported canonical source reference');
}
function refs(value: unknown, maximum: number): CoWorkSourceRef[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum)
    throw new InvalidInputError('Bounded original source references are required');
  const unique = new Map(value.map((entry) => { const ref = normalizeCoWorkSource(entry); return [JSON.stringify(ref), ref]; }));
  return [...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, ref]) => ref);
}
export function normalizeCoWorkRequest(value: unknown): CoWorkEnqueueCommand {
  const input = object(value, ['commandId', 'unitId', 'expectedUnitVersion', 'recipientConnectionId', 'intentKey',
    'parentRequestId', 'kind', 'target', 'sourceRefs', 'criteriaRefs', 'priority', 'peerUnblocking', 'lifetimeSeconds']);
  if (typeof input.intentKey !== 'string' || !/^[a-zA-Z0-9_:.-]{1,200}$/.test(input.intentKey)
    || typeof input.kind !== 'string' || !['help', 'review', 'fix', 'handoff'].includes(input.kind)
    || !Number.isSafeInteger(input.priority) || Number(input.priority) < 0 || Number(input.priority) > 3
    || typeof input.peerUnblocking !== 'boolean') throw new InvalidInputError('Invalid request routing metadata');
  return { commandId: id(input.commandId), unitId: id(input.unitId), expectedUnitVersion: positive(input.expectedUnitVersion, 2147483647),
    recipientConnectionId: id(input.recipientConnectionId), intentKey: input.intentKey,
    parentRequestId: input.parentRequestId === null ? null : id(input.parentRequestId), kind: input.kind as CoWorkEnqueueCommand['kind'],
    target: normalizeCoWorkSource(input.target), sourceRefs: refs(input.sourceRefs, 16), criteriaRefs: refs(input.criteriaRefs, 8),
    priority: Number(input.priority), peerUnblocking: input.peerUnblocking, lifetimeSeconds: positive(input.lifetimeSeconds, 604800) };
}
export function validateCoWorkRequestLimits(limits: CoWorkRequestLimits): void {
  positive(limits.maximumRequests, 128);
  for (const [value, maximum] of [[limits.maximumDepth, 8], [limits.maximumReviewRounds, 16]]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new InvalidInputError('Invalid lineage policy ceiling');
  }
}
/** Permanent domain correlation; the separate #152 command fingerprint also binds session/grant/operation. */
export function coWorkRequestFingerprint(input: CoWorkEnqueueCommand, senderConnectionId: string): string {
  const normalized = normalizeCoWorkRequest(input);
  const { commandId: _command, expectedUnitVersion: _version, ...effect } = normalized;
  // Transport command changes do not duplicate the same retained semantic intent.
  void _command;
  void _version;
  return createHash('sha256').update(JSON.stringify({ senderConnectionId: id(senderConnectionId), ...effect })).digest('hex');
}
