import * as crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { b64url, fromB64url } from './primitives.js';

/**
 * The KEK of a holder (F-030): Argon2id over the password or the normalised recovery code (UTF-8, NFC), a 16-byte
 * random salt and the second recommended option of RFC 9106 §4 (m = 64 MiB, t = 3, p = 4), 32-byte tag. The
 * parameters are stored per holder (`kdf`), so stronger ones can be applied at the next unlock.
 */
export interface KdfParams { alg: 'argon2id'; v: 19; m: number; t: number; p: number; salt: string }

export const KDF_COST = { m: 65_536, t: 3, p: 4 } as const;

export function newKdfParams(): KdfParams {
  return { alg: 'argon2id', v: 19, ...KDF_COST, salt: b64url(randomBytes(16)) };
}

/** Whether stored parameters are the current ones (an unlock with older ones re-wraps). */
export function kdfIsCurrent(params: KdfParams): boolean {
  return params.m === KDF_COST.m && params.t === KDF_COST.t && params.p === KDF_COST.p;
}

/** Stored parameters, bounded so a tampered row cannot make the server allocate without limit. */
export function parseKdfParams(value: unknown): KdfParams {
  const v = value as Partial<KdfParams> | null;
  const int = (n: unknown, min: number, max: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= max;
  if (!v || v.alg !== 'argon2id' || v.v !== 19 || !int(v.m, 8_192, 1_048_576) || !int(v.t, 1, 16) || !int(v.p, 1, 16)
    || typeof v.salt !== 'string' || fromB64url(v.salt).length !== 16) throw new Error('Unsupported key derivation parameters');
  return { alg: 'argon2id', v: 19, m: v.m!, t: v.t!, p: v.p!, salt: v.salt };
}

type Argon2 = (algorithm: 'argon2id', parameters: { message: Buffer; nonce: Buffer; parallelism: number; tagLength: number; memory: number; passes: number },
  callback: (error: Error | null, key: Buffer) => void) => void;

/** Derives the KEK on libuv's thread pool (off the event loop). The caller zeroes it. */
export function deriveKek(secret: string, params: KdfParams): Promise<Buffer> {
  const argon2 = (crypto as unknown as { argon2?: Argon2 }).argon2;
  if (!argon2) return Promise.reject(new Error('This Node build has no crypto.argon2 (needs v24.7.0 or later)'));
  const message = Buffer.from(secret.normalize('NFC'), 'utf8');
  return new Promise((resolve, reject) => argon2('argon2id', {
    message, nonce: fromB64url(params.salt), parallelism: params.p, tagLength: 32, memory: params.m, passes: params.t,
  }, (error, key) => {
    message.fill(0);
    if (error) reject(error);
    else resolve(Buffer.from(key));
  }));
}
