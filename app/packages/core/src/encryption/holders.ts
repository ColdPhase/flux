import { createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, timingSafeEqual, type KeyObject } from 'node:crypto';
import { b64url, CONTEXT, DecryptionFailedError, encodeContext, fromB64url, gcmOpen, gcmSeal, hkdfKey, secretKey } from './primitives.js';

/**
 * Holder keys of F-030 (Holder keys and the KDF). Every holder (an owner or admin with an unlock password, or the
 * recovery code) has an X25519 key pair. Its private key is wrapped under the KEK derived from the password or code;
 * every live DEK is sealed to its public key, HPKE base mode style from Node primitives. So a new key version can be
 * given to every remaining holder without their passwords, and a new DEK is never wrapped under an older one.
 */

export interface HolderPlace {
  workspaceId: string;
  holderId: string;
  kind: 'password' | 'recovery';
  /** Null exactly for the recovery holder. */
  userId: string | null;
}

export interface HolderKeyPair {
  /** Raw 32-byte X25519 public key, base64url (`workspace_holders.public_key`). */
  publicKey: string;
  privateKey: KeyObject;
}

export function generateHolderKeyPair(): HolderKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: publicKeyText(publicKey), privateKey };
}

function publicKeyText(key: KeyObject): string {
  const x = key.export({ format: 'jwk' }).x;
  if (typeof x !== 'string') throw new Error('Not an X25519 key');
  return x;
}

function importPublic(text: string): KeyObject {
  if (fromB64url(text).length !== 32) throw new DecryptionFailedError();
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: text }, format: 'jwk' });
}

const wrapContext = (place: HolderPlace, publicKey: string) =>
  encodeContext([CONTEXT.wrap, place.workspaceId, place.holderId, place.kind, place.userId ?? '', publicKey]);

/**
 * `wrapped_private`: AES-256-GCM of the PKCS#8 private key under the KEK, AAD `[flux wrap v1, workspace, holder, kind,
 * user or "", public key]`, so the stored public key is bound to the password.
 */
export function wrapPrivateKey(kek: Buffer, keyPair: HolderKeyPair, place: HolderPlace): string {
  const der = keyPair.privateKey.export({ format: 'der', type: 'pkcs8' });
  try { return b64url(gcmSeal(secretKey(kek), der, wrapContext(place, keyPair.publicKey))); } finally { der.fill(0); }
}

/** A holder row's public key does not belong to its private key: the row was changed outside Flux. */
export class HolderKeyMismatchError extends Error {
  constructor() { super('The holder\'s public key does not match its private key'); this.name = 'HolderKeyMismatchError'; }
}

/**
 * The holder's private key. A wrong password or code (or another holder's row, or a replaced public key) fails the
 * tag ({@link DecryptionFailedError}); a private key whose public key differs from the stored one is tampering
 * ({@link HolderKeyMismatchError}).
 */
export function unwrapPrivateKey(kek: Buffer, wrapped: string, place: HolderPlace, publicKey: string): KeyObject {
  const der = gcmOpen(secretKey(kek), fromB64url(wrapped), wrapContext(place, publicKey));
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch { throw new DecryptionFailedError(); } finally { der.fill(0); }
  if (key.asymmetricKeyType !== 'x25519' || holderPublicKey(key) !== publicKey) throw new HolderKeyMismatchError();
  return key;
}

/** One DEK version sealed to one holder (`workspace_dek_wraps`). */
export interface DekWrap { ephemeralPublic: string; sealedDek: string }
export interface DekPlace { workspaceId: string; holderId: string; keyVersion: number }

function sealingKey(shared: Buffer, place: DekPlace, ephemeralPublic: string, holderPublic: string) {
  const info = encodeContext([CONTEXT.holder, place.workspaceId, place.holderId, place.keyVersion, ephemeralPublic, holderPublic]);
  try { return { key: hkdfKey(shared, Buffer.alloc(0), info), info }; } finally { shared.fill(0); }
}

/** Seals a DEK to a holder's public key with a fresh ephemeral key pair. */
export function sealDekToHolder(dek: Buffer, holderPublic: string, place: DekPlace): DekWrap {
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = publicKeyText(ephemeral.publicKey);
  const { key, info } = sealingKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: importPublic(holderPublic) }), place, ephemeralPublic, holderPublic);
  return { ephemeralPublic, sealedDek: b64url(gcmSeal(key, dek, info)) };
}

/**
 * Opens a DEK wrap with the holder's private key. The holder's public key is computed from the private key, so a
 * wrap made for another key, version, holder or workspace, or a changed ephemeral key, fails. The caller zeroes the DEK.
 */
export function openDekForHolder(privateKey: KeyObject, wrap: DekWrap, place: DekPlace): Buffer {
  const holderPublic = publicKeyText(createPublicKey(privateKey));
  let shared: Buffer;
  try { shared = diffieHellman({ privateKey, publicKey: importPublic(wrap.ephemeralPublic) }); } catch { throw new DecryptionFailedError(); }
  const { key, info } = sealingKey(shared, place, wrap.ephemeralPublic, holderPublic);
  const dek = gcmOpen(key, fromB64url(wrap.sealedDek), info);
  if (dek.length !== 32) { dek.fill(0); throw new DecryptionFailedError(); }
  return dek;
}

/** The public key of a private key, to check a holder row's `public_key`. */
export function holderPublicKey(privateKey: KeyObject) { return publicKeyText(createPublicKey(privateKey)); }

// --- Authenticating holders and wraps (F-030): none of these needs anything a database writer has.

const AUTH = { holder: 'flux holder-auth v1', confirm: 'flux confirm v1', commit: 'flux commit v1' } as const;

function hmac(key: KeyObject, parts: readonly (string | number)[]): string {
  return createHmac('sha256', key).update(encodeContext(parts)).digest('base64url');
}
function sameMac(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
const dekDigest = (dek: Buffer) => createHash('sha256').update(dek).digest('base64url');

/** A holder row's authenticated fields. */
export interface HolderIdentity { workspaceId: string; holderId: string; kind: 'password' | 'recovery'; userId: string | null; publicKey: string }

/** `holder_mac`: HMAC under HKDF(DEK v, [flux holder-auth v1, workspace, v]) over [holder id, kind, user or "", public key]. */
export function holderMac(dek: Buffer, version: number, holder: HolderIdentity): string {
  const key = hkdfKey(dek, Buffer.alloc(0), encodeContext([AUTH.holder, holder.workspaceId, version]));
  return hmac(key, [holder.holderId, holder.kind, holder.userId ?? '', holder.publicKey]);
}
export const holderMacValid = (dek: Buffer, version: number, holder: HolderIdentity, mac: unknown) => sameMac(mac, holderMac(dek, version, holder));

/**
 * `workspace_dek_wraps.confirm`: HMAC under HKDF(KEK, [flux confirm v1, workspace, holder]) over [version, SHA-256(DEK)].
 * Only someone with the holder's password or code can write it.
 */
export function wrapConfirmation(kek: Buffer, place: DekPlace, dek: Buffer): string {
  const key = hkdfKey(kek, Buffer.alloc(0), encodeContext([AUTH.confirm, place.workspaceId, place.holderId]));
  return hmac(key, [place.keyVersion, dekDigest(dek)]);
}
export const wrapConfirmationValid = (kek: Buffer, place: DekPlace, dek: Buffer, confirm: unknown) => sameMac(confirm, wrapConfirmation(kek, place, dek));

/** `workspace_key_versions.commitment` of version v: HMAC under HKDF(DEK v-1, [flux commit v1, workspace, v-1]) over [v, SHA-256(DEK v)]. */
export function keyCommitment(previousDek: Buffer, workspaceId: string, version: number, dek: Buffer): string {
  if (version < 2) throw new Error('Version 1 has no commitment');
  const key = hkdfKey(previousDek, Buffer.alloc(0), encodeContext([AUTH.commit, workspaceId, version - 1]));
  return hmac(key, [version, dekDigest(dek)]);
}
export const keyCommitmentValid = (previousDek: Buffer, workspaceId: string, version: number, dek: Buffer, commitment: unknown) =>
  sameMac(commitment, keyCommitment(previousDek, workspaceId, version, dek));
