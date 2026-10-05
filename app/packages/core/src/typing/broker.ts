import type { TypingPulse } from './presence.js';
import { normalizeTypingContext } from './commands.js';
import { id } from '../work/validation.js';
import { InvalidInputError } from '../access/errors.js';

export const TYPING_CHANNEL = 'flux_typing';
export interface TypingNotificationPort {
  now(): Promise<number>;
  /** Server-established identity/context only; never a decoded client command. */
  publish(pulse: Omit<TypingPulse, 'expiresAt'>, minimumExpiry: number): Promise<TypingPulse>;
}
/** Strict internal envelope. A notification is not proof of current session or native access. */
export function decodeTypingPulse(payload: string): TypingPulse {
  if (Buffer.byteLength(payload, 'utf8') > 2048) throw new InvalidInputError('Invalid typing notification');
  let value: unknown;
  try { value = JSON.parse(payload); } catch { throw new InvalidInputError('Invalid typing notification'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidInputError('Invalid typing notification');
  const raw = value as Record<string, unknown>;
  const expected = ['connectionId', 'actorId', 'sessionId', 'context', 'sequence', 'active', 'expiresAt'];
  if (Object.keys(raw).length !== expected.length || expected.some((key) => !Object.hasOwn(raw, key))) throw new InvalidInputError('Invalid typing notification');
  for (const key of ['actorId', 'sessionId']) {
    if (typeof raw[key] !== 'string' || !raw[key] || raw[key].length > 128 || /[\p{Cc}\p{Cf}]/u.test(raw[key])) throw new InvalidInputError('Invalid typing notification');
  }
  if (!Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 1 || typeof raw.active !== 'boolean' ||
      typeof raw.expiresAt !== 'number' || !Number.isFinite(raw.expiresAt) || raw.expiresAt < 0) throw new InvalidInputError('Invalid typing notification');
  return { connectionId: id(raw.connectionId, 'connectionId'), actorId: raw.actorId as string, sessionId: raw.sessionId as string,
    context: normalizeTypingContext(raw.context), sequence: raw.sequence as number, active: raw.active, expiresAt: raw.expiresAt };
}
