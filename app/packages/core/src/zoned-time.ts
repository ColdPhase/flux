// A moment as a person's own clock reads it. The model is given times in its owner's time zone, with the offset, so it never has to convert
// from UTC (it converted wrongly: "15:34 Warsaw time" for 14:34, v0.2.1 round 15).

/** A real IANA time zone as written, or `UTC` for one that is not (a browser that said nothing, or a zone this runtime does not know). */
export function knownZone(timeZone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return timeZone;
  } catch {
    return 'UTC';
  }
}

export interface ZonedMoment {
  /** `2026-11-19`. */
  date: string;
  /** `14:34`. */
  clock: string;
  /** `2026-11-19T14:34:12+01:00`: the moment in the zone with its offset at that moment (summer and winter time differ). */
  stamp: string;
}

const pad = (value: number) => String(value).padStart(2, '0');
const formats = new Map<string, Intl.DateTimeFormat>();

/** The moment on the clock of `timeZone`, to the second. */
export function zonedMoment(instant: Date, timeZone: string): ZonedMoment {
  const zone = knownZone(timeZone);
  let format = formats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(instant).map((part) => [part.type, part.value]));
  const local = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  const minutes = Math.round((local - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
  const offset = `${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const clock = `${parts.hour}:${parts.minute}`;
  return { date, clock, stamp: `${date}T${clock}:${parts.second}${offset}` };
}

const UTC_INSTANT = /"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?Z"/g;

/**
 * Every instant a tool's JSON answer names as a whole string in UTC (`"2026-11-19T14:34:12.500Z"`) written in `timeZone` with its offset
 * (`"2026-11-19T15:34:12.500+01:00"`). A person whose zone is UTC reads the answer as it is.
 */
export function instantsInZone(json: string, timeZone: string): string {
  if (knownZone(timeZone) === 'UTC') return json;
  return json.replace(UTC_INSTANT, (whole, seconds: string, fraction: string | undefined) => {
    const instant = new Date(`${seconds}Z`);
    if (Number.isNaN(instant.getTime())) return whole;
    const { stamp } = zonedMoment(instant, timeZone);
    return `"${stamp.slice(0, 19)}${fraction ?? ''}${stamp.slice(19)}"`;
  });
}
