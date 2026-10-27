import { randomBytes } from 'node:crypto';

/**
 * The recovery code (F-030): 160 random bits as 32 Crockford base32 characters, shown in 8 groups of four. It is never
 * stored; it is the secret of the workspace's `recovery` holder.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A new code, formatted for showing (`K7QD-2M9X-…`). */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(20);
  let bits = 0;
  let value = 0;
  let text = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      text += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  bytes.fill(0);
  return text.match(/.{4}/g)!.join('-');
}

/**
 * The canonical form of typed input: upper case, spaces and hyphens removed, `O` → `0`, `I` and `L` → `1`. Null when the
 * result is not 32 characters of the alphabet.
 */
export function normalizeRecoveryCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 200) return null;
  const text = input.toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (text.length !== 32 || [...text].some((char) => !ALPHABET.includes(char))) return null;
  return text;
}
