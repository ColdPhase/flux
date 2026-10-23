import { CONTEXT, DecryptionFailedError, encodeContext, gcmOpen, gcmSeal, hkdfKey } from './primitives.js';
import type { WorkspaceKey } from './keys.js';

/**
 * The field envelope of F-030: `fx1.<key version>.<base64url(nonce 12 ‖ ciphertext ‖ tag 16)>`, AES-256-GCM under a
 * key per row, `K_row = HKDF(K_seal, info = AAD)`, with AAD `[flux seal v1, workspace id, field, row identity…, key
 * version]`. A value moved to another row, column, table or workspace, or relabelled with another version, fails.
 * jsonb columns hold `{"$sealed": envelope}`.
 */

/** Where a value lives: its workspace, its registry field (`project_messages.body`) and its row's primary key. */
export interface FieldPlace {
  workspaceId: string;
  field: string;
  identity: readonly string[];
}

/** Chooses the DEK of a version, or undefined when the version is not live here. */
export type KeyForVersion = (version: number) => WorkspaceKey | undefined;

const ENVELOPE = /^fx1\.([1-9][0-9]{0,8})\.([A-Za-z0-9_-]{38,})$/;

function context(place: FieldPlace, version: number): Buffer {
  return encodeContext([CONTEXT.seal, place.workspaceId, place.field, ...place.identity, version]);
}

export function sealField(key: WorkspaceKey, place: FieldPlace, plaintext: string | Buffer): string {
  if (place.workspaceId !== key.workspaceId) throw new Error('The key belongs to another workspace');
  const aad = context(place, key.version);
  const sealed = gcmSeal(hkdfKey(key.sealKey, Buffer.alloc(0), aad), Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8'), aad);
  return `fx1.${key.version}.${sealed.toString('base64url')}`;
}

/** The key version an envelope names, or null when the value is not an envelope. Needs no key. */
export function envelopeVersion(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = ENVELOPE.exec(value);
  return match ? Number(match[1]) : null;
}

export function isEnvelope(value: unknown): value is string {
  return envelopeVersion(value) !== null;
}

export function openFieldBytes(keyFor: KeyForVersion, place: FieldPlace, envelope: string): Buffer {
  const match = ENVELOPE.exec(envelope);
  if (!match) throw new DecryptionFailedError();
  const version = Number(match[1]);
  const key = keyFor(version);
  if (!key || key.version !== version || key.workspaceId !== place.workspaceId) throw new DecryptionFailedError();
  const aad = context(place, version);
  return gcmOpen(hkdfKey(key.sealKey, Buffer.alloc(0), aad), Buffer.from(match[2]!, 'base64url'), aad);
}

export function openField(keyFor: KeyForVersion, place: FieldPlace, envelope: string): string {
  return openFieldBytes(keyFor, place, envelope).toString('utf8');
}

/** A jsonb column's sealed form, so `jsonb_typeof = 'object'` checks still hold. */
export const sealedJson = (envelope: string) => ({ $sealed: envelope });
export function isSealedJson(value: unknown): value is { $sealed: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 1
    && isEnvelope((value as { $sealed?: unknown }).$sealed);
}
