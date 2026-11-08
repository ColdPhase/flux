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

/**
 * Whether a canonical code is a pattern rather than 160 random bits (#980): fewer than 12 different characters, a run of eight or
 * more characters that step through the alphabet by the same amount (the alphabet in order, backwards, every second character, one
 * character repeated), or one block repeated to fill the code. A random code is none of these but once in billions.
 */
export function isPatternedRecoveryCode(code: string): boolean {
  if (new Set(code).size < 12) return true;
  const steps = [...code].map((char, at) => (at === 0 ? 0 : (ALPHABET.indexOf(char) - ALPHABET.indexOf(code[at - 1]!) + 32) % 32));
  let run = 1;
  for (let at = 2; at < steps.length; at++) {
    run = steps[at] === steps[at - 1] ? run + 1 : 1;
    if (run >= 7) return true;
  }
  for (let period = 1; period <= code.length / 2; period++) if (code.slice(period) === code.slice(0, code.length - period)) return true;
  return false;
}
