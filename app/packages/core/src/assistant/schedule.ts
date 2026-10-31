import { ASSISTANT_WORK_WINDOW, type AssistantJobSchedule } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';

// The time of a schedule (F-027 AST-7 "When"): pure functions. A schedule is a kind with its fields, or a five-field
// cron expression under *More*. All of them become the same set of minutes, hours, days, months and weekdays, and the
// next times are found on the owner's calendar in their own time zone. A time that does not exist on a day (clocks
// jump forward) runs at the first valid minute after the gap; a repeated time runs once, at its first occurrence.

export const TOO_OFTEN = 'At most once an hour';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** How far ahead a search looks: a cron on 29 February is found within the next leap cycle. */
const SEARCH_DAYS = 366 * 4 + 1;

/** The calendar a schedule fires on. Weekdays are 0 (Sunday) to 6; `domAny` and `dowAny` mean the field was `*`. */
export interface CronFields {
  minutes: number[]; hours: number[]; days: number[]; months: number[]; weekdays: number[]; domAny: boolean; dowAny: boolean;
}

const invalid = (message: string) => new InvalidInputError(message, 'ASSISTANT_JOB_INVALID_SCHEDULE');

function range(min: number, max: number) { return Array.from({ length: max - min + 1 }, (_, index) => min + index); }

function fieldValues(field: string, min: number, max: number, names: readonly string[] | null, label: string): number[] {
  const out = new Set<number>();
  const number = (token: string): number => {
    const named = names ? names.findIndex((name) => name.toLowerCase() === token.toLowerCase()) : -1;
    if (named >= 0) return named + (label === 'month' ? 1 : 0);
    if (!/^\d{1,3}$/.test(token)) throw invalid(`The ${label} "${token}" is not valid`);
    return Number(token);
  };
  for (const part of field.split(',')) {
    if (!part) throw invalid(`The ${label} field is empty`);
    const [spanText, stepText, extra] = part.split('/');
    if (extra !== undefined) throw invalid(`The ${label} "${part}" is not valid`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (stepText !== undefined && (!/^\d{1,3}$/.test(stepText) || step < 1)) throw invalid(`The step in "${part}" is not valid`);
    let from: number; let to: number;
    if (spanText === '*') { from = min; to = max; }
    else if (spanText!.includes('-')) {
      const [a, b, more] = spanText!.split('-');
      if (more !== undefined || !a || !b) throw invalid(`The ${label} "${part}" is not valid`);
      from = number(a); to = number(b);
    } else { from = number(spanText!); to = stepText === undefined ? from : max; }
    // Day of week: 7 also means Sunday.
    const top = label === 'weekday' ? 7 : max;
    if (from < min || to > top || from > to) throw invalid(`The ${label} "${part}" is outside ${min}–${max}`);
    for (let value = from; value <= to; value += step) out.add(label === 'weekday' && value === 7 ? 0 : value);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parses a five-field cron expression: minute, hour, day of month, month, day of week. */
export function parseCron(expression: string): CronFields {
  if (typeof expression !== 'string' || expression.length > 100) throw invalid('That is not a schedule Flux can read');
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw invalid('Use five fields: minute, hour, day of month, month, day of week');
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  return {
    minutes: fieldValues(minute, 0, 59, null, 'minute'), hours: fieldValues(hour, 0, 23, null, 'hour'),
    days: fieldValues(day, 1, 31, null, 'day'), months: fieldValues(month, 1, 12, MONTH_NAMES.map((name) => name.toLowerCase()), 'month'),
    weekdays: fieldValues(weekday, 0, 6, SHORT_WEEKDAYS.map((name) => name.toLowerCase()), 'weekday'),
    domAny: day === '*' || day.startsWith('*/'), dowAny: weekday === '*' || weekday.startsWith('*/'),
  };
}

const clock = /^([01]?\d|2[0-3]):([0-5]\d)$/;
/** "09:30" to minutes after midnight. */
export function parseClock(value: unknown, label = 'time'): number {
  const match = typeof value === 'string' ? clock.exec(value) : null;
  if (!match) throw invalid(`The ${label} must be a time like 09:00`);
  return Number(match[1]) * 60 + Number(match[2]);
}
const pad = (value: number) => String(value).padStart(2, '0');
/** "9:00": hours without a leading zero, as the app writes times everywhere. */
export const shortClock = (minutes: number) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`;

/** The calendar of any recurring schedule; null for a one-off. Throws a plain refusal for a schedule that cannot be read. */
export function scheduleFields(schedule: AssistantJobSchedule): CronFields | null {
  switch (schedule.kind) {
    case 'daily': case 'weekdays': case 'weekly': {
      const at = parseClock(schedule.at);
      const weekday = schedule.kind === 'weekly' ? Number(schedule.weekday) : null;
      if (weekday !== null && (!Number.isInteger(weekday) || weekday < 1 || weekday > 7)) throw invalid('Choose a day of the week');
      return { minutes: [at % 60], hours: [Math.floor(at / 60)], days: range(1, 31), months: range(1, 12),
        weekdays: schedule.kind === 'daily' ? range(0, 6) : schedule.kind === 'weekdays' ? [1, 2, 3, 4, 5] : [weekday! % 7],
        domAny: true, dowAny: schedule.kind === 'daily' };
    }
    case 'hourly': {
      const from = parseClock(schedule.from, 'start'); const to = parseClock(schedule.to, 'end');
      if (to < from) throw invalid('The end of the day\'s window must be after its start');
      const hours = range(Math.floor(from / 60), Math.floor(to / 60)).filter((hour) => hour * 60 + (from % 60) <= to);
      return { minutes: [from % 60], hours, days: range(1, 31), months: range(1, 12), weekdays: [1, 2, 3, 4, 5], domAny: true, dowAny: false };
    }
    case 'cron': {
      const fields = parseCron(schedule.cron);
      // The one-hour minimum of Anthropic's own Routines (AST-7 "Spacing and caps"): more than one minute fires twice in an hour.
      if (fields.minutes.length > 1) throw new InvalidInputError(TOO_OFTEN, 'ASSISTANT_JOB_TOO_OFTEN');
      return fields;
    }
    case 'once': return null;
    default: throw invalid('Choose how often it should run');
  }
}

interface Zone { format: Intl.DateTimeFormat }
function zoneOf(timeZone: string): Zone {
  return { format: new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) };
}
/** The local calendar of `instant`, encoded in UTC solely for calendar arithmetic (the number is not an instant). */
function civil(zone: Zone, instant: number): number {
  const parts = zone.format.formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((value) => value.type === type)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
}
/** The instant of a local `civilDay` (midnight in civil encoding) at `minutes`: first occurrence; a gap resolves to its end; null for a skipped date. */
function localInstant(zone: Zone, civilDay: number, minutes: number): number | null {
  const target = civilDay + minutes * MINUTE;
  const offsets = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = target + hours * HOUR;
    offsets.add(civil(zone, instant) - instant);
  }
  const candidates = [...offsets].map((offset) => target - offset).sort((a, b) => a - b);
  for (const instant of candidates) if (civil(zone, instant) === target) return instant;
  for (let instant = candidates[0]!; instant <= candidates[candidates.length - 1]!; instant += MINUTE) {
    const value = civil(zone, instant);
    if (value >= target && value < civilDay + DAY) return instant;
  }
  return null;
}

/** Whether `day` (a civil date at midnight) is one of the schedule's days; vixie semantics for day of month and week. */
function dayMatches(fields: CronFields, day: number): boolean {
  const date = new Date(day);
  if (!fields.months.includes(date.getUTCMonth() + 1)) return false;
  const dom = fields.days.includes(date.getUTCDate());
  const dow = fields.weekdays.includes(date.getUTCDay());
  // As cron has always read it: with `*` in either field both must match; with neither, either one does.
  return fields.domAny || fields.dowAny ? dom && dow : dom || dow;
}

/** The next `count` times strictly after `after`, on the owner's calendar. */
export function nextRuns(schedule: AssistantJobSchedule, timeZone: string, after: Date, count: number): Date[] {
  if (schedule.kind === 'once') {
    const at = new Date(schedule.at);
    return !Number.isNaN(at.getTime()) && at.getTime() > after.getTime() && count > 0 ? [at] : [];
  }
  const fields = scheduleFields(schedule)!;
  const zone = zoneOf(timeZone);
  const start = civil(zone, after.getTime());
  const first = Math.floor(start / DAY) * DAY;
  const found: Date[] = [];
  for (let offset = 0; offset < SEARCH_DAYS && found.length < count; offset++) {
    const day = first + offset * DAY;
    if (!dayMatches(fields, day)) continue;
    for (const hour of fields.hours) for (const minute of fields.minutes) {
      const instant = localInstant(zone, day, hour * 60 + minute);
      if (instant !== null && instant > after.getTime() && !found.some((item) => item.getTime() === instant)) found.push(new Date(instant));
    }
    found.sort((a, b) => a.getTime() - b.getTime());
  }
  return found.slice(0, count);
}

const dayFormat = (timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
/** "Mon 9:00" within a week of `now`; "Mon 26 Oct 9:00" beyond it; always in the owner's time zone. */
export function timeLabel(at: Date, timeZone: string, now: Date): string {
  const parts = dayFormat(timeZone).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)!.value;
  const time = `${Number(part('hour'))}:${part('minute')}`;
  const near = at.getTime() - now.getTime() <= 7 * DAY;
  return near ? `${part('weekday')} ${time}` : `${part('weekday')} ${part('day')} ${part('month')} ${time}`;
}

function days(values: number[]): string {
  const sorted = [...values].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (sorted.length === 7) return 'every day';
  if (sorted.length === 5 && [1, 2, 3, 4, 5].every((value) => sorted.includes(value))) return 'weekdays';
  if (sorted.length === 2 && sorted.includes(0) && sorted.includes(6)) return 'weekends';
  const names = sorted.map((value) => WEEKDAY_NAMES[value]!);
  return names.length === 1 ? `on ${names[0]}` : `on ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
const listWords = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

/** A schedule in the plain words of the row: "Every Monday at 9:00", "Weekdays at 9:00". */
export function scheduleWords(schedule: AssistantJobSchedule, timeZone: string): string {
  switch (schedule.kind) {
    case 'daily': return `Every day at ${shortClock(parseClock(schedule.at))}`;
    case 'weekdays': return `Weekdays at ${shortClock(parseClock(schedule.at))}`;
    case 'weekly': return `Every ${WEEKDAY_NAMES[Number(schedule.weekday) % 7]} at ${shortClock(parseClock(schedule.at))}`;
    case 'hourly': return `Every hour, weekdays ${shortClock(parseClock(schedule.from))}–${shortClock(parseClock(schedule.to))}`;
    case 'once': {
      const parts = dayFormat(timeZone).formatToParts(new Date(schedule.at));
      const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)!.value;
      return `Once, ${part('weekday')} ${part('day')} ${part('month')} at ${Number(part('hour'))}:${part('minute')}`;
    }
    case 'cron': return cronWords(parseCron(schedule.cron));
  }
}

/** A cron expression back in plain words, for *More*. */
export function cronWords(fields: CronFields): string {
  const minute = fields.minutes[0]!;
  const monthText = fields.months.length === 12 ? '' : ` in ${listWords(fields.months.map((value) => MONTH_NAMES[value - 1]!))}`;
  const everyDay = fields.weekdays.length === 7;
  if (fields.hours.length === 24) {
    const time = minute === 0 ? 'Every hour' : `Every hour at :${pad(minute)}`;
    return `${time}${everyDay && fields.domAny ? '' : `, ${days(fields.weekdays)}`}${monthText}`;
  }
  const times = listWords(fields.hours.map((hour) => shortClock(hour * 60 + minute)));
  if (!fields.domAny) {
    const dayList = `on day ${listWords(fields.days.map(String))} of the month`;
    return `At ${times} ${fields.dowAny ? dayList : `${dayList} or ${days(fields.weekdays)}`}${monthText}`;
  }
  if (fields.hours.length === 1) {
    if (everyDay) return `Every day at ${times}${monthText}`;
    if (fields.weekdays.length === 5 && [1, 2, 3, 4, 5].every((value) => fields.weekdays.includes(value))) return `Weekdays at ${times}${monthText}`;
    if (fields.weekdays.length === 1) return `Every ${WEEKDAY_NAMES[fields.weekdays[0]!]} at ${times}${monthText}`;
  }
  return `At ${times}${everyDay ? ', every day' : ` ${days(fields.weekdays)}`}${monthText}`;
}

/** The next `count` times as ISO instants with their labels. */
export function previewRuns(schedule: AssistantJobSchedule, timeZone: string, now: Date, count = 3) {
  return nextRuns(schedule, timeZone, now, count).map((at) => ({ at: at.toISOString(), label: timeLabel(at, timeZone, now) }));
}

export { ASSISTANT_WORK_WINDOW };
