import { UNLOCK_PASSWORD_MIN_GUESSES_LOG10, UNLOCK_PASSWORD_MIN_LENGTH } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import type { PasswordEstimator } from './ports.js';

/**
 * The unlock password rule (F-030 Password strength): at least 20 characters after NFC normalisation **and** a strength
 * estimate of at least 10^17 guesses. The generated six-word passphrase passes both. Returns the normalised password.
 */
export function unlockPassword(value: unknown, estimator: PasswordEstimator): string {
  if (typeof value !== 'string' || value.length > 1024) throw new InvalidInputError('An unlock password is text of at most 1024 characters', 'PASSWORD_TOO_WEAK');
  const password = value.normalize('NFC');
  const weak = () => new InvalidInputError(`Use at least ${UNLOCK_PASSWORD_MIN_LENGTH} characters that are hard to guess, for example the six words suggested.`, 'PASSWORD_TOO_WEAK');
  if ([...password].length < UNLOCK_PASSWORD_MIN_LENGTH) throw weak();
  if (!(estimator.guessesLog10(password) >= UNLOCK_PASSWORD_MIN_GUESSES_LOG10)) throw weak();
  return password;
}

/** A secret as typed for a check (no strength rule): bounded text, NFC. */
export function typedSecret(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 ? value.normalize('NFC') : null;
}
