import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';

const PREFIX = 'c1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEQ_BYTES = 8;
const TOKEN = /^c1\.[A-Za-z0-9_-]{48}$/;

/**
 * Opaque, per-recipient stream cursors. A token is the AES-256-GCM encryption of an event
 * position, authenticated with the recipient's principal as associated data, so it neither
 * reveals the global event sequence nor works for anyone else. The IV is derived from the
 * recipient and position (deterministic encryption): the same recipient and position always
 * give the same token, which is what lets a recipient's cursors depend only on the events
 * that recipient may see. Keys are derived from the server secret (FLUX_AUTH_SECRET).
 */
export class CursorCodec {
  private readonly encryptionKey: Buffer;
  private readonly ivKey: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('The stream cursor secret must be at least 32 characters');
    this.encryptionKey = Buffer.from(hkdfSync('sha256', secret, 'flux-stream-cursor', 'encryption-v1', 32));
    this.ivKey = Buffer.from(hkdfSync('sha256', secret, 'flux-stream-cursor', 'iv-v1', 32));
  }

  encode(recipient: string, position: number): string {
    const plain = Buffer.alloc(SEQ_BYTES);
    plain.writeBigUInt64BE(BigInt(position));
    const iv = createHmac('sha256', this.ivKey).update(recipient).update('\0').update(plain).digest().subarray(0, IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(recipient));
    const sealed = Buffer.concat([cipher.update(plain), cipher.final()]);
    return PREFIX + Buffer.concat([iv, sealed, cipher.getAuthTag()]).toString('base64url');
  }

  /** The position of a token issued to `recipient`, or null for any other value. */
  decode(recipient: string, token: string): number | null {
    if (!TOKEN.test(token)) return null;
    const raw = Buffer.from(token.slice(PREFIX.length), 'base64url');
    if (raw.length !== IV_BYTES + SEQ_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, raw.subarray(0, IV_BYTES));
      decipher.setAAD(Buffer.from(recipient));
      decipher.setAuthTag(raw.subarray(IV_BYTES + SEQ_BYTES));
      const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, IV_BYTES + SEQ_BYTES)), decipher.final()]);
      const position = plain.readBigUInt64BE();
      return position <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(position) : null;
    } catch {
      return null;
    }
  }
}
