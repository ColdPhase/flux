// When a person was last active, as the people reads present it (#1225, C-58). The reader gets the time already rounded, so no screen and no
// API carries a finer time than the product shows: to the minute under an hour, to the hour under a day, and from a day on only the day, the
// reader's own. Where the person turned it off (`showLastActive`) or has not been active, nothing is returned.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface LastActiveRow {
  lastActiveAt: Date | null;
  showLastActive: boolean;
}

/** Who is asking: the zone the reader's days are counted in (`auth_users.time_zone`, C-57). Without it, a people read carries no time. */
export interface LastActiveOptions {
  timeZone: string;
}

/** The calendar day of an instant in a time zone, as `YYYY-MM-DD`. */
export function localDay(at: Date, timeZone: string): string {
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }); } catch { format = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
  const parts = format.formatToParts(at);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/**
 * The rounded time: an ISO instant floored to the minute (under an hour old) or to the hour (under a day old), or the reader's calendar day as
 * `YYYY-MM-DD` (a day old or more). Rounding only ever makes a time older, so "Active now" is never said of someone who is not.
 */
export function roundedLastActive(row: LastActiveRow, options: LastActiveOptions, now: Date = new Date()): string | undefined {
  if (!row.showLastActive || !row.lastActiveAt) return undefined;
  const at = row.lastActiveAt.getTime();
  const age = Math.max(0, now.getTime() - at);
  if (age < HOUR) return new Date(Math.floor(at / MINUTE) * MINUTE).toISOString();
  if (age < DAY) return new Date(Math.floor(at / HOUR) * HOUR).toISOString();
  return localDay(row.lastActiveAt, options.timeZone);
}
