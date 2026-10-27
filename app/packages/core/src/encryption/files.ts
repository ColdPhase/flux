import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform } from 'node:stream';
import { CONTEXT, DecryptionFailedError, encodeContext, hkdfKey } from './primitives.js';
import type { KeyForVersion } from './envelope.js';
import type { WorkspaceKey } from './keys.js';

/**
 * File objects of a sealed workspace (F-030 Files): `FXF1 ‖ key version (uint32) ‖ nonce 12 ‖ ciphertext ‖ tag 16`, one
 * GCM pass per file (files are at most 5 MiB), with a per-file key `HKDF(K_file, info = [flux file v1, workspace id,
 * file id, key version])` and the same list as AAD. The encryptor streams, so plaintext never reaches a scratch file;
 * `openFileObject` returns bytes only after the tag verifies.
 */
export const FILE_MAGIC = Buffer.from('FXF1', 'ascii');
const HEADER = FILE_MAGIC.length + 4 + 12;
const TAG = 16;

function fileContext(workspaceId: string, fileId: string, version: number) {
  return encodeContext([CONTEXT.file, workspaceId, fileId, version]);
}

/** A stream that turns a file's plaintext into its stored object. */
export function fileEncryptor(key: WorkspaceKey, fileId: string): Transform {
  const aad = fileContext(key.workspaceId, fileId, key.version);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', hkdfKey(key.fileKey, Buffer.alloc(0), aad), nonce, { authTagLength: TAG });
  cipher.setAAD(aad);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(key.version);
  let started = false;
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      if (!started) { started = true; this.push(Buffer.concat([FILE_MAGIC, version, nonce])); }
      done(null, cipher.update(chunk));
    },
    flush(done) {
      if (!started) this.push(Buffer.concat([FILE_MAGIC, version, nonce]));
      this.push(cipher.final());
      done(null, cipher.getAuthTag());
    },
  });
}

/** The whole object at once (tests, the rotation's rewrite). */
export function sealFileObject(key: WorkspaceKey, fileId: string, plaintext: Buffer): Buffer {
  const aad = fileContext(key.workspaceId, fileId, key.version);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', hkdfKey(key.fileKey, Buffer.alloc(0), aad), nonce, { authTagLength: TAG });
  cipher.setAAD(aad);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(key.version);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([FILE_MAGIC, version, nonce, body, cipher.getAuthTag()]);
}

/** The key version in an object's header, or null when it is not a sealed object. Needs no key. */
export function fileObjectVersion(object: Buffer): number | null {
  if (object.length < HEADER + TAG || !object.subarray(0, 4).equals(FILE_MAGIC)) return null;
  const version = object.readUInt32BE(4);
  return version >= 1 ? version : null;
}

/** The plaintext of a stored object, only once its tag verifies; a truncated or tampered object returns nothing. */
export function openFileObject(keyFor: KeyForVersion, workspaceId: string, fileId: string, object: Buffer): Buffer {
  const version = fileObjectVersion(object);
  const key = version === null ? undefined : keyFor(version);
  if (version === null || !key || key.version !== version || key.workspaceId !== workspaceId) throw new DecryptionFailedError();
  const aad = fileContext(workspaceId, fileId, version);
  const decipher = createDecipheriv('aes-256-gcm', hkdfKey(key.fileKey, Buffer.alloc(0), aad), object.subarray(8, HEADER), { authTagLength: TAG });
  decipher.setAAD(aad);
  decipher.setAuthTag(object.subarray(object.length - TAG));
  try {
    return Buffer.concat([decipher.update(object.subarray(HEADER, object.length - TAG)), decipher.final()]);
  } catch {
    throw new DecryptionFailedError();
  }
}
