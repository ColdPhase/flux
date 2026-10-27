import { createCipheriv, createDecipheriv, createSecretKey, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';

/**
 * The building blocks of F-030 (#655; docs/product/encrypted-workspaces.md#cryptography), all from `node:crypto`:
 * the length-prefixed context encoding, HKDF-SHA256 to a 32-byte `KeyObject`, and AES-256-GCM as
 * `nonce 12 ‖ ciphertext ‖ tag 16`. Nothing here logs or keeps a secret.
 */

/** The purpose labels that start every AAD and HKDF info. */
export const CONTEXT = {
  seal: 'flux seal v1',
  wrap: 'flux wrap v1',
  holder: 'flux holder v1',
  unlock: 'flux unlock v1',
  file: 'flux file v1',
} as const;

/**
 * Every AAD and HKDF `info`: each component as its UTF-8 bytes preceded by a 4-byte big-endian length. Identities
 * can contain client-chosen text, so no separator character can make two contexts equal.
 */
export function encodeContext(parts: readonly (string | number)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const bytes = Buffer.from(String(part), 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

/** A ciphertext, wrap or object that does not authenticate: wrong key, wrong place, truncated or tampered. */
export class DecryptionFailedError extends Error {
  constructor() {
    super('The value does not decrypt here');
    this.name = 'DecryptionFailedError';
  }
}

/** HKDF-SHA256 to a 32-byte secret key. The intermediate bytes are zeroed. */
export function hkdfKey(ikm: KeyObject | Buffer, salt: Buffer, info: Buffer): KeyObject {
  const raw = Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
  try { return createSecretKey(raw); } finally { raw.fill(0); }
}

/** A secret key from raw bytes; the caller zeroes its buffer. */
export function secretKey(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('A key is 32 bytes');
  return createSecretKey(raw);
}

export const GCM_OVERHEAD = 28;

export function gcmSeal(key: KeyObject, plaintext: Buffer, aad: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

export function gcmOpen(key: KeyObject, sealed: Buffer, aad: Buffer): Buffer {
  if (sealed.length < GCM_OVERHEAD) throw new DecryptionFailedError();
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12), { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]);
  } catch {
    throw new DecryptionFailedError();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The 16 bytes of a workspace UUID, the HKDF salt of its subkeys. */
export function uuidBytes(id: string): Buffer {
  if (!UUID.test(id)) throw new Error('A workspace id is a UUID');
  return Buffer.from(id.replace(/-/g, ''), 'hex');
}

export const b64url = (bytes: Buffer) => bytes.toString('base64url');
export function fromB64url(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new DecryptionFailedError();
  return Buffer.from(value, 'base64url');
}
