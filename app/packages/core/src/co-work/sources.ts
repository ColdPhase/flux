import type { CoWorkSourceRef } from '@flux/contracts';
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
