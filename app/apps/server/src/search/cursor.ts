import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Principal, SearchCursors, SearchPosition } from '@flux/core';

const PREFIX = 's1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const TOKEN = /^s1\.[A-Za-z0-9_-]{40,400}$/;

/**
 * Search cursors (#114): the AES-256-GCM encryption of the last visible result's position,
 * authenticated with the reader and the query scope as associated data. A cursor therefore
 * reveals nothing, works only for the person it was issued to and only for the same query and
 * filters. Keys are derived from the server secret (FLUX_AUTH_SECRET) with HKDF.
 */
export class SearchCursorCodec implements SearchCursors {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('The search cursor secret must be at least 32 characters');
    this.key = Buffer.from(hkdfSync('sha256', secret, 'flux-search-cursor', 'encryption-v1', 32));
  }

  private aad(principal: Principal, scope: string) {
    return Buffer.from(`${principal.kind}:${principal.id}\0${scope}`);
  }

  seal(principal: Principal, scope: string, position: SearchPosition): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(principal, scope));
    const sealed = Buffer.concat([cipher.update(JSON.stringify([position.score, position.at, position.id])), cipher.final()]);
    return PREFIX + Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url');
  }

  open(principal: Principal, scope: string, token: string): SearchPosition | null {
    if (!TOKEN.test(token)) return null;
    const raw = Buffer.from(token.slice(PREFIX.length), 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, IV_BYTES));
      decipher.setAAD(this.aad(principal, scope));
      decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
      const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString('utf8');
      const value: unknown = JSON.parse(plain);
      if (!Array.isArray(value) || value.length !== 3 || !value.every((part) => typeof part === 'string')) return null;
      const [score, at, id] = value as [string, string, string];
      if (!/^\d+(\.\d+)?$/.test(score) || !/^\d{1,19}$/.test(id) || at.length > 64) return null;
      return { score, at, id };
    } catch {
      return null;
    }
  }
}
