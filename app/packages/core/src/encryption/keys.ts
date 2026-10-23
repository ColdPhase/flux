import { randomBytes, type KeyObject } from 'node:crypto';
import { CONTEXT, encodeContext, hkdfKey, secretKey, uuidBytes } from './primitives.js';
import { openField, sealField } from './envelope.js';

/**
 * One key version of a sealed workspace in RAM (F-030): the DEK and its two subkeys, all `KeyObject`s, never strings.
 * `K_seal` = HKDF(DEK, salt = workspace UUID bytes, info `[flux seal v1, version]`) for database fields, `K_file` the
 * same with `flux file v1` for file objects. The DEK itself is used only to derive them and to be sealed again (to a
 * holder or the keyring).
 */
export class WorkspaceKey {
  private constructor(readonly workspaceId: string, readonly version: number, private readonly dek: KeyObject,
    readonly sealKey: KeyObject, readonly fileKey: KeyObject) {}

  /** Copies `dek` into key objects; the caller zeroes its buffer. */
  static fromDek(workspaceId: string, version: number, dek: Buffer): WorkspaceKey {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error('A key version is a positive integer');
    const salt = uuidBytes(workspaceId);
    const root = secretKey(dek);
    return new WorkspaceKey(workspaceId, version, root,
      hkdfKey(root, salt, encodeContext([CONTEXT.seal, version])),
      hkdfKey(root, salt, encodeContext([CONTEXT.file, version])));
  }

  /** The raw DEK, to seal it to a holder or to the keyring. The caller zeroes the buffer at once. */
  exportDek(): Buffer {
    return this.dek.export();
  }
}

/** A new random DEK (32 bytes). The caller zeroes it once it is sealed. */
export function newDek(): Buffer {
  return randomBytes(32);
}

const CHECK_TEXT = 'flux key check v1';
const checkPlace = (key: WorkspaceKey) => ({ workspaceId: key.workspaceId, field: 'workspace_key_versions.check_value', identity: [String(key.version)] });

/** `workspace_key_versions.check_value`: a fixed text sealed under the version's DEK when the version is made. */
export function keyCheckValue(key: WorkspaceKey): string {
  return sealField(key, checkPlace(key), CHECK_TEXT);
}

/** Whether a DEK opens its version's check value (one of the acceptance checks of an unlock). */
export function keyCheckValid(key: WorkspaceKey, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try { return openField((version) => (version === key.version ? key : undefined), checkPlace(key), value) === CHECK_TEXT; } catch { return false; }
}
