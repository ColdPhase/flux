import type { LastActiveAt, ProjectPerson } from '@flux/contracts';

// When a person was last active, in the words of the final design (#1225, C-58). The server sends the time already rounded: an instant to the minute
// (under an hour old) or to the hour (under a day old), or a calendar day as `YYYY-MM-DD` (a day old or more, counted in this person's zone).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Within this long, the person is "active now". */
export const ACTIVE_NOW_MS = 5 * MINUTE;

const dayWords = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dayAndYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** The local calendar day of a date, as `YYYY-MM-DD`. */
const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export interface LastActiveWords {
  /** The visible words: "Active now", "Active 12 min ago", "Active 2 h ago", "Yesterday" or "3 Nov". */
  text: string;
  /** Whether the person is active now (within five minutes): the line gets its small mark. */
  now: boolean;
  /** Words that do not say "active" ("Yesterday", "3 Nov") get "Last active" for a screen reader. */
  bare: boolean;
}

/** How long ago the rounded time was, in milliseconds; a calendar day is a day or more by definition. */
function ageOf(value: LastActiveAt, now: Date): number {
  if (DAY_ONLY.test(value)) return Number.POSITIVE_INFINITY;
  return Math.max(0, now.getTime() - new Date(value).getTime());
}

/** Whether the rounded time is within five minutes. */
export const activeNow = (value: LastActiveAt | undefined, now: Date = new Date()) => value !== undefined && ageOf(value, now) < ACTIVE_NOW_MS;

export function lastActiveWords(value: LastActiveAt, now: Date = new Date()): LastActiveWords {
  const age = ageOf(value, now);
  if (age < ACTIVE_NOW_MS) return { text: 'Active now', now: true, bare: false };
  if (age < HOUR) return { text: `Active ${Math.floor(age / MINUTE)} min ago`, now: false, bare: false };
  if (age < DAY) return { text: `Active ${Math.floor(age / HOUR)} h ago`, now: false, bare: false };
  // A day or more: the day itself, in this browser's zone. A day the server named is already in the reader's zone.
  const [year, month, day] = DAY_ONLY.test(value) ? value.split('-').map(Number) as [number, number, number] : [0, 0, 0];
  const date = DAY_ONLY.test(value) ? new Date(year, month - 1, day, 12) : new Date(value);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
  if (dayKey(date) === dayKey(yesterday)) return { text: 'Yesterday', now: false, bare: true };
  return { text: (date.getFullYear() === now.getFullYear() ? dayWords : dayAndYear).format(date), now: false, bare: true };
}

/**
 * The header's faces, people first and an agent last (#1236): the people active now go first, the others keep the order they came in,
 * and the reader counts as active now, being here.
 */
export function activeFirst(people: ProjectPerson[], meId: string, now: Date = new Date()): ProjectPerson[] {
  const humans = people.filter((person) => person.kind === 'human');
  const first = (person: ProjectPerson) => person.id === meId || activeNow(person.lastActiveAt, now);
  return [...humans.filter(first), ...humans.filter((person) => !first(person)), ...people.filter((person) => person.kind !== 'human')];
}
