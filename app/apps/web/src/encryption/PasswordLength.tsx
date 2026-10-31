import { MIN_DISTINCT_CHARACTERS, MIN_PASSWORD_LENGTH, lengthOf, type PasswordCheck } from './passphrase';

/** What to say about a password the person types, before anything is sent: the rule the server enforces, in words. */
export function passwordAdvice(check: PasswordCheck): string {
  if (!check.length) return `At least ${MIN_PASSWORD_LENGTH} characters. A few unrelated words work well.`;
  if (check.problem === 'short') return `${check.length} of ${MIN_PASSWORD_LENGTH} characters.`;
  if (check.problem === 'few-different') return `Use at least ${MIN_DISTINCT_CHARACTERS} different characters.`;
  if (check.problem === 'patterned') return `${check.length} characters, but they follow a pattern that is easy to guess. Mix it up, or use six random words.`;
  const level = lengthOf(check);
  return level === 'very-long' ? `${check.length} characters. Very long.` : level === 'long' ? `${check.length} characters. Long.` : `${check.length} characters. Long enough; longer is stronger.`;
}

/** The refusal a form shows in place when the person submits a password that does not meet the rule. */
export function passwordRefusal(check: PasswordCheck): string {
  if (check.problem === 'short') return `Use at least ${MIN_PASSWORD_LENGTH} characters. Yours has ${check.length}.`;
  if (check.problem === 'few-different') return `Use at least ${MIN_DISTINCT_CHARACTERS} different characters. Yours has ${check.distinct}.`;
  return 'That follows a pattern that is easy to guess. Mix it up, or use six random words.';
}

/** How long the typed password is, in words and a small bar: it measures length, which is all a form can honestly say. */
export function PasswordLength({ id, check }: { id: string; check: PasswordCheck }) {
  const level = lengthOf(check);
  const filled = level === 'short' ? 0 : level === 'long-enough' ? 1 : level === 'long' ? 2 : 3;
  return (
    <div className="newspace__length" id={id} data-length={level}>
      <span className="newspace__meter" aria-hidden="true">{[1, 2, 3].map((n) => <i key={n} className={n <= filled ? 'is-on' : undefined} />)}</span>
      <span>{passwordAdvice(check)}</span>
    </div>
  );
}
