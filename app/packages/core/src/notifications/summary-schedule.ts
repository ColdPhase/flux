const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LATE_WINDOW = 180 * MINUTE;

/**
 * A civil date/time encoded in UTC solely for calendar arithmetic. This number is not the
 * actual instant in the person's time zone. Whole minutes are enough for a HH:MM schedule.
 */
function civilMinute(formatter: Intl.DateTimeFormat, instant: number): number {
  const parts = formatter.formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((value) => value.type === type)!.value);
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
}

function dayOf(civil: number): number {
  return Math.floor(civil / DAY) * DAY;
}

/**
 * Resolve a local HH:MM on a calendar date. The first occurrence wins when clocks repeat;
 * a nonexistent time resolves to the first valid minute after the gap on that date.
 */
function scheduledInstant(formatter: Intl.DateTimeFormat, day: number, summaryAt: number): number | null {
  const target = day + summaryAt * MINUTE;
  const offsets = new Set<number>();
  // Nearby instants give the zone's offsets on both sides of a transition, including zones
  // whose change is not an hour. Sampling avoids scanning every minute of each person's day.
  for (let hours = -36; hours <= 36; hours += 6) {
    const instant = target + hours * HOUR;
    offsets.add(civilMinute(formatter, instant) - instant);
  }
  const candidates = [...offsets].map((offset) => target - offset).sort((left, right) => left - right);
  for (const instant of candidates) {
    if (civilMinute(formatter, instant) === target) return instant;
  }

  // Only gap dates need this bounded scan between the offset-derived candidates. For an
  // ordinary DST gap that is 30 or 60 minutes, not a whole day. A wholly skipped calendar
  // date has no valid minute and is never assigned a fabricated occurrence.
  for (let instant = candidates[0]!; instant <= candidates[candidates.length - 1]!; instant += MINUTE) {
    const civil = civilMinute(formatter, instant);
    if (civil >= target && civil < day + DAY) return instant;
  }
  return null;
}

/**
 * The most recent scheduled local date still within its three-hour elapsed-time window.
 * A 23:59 summary caught by the 00:00 tick belongs to yesterday. Preferences and the
 * durable once-per-day claim are checked by the caller, using its current transaction.
 */
export function scheduledSummaryDay(summaryAt: number, timeZone: string, now: Date): string | null {
  const instant = now.getTime();
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const today = dayOf(civilMinute(formatter, instant));
  const days = new Set([today, today - DAY, dayOf(civilMinute(formatter, instant - LATE_WINDOW))]);
  // The third date covers an offset change that skips a calendar date: the last real
  // scheduled occurrence may still be recent even though its local date is two days back.
  let latest: { day: number; at: number } | null = null;
  for (const day of days) {
    const at = scheduledInstant(formatter, day, summaryAt);
    if (at === null || at > instant || instant - at >= LATE_WINDOW) continue;
    if (latest === null || at > latest.at) latest = { day, at };
  }
  return latest === null ? null : new Date(latest.day).toISOString().slice(0, 10);
}
