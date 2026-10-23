// The unlock password of an encrypted workspace (F-030, #655): a generated six-word passphrase by default, or the
// person's own (at least 20 characters). Nothing here stores anything; the password lives in the form that asked for it.

/** The server's rule (`400 PASSWORD_TOO_WEAK`), repeated in the form: at least 20 characters after NFC, with at least 8 different ones. */
export const MIN_PASSWORD_LENGTH = 20;
export const MIN_DISTINCT_CHARACTERS = 8;
/** Six words from 7,776 are 77 bits. */
export const PASSPHRASE_WORDS = 6;

const characters = (password: string) => Array.from(password.normalize('NFC'));

export interface PasswordCheck {
  length: number;
  distinct: number;
  /** The first rule not met, or null when the password is long enough. */
  problem: 'short' | 'few-different' | 'patterned' | null;
}

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

/**
 * A password that follows an obvious pattern, which the server's estimate (zxcvbn, at least 10^17 guesses) refuses however long it
 * is: one short block repeated ("abcdefghabcdefghabcd"), or a run along the alphabet, the digits or a keyboard row. This is not
 * that estimate (the browser does not carry its dictionaries yet); it explains the plainest refusals before anything is sent. The
 * server decides, and a refusal it makes is shown as it is.
 */
export function followsPattern(password: string): boolean {
  const text = characters(password.normalize('NFC').toLowerCase()).join('');
  if (text.length < 8) return false;
  // One block of one to twelve characters, repeated to fill at least three quarters of the password.
  for (let size = 1; size <= 12 && size * 2 <= text.length; size += 1) {
    const unit = text.slice(0, size);
    let covered = 0;
    while (text.startsWith(unit, covered)) covered += size;
    if (covered >= text.length * 0.75) return true;
  }
  // Mostly steps to the next or the previous character of the alphabet, the digits or a keyboard row.
  const letters = Array.from(text);
  const neighbours = (a: string, b: string) => Math.abs(a.codePointAt(0)! - b.codePointAt(0)!) === 1
    || KEYBOARD_ROWS.some((row) => { const at = row.indexOf(a); return at >= 0 && (row[at + 1] === b || row[at - 1] === b); });
  const steps = letters.slice(1).filter((letter, index) => neighbours(letters[index]!, letter)).length;
  return steps >= (letters.length - 1) * 0.7;
}

export function checkPassword(password: string): PasswordCheck {
  const list = characters(password);
  const distinct = new Set(list).size;
  const problem = list.length < MIN_PASSWORD_LENGTH ? 'short' : distinct < MIN_DISTINCT_CHARACTERS ? 'few-different' : followsPattern(password) ? 'patterned' : null;
  return { length: list.length, distinct, problem };
}

/** How long a password is, in words a person can use: it measures length only, never "strength" it cannot know. */
export type PasswordLength = 'short' | 'long-enough' | 'long' | 'very-long';
export function lengthOf(check: PasswordCheck): PasswordLength {
  // A password that is long but patterned is not "long enough" for anything.
  if (check.problem) return 'short';
  return check.length >= 36 ? 'very-long' : check.length >= 28 ? 'long' : 'long-enough';
}

/** A uniform integer below `max` from random 32-bit words, rejecting the biased tail instead of using a remainder alone. */
export function randomBelow(max: number, fill: (words: Uint32Array) => void = (words) => { crypto.getRandomValues(words); }): number {
  if (!Number.isInteger(max) || max < 1 || max > 2 ** 32) throw new RangeError('max must be an integer from 1 to 2^32');
  const limit = Math.floor(2 ** 32 / max) * max;
  const word = new Uint32Array(1);
  for (;;) {
    fill(word);
    if (word[0]! < limit) return word[0]! % max;
  }
}

/** Splits the module's word string into the list. */
export const wordsOf = (list: string) => list.trim().split(/\s+/);

/** Six random words, separated by a space. Draws again in the rare case the result would not meet the password rule. */
export function generatePassphrase(words: readonly string[], count = PASSPHRASE_WORDS, below: (max: number) => number = randomBelow): string {
  if (!words.length) throw new RangeError('The word list is empty');
  for (;;) {
    const phrase = Array.from({ length: count }, () => words[below(words.length)]!).join(' ');
    if (!checkPassword(phrase).problem) return phrase;
  }
}

/** The wordlist is its own chunk: only the creation form loads it, and only when asked. */
let list: Promise<string[]> | undefined;
export function loadWords(): Promise<string[]> {
  list ??= import('./eff-large-wordlist.js').then((module) => wordsOf(module.EFF_LARGE_WORDLIST), (error: unknown) => { list = undefined; throw error; });
  return list;
}

/** A recovery code as it is shown: 32 characters in groups of four, separated by a hyphen. A code of another shape is shown as it is. */
export function groupRecoveryCode(code: string): string[] {
  const plain = code.replace(/[\s-]/g, '').toUpperCase();
  return plain.length === 32 ? plain.match(/.{4}/g)! : [code];
}
