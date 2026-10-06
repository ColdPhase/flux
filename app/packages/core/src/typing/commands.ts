import type { TypingCommand, TypingContext } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import { id } from '../work/validation.js';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInputError('Invalid typing command');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
    throw new InvalidInputError('Invalid typing command');
}
export function normalizeTypingContext(value: unknown): TypingContext {
  const raw = object(value);
  keys(raw, ['kind', 'id']);
  if (raw.kind !== 'conversation' && raw.kind !== 'dm' && raw.kind !== 'task') throw new InvalidInputError('Invalid typing context');
  return { kind: raw.kind, id: id(raw.id, 'context.id') };
}
/** Closed schema: unsupported identity/text fields are rejected, never stripped or echoed. */
export function normalizeTypingCommand(value: unknown): TypingCommand {
  const raw = object(value);
  if (raw.type === 'watch') { keys(raw, ['type', 'context']); return { type: 'watch', context: normalizeTypingContext(raw.context) }; }
  if (raw.type === 'active') {
    keys(raw, ['type', 'active']);
    if (typeof raw.active !== 'boolean') throw new InvalidInputError('Invalid typing command');
    return { type: 'active', active: raw.active };
  }
  if (raw.type === 'leave') { keys(raw, ['type']); return { type: 'leave' }; }
  throw new InvalidInputError('Invalid typing command');
}
export const typingContextKey = (context: TypingContext) => `${context.kind}:${context.id}`;
