import type { LastActiveAt } from '@flux/contracts';
import { lastActiveWords } from './lastActive';
import './last-active.css';

/**
 * The quiet second line of a person's row (#1225, C-58; final design, Last active): the email where the row has one and when they were last active,
 * as one line in `--t3`. Someone active within five minutes has the small mark before "Active now". Nothing is drawn when there is neither.
 * It is read again with the page, never by a timer.
 */
export function PersonLine({ email, lastActiveAt }: { email?: string | null; lastActiveAt?: LastActiveAt }) {
  const words = lastActiveAt ? lastActiveWords(lastActiveAt) : null;
  if (!email && !words) return null;
  return (
    <span className="lastactive-line">
      {email}
      {/* The dot goes with the words after it, so a line never ends on "·" (round 14, the narrow People and encryption panel). */}
      {email && words ? ' ' : null}
      {words ? (
        <span className="lastactive-tail">
          {email ? <span className="lastactive-sep" aria-hidden="true">·{'\u00a0'}</span> : null}
          <span className="lastactive" data-last-active={words.now ? 'now' : 'earlier'}>
            {words.now ? <span className="lastactive__now" aria-hidden="true" /> : null}
            {words.bare ? <span className="ui-vh">Last active </span> : null}
            {words.text}
          </span>
        </span>
      ) : null}
    </span>
  );
}
