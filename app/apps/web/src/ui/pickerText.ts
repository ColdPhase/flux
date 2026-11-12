// What the date and time pickers (DateField, TimeField) say and read: a day is `YYYY-MM-DD` and a time `HH:MM`, as the
// native inputs they replace stored them (#1251). Typed text is read the way people write it ("14 Nov", "9 pm"); showing
// it back is the field's own form, so a typed "9" reads "9:00" at once. Pure functions: no DOM, no React.

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** A day (`YYYY-MM-DD`) from its parts, or null when the calendar has no such day ("31 Nov"). */
export function makeDay(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) || year < 1 || year > 9999) return null;
  const date = new Date(2000, month - 1, day);
  date.setFullYear(year);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
}

export interface Day { year: number; month: number; day: number }
/** The parts of a `YYYY-MM-DD` value, or null when it is not a day. */
export function splitDay(value: string): Day | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return makeDay(day.year, day.month, day.day) === value ? day : null;
}

/** A calendar day as a local `Date` at noon (no time zone or daylight saving shift). */
export function dateOf(value: string): Date {
  const parts = splitDay(value);
  if (!parts) return new Date(NaN);
  const date = new Date(2000, parts.month - 1, parts.day, 12);
  date.setFullYear(parts.year);
  return date;
}
export function dayOf(date: Date): string {
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function addDays(value: string, days: number): string {
  const date = dateOf(value);
  date.setDate(date.getDate() + days);
  return dayOf(date);
}
const daysIn = (year: number, month: number) => (month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31);
/** Months move by calendar, and a day past the end of the new month stays on its last day (31 Jan + 1 month = 28 Feb). */
export function addMonths(value: string, months: number): string {
  const parts = splitDay(value)!;
  const index = parts.year * 12 + (parts.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return makeDay(year, month, Math.min(parts.day, daysIn(year, month))) ?? value;
}
export const today = () => dayOf(new Date());

const fullFormat = () => new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
/** "14 Nov 2026" (the language's own order), as the app names a day everywhere. */
export function formatDay(value: string): string {
  const date = dateOf(value);
  return Number.isNaN(date.getTime()) ? value : fullFormat().format(date);
}
/** "Saturday, 14 November 2026", for a screen reader. */
export function spokenDay(value: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(dateOf(value));
}
export function monthTitle(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(dateOf(value));
}
/** The weekday names, short and long, from the first day of the week (1 Monday … 7 Sunday). */
export function weekdays(firstDay: number): { short: string; long: string }[] {
  const short = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
  const long = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  return Array.from({ length: 7 }, (_, index) => {
    // 2000-01-03 was a Monday.
    const date = new Date(2000, 0, 3 + ((firstDay - 1 + index) % 7), 12);
    return { short: short.format(date).replace(/\.$/, ''), long: long.format(date) };
  });
}
/** The language's first day of the week, 1 (Monday) to 7 (Sunday); Monday when the browser does not say. */
export function firstWeekday(): number {
  try {
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const info = locale.getWeekInfo?.() ?? locale.weekInfo;
    if (info && info.firstDay >= 1 && info.firstDay <= 7) return info.firstDay;
  } catch { /* An older browser: Monday. */ }
  return 1;
}

const wordsOf = (text: string) => text.toLowerCase().replace(/\./g, '. ').replace(/(\d)(st|nd|rd|th)\b/g, '$1').replace(/[,]/g, ' ').trim().split(/\s+/).filter(Boolean);

/**
 * The month names a person may type: English and the browser's language, each as the month alone (nominative) and as the language
 * writes it after a day ("listopad", "listopada"); three letters or more of one count.
 */
function monthNames(): string[][] {
  const english = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const names = english.map((name) => [name]);
  try {
    const alone = new Intl.DateTimeFormat(undefined, { month: 'long' });
    const withDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' });
    for (let index = 0; index < 12; index += 1) {
      const date = new Date(2000, index, 15);
      names[index]!.push(alone.format(date).toLowerCase());
      const after = withDay.formatToParts(date).find((part) => part.type === 'month')?.value.toLowerCase();
      if (after) names[index]!.push(after);
    }
  } catch { /* English only. */ }
  return names;
}
const monthOf = (word: string): number => {
  const bare = word.replace(/\.$/, '');
  if (bare.length < 3) return 0;
  const names = monthNames();
  for (let index = 0; index < 12; index += 1) {
    if (names[index]!.some((name) => name.startsWith(bare) || (bare === 'sept' && name.startsWith('sep')))) return index + 1;
  }
  return 0;
};

/** Whether the language writes the month before the day ("11/14/2026"), for numbers like "5/6". */
function monthFirst(): boolean {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric' }).formatToParts(new Date(2000, 10, 25));
    return parts.findIndex((part) => part.type === 'month') < parts.findIndex((part) => part.type === 'day');
  } catch { return false; }
}

const fullYear = (text: string) => (text.length <= 2 ? 2000 + Number(text) : Number(text));

/**
 * A day from what a person types, or null: "14 Nov", "14 November 2026", "Nov 14, 2026", "14.11", "14/11/2026", "2026-11-14",
 * "today", "tomorrow". Without a year it is the next time that day comes: today's date is today, and a date that has passed this
 * year is next year's ("5 Jan" typed in December is in January). `now` is for tests.
 */
export function parseDay(input: string, now: Date = new Date()): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (text === 'today') return dayOf(now);
  if (text === 'tomorrow') return addDays(dayOf(now), 1);
  if (text === 'yesterday') return addDays(dayOf(now), -1);
  const asOf = dayOf(now);
  const year = now.getFullYear();
  /** A day without a year: this year's if it has not passed, else the first later year that has it (29 Feb waits for a leap year). */
  const upcoming = (month: number, day: number): string | null => {
    for (let ahead = 0; ahead <= 8; ahead += 1) {
      const found = makeDay(year + ahead, month, day);
      if (found && found >= asOf) return found;
    }
    return null;
  };
  let match = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(text);
  if (match) return makeDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-./\s](\d{1,2})(?:[-./\s](\d{2}|\d{4}))?\.?$/.exec(text);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const dayFirst = first > 12 || (second <= 12 && !monthFirst());
    const [day, month] = dayFirst ? [first, second] : [second, first];
    return match[3] ? makeDay(fullYear(match[3]), month, day) : upcoming(month, day);
  }
  // Words: a month name, a day and maybe a year, in either order.
  const words = wordsOf(text);
  let month = 0;
  const numbers: string[] = [];
  for (const word of words) {
    if (/^\d+$/.test(word)) numbers.push(word);
    else if (!month && monthOf(word)) month = monthOf(word);
    else return null;
  }
  if (!month || numbers.length < 1 || numbers.length > 2) return null;
  const dayText = numbers.find((number) => number.length <= 2);
  const yearText = numbers.find((number) => number !== dayText) ?? null;
  if (!dayText || (numbers.length === 2 && !yearText)) return null;
  if (yearText && yearText.length !== 4 && yearText.length !== 2) return null;
  return yearText ? makeDay(fullYear(yearText), month, Number(dayText)) : upcoming(month, Number(dayText));
}

// ---------------------------------------------------------------- times

/** A time (`HH:MM`) from its parts, or null. */
export function makeTime(hours: number, minutes: number): string | null {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}
/** "9:00": as the app writes a clock time everywhere (no leading zero on the hour, 24 hours). */
export const formatTime = (value: string) => (/^\d{2}:\d{2}$/.test(value) ? value.replace(/^0(\d)/, '$1') : value);

/**
 * A time from what a person types, or null: "9:00", "9", "9.30", "0930", "21:15", "9 pm", "9:30am", "12am", "noon",
 * "midnight". 12-hour forms need an am or pm; without one the hour is read on the 24-hour clock.
 */
export function parseTime(input: string): string | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  if (text === 'noon') return '12:00';
  if (text === 'midnight') return '00:00';
  const match = /^(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?$/.exec(text) ?? /^(\d{1,2})(\d{2})\s*(?:([ap])\.?\s*m?\.?)?$/.exec(text);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3];
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === 'p' ? 12 : 0);
  }
  return makeTime(hours, minutes);
}

/** The day's 30-minute steps, 00:00 to 23:30, with `extra` (a time off the half hour) in its place. */
export function timeSteps(extra?: string): string[] {
  const steps = Array.from({ length: 48 }, (_, index) => `${pad(Math.floor(index / 2))}:${index % 2 ? '30' : '00'}`);
  if (extra && /^\d{2}:\d{2}$/.test(extra) && !steps.includes(extra)) {
    steps.push(extra);
    steps.sort();
  }
  return steps;
}
