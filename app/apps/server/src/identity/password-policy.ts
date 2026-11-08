import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as zxcvbnCommon from '@zxcvbn-ts/language-common';
import * as zxcvbnEnglish from '@zxcvbn-ts/language-en';

/**
 * Which passwords a password account may choose (#990, OWASP ASVS 4.0.3 V2.1.7). The length is Better Auth's own rule
 * (`minPasswordLength`/`maxPasswordLength`, from `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH`); this adds two refusals, both from data that
 * ships with the server, with no call out of the process (a breached-password service would send a hash of every new password to a third party):
 *
 * - the password is on `@zxcvbn-ts`'s list of the most common passwords (49,233 entries, far above the 3,000 ASVS asks for), compared
 *   without regard to case or Unicode form; and
 * - `@zxcvbn-ts` estimates fewer than 10^8 guesses (its score 3 or more is required). That catches what a plain list cannot: `password1234`,
 *   `qwertyuiopas`, a word with a year, a keyboard walk, a repeated pattern, and words from the person's own name or address;
 *   a password that is only the name or address with a few characters added is refused outright.
 *
 * Nothing else is required of the characters (NIST SP 800-63B: no composition rules). A phrase of a few unrelated words passes.
 */
const MIN_SCORE = 3;

const dictionary = { ...zxcvbnCommon.dictionary, ...zxcvbnEnglish.dictionary };
const common = new Set((zxcvbnCommon.dictionary['passwords-common'] as (string | number)[]).map((word) => String(word).normalize('NFKC').toLowerCase()));
let estimator: ZxcvbnFactory | undefined;
const estimate = () => estimator ??= new ZxcvbnFactory({ dictionary, graphs: zxcvbnCommon.adjacencyGraphs, translations: zxcvbnEnglish.translations });

export type PasswordProblem = 'common' | 'guessable';

/**
 * Why this password is refused, or null. `personal` is what the person's account says about them (name, address): a password built from it is
 * easy to guess. Call it only for a password that already passed the length rule.
 */
export function passwordProblem(password: string, personal: readonly string[] = []): PasswordProblem | null {
  const folded = password.normalize('NFKC').toLowerCase();
  if (common.has(folded)) return 'common';
  // The name, the address or its part before the @ with at most a few characters around it (`ada2024`) is that identifier, not a secret.
  // A sentence that happens to contain a name has more around it and is left to the estimate below.
  const letters = folded.replace(/[^\p{L}\p{N}]+/gu, '');
  const known = personal.flatMap((value) => [value, value.split('@')[0]!]).map((value) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')).filter((value) => value.length >= 4);
  if (known.some((value) => letters.includes(value) && letters.length - value.length <= 6)) return 'guessable';
  const inputs = personal.flatMap((value) => [value, ...value.split(/[^\p{L}\p{N}]+/u)]).map((value) => value.trim().toLowerCase()).filter((value) => value.length >= 3);
  return estimate().check(password, inputs).score < MIN_SCORE ? 'guessable' : null;
}

/** The words the person sees (the form shows the server's message beneath the field). */
export const PASSWORD_TOO_WEAK_MESSAGE = 'That password is too easy to guess. Use a longer phrase of unrelated words, not a common password or something built from your name or email.';
