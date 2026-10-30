import type { TypingView } from './client';
import './typing.css';

/**
 * Static reserved line; only changed text is announced, never an animation loop. While connecting it is empty:
 * "unavailable" is said only after a real failure or timeout, never because the first frame is still on its way.
 */
export function TypingNotice({ availability, people }: TypingView) {
  const names = people.map((person) => person.name);
  const text = availability === 'unavailable' ? 'Typing activity unavailable' : names.length === 1 ? `${names[0]} is typing…`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing…` : names.length > 2 ? `${names[0]} and ${names.length - 1} others are typing…` : '';
  return <p className="typing-notice" role="status" aria-live="polite" aria-atomic="true" title={text} data-availability={availability}>{text || '\u00a0'}</p>;
}
