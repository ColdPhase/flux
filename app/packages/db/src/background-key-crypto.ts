import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** Raw 32-byte operator secret in a Docker file mount, separate from database backups. */
export function loadBackgroundMasterKey(path = '/run/secrets/flux_background_key'): Buffer | null {
  let key: Buffer;
  try { key = readFileSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (key.length === 0) return null; // optional capability, empty Compose placeholder
  if (key.length !== 32) throw new Error('Background key secret must contain exactly 32 raw bytes');
  return key;
}

const aad = (ownerUserId: string, connectionId: string) =>
  Buffer.from(`flux-background-key:v1:${ownerUserId}:${connectionId}`);

export function sealBackgroundKey(plainKey: string, ownerUserId: string, connectionId: string, masterKey: Buffer): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, nonce);
  cipher.setAAD(aad(ownerUserId, connectionId));
  const encrypted = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

/** Worker/maintenance read only. API request handlers never call this function. */
export function openBackgroundKey(blob: string, ownerUserId: string, connectionId: string, masterKey: Buffer): string {
  const parts = blob.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported encrypted background key format');
  const [, iv, tag, encrypted] = parts;
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(iv!, 'base64url'));
  decipher.setAAD(aad(ownerUserId, connectionId));
  decipher.setAuthTag(Buffer.from(tag!, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encrypted!, 'base64url')), decipher.final()]).toString('utf8');
}
