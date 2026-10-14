const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

/** "now", "12 min", the time today, or the day. */
export function when(iso: string, now = new Date()) {
  const date = new Date(iso);
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes} min`;
  if (date.toDateString() === now.toDateString()) return time.format(date);
  return day.format(date);
}

/** How long ago, in the words the design uses for a blocked task: "2 days". */
export function ago(iso: string, now = new Date()) {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return minutes < 1 ? 'just now' : `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day' : `${days} days`;
}

/** Tomorrow at 08:00 local time. */
export function tomorrowMorning(now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date;
}

/** The next Monday at 08:00 local time (a week away at most). */
export function nextWeek(now = new Date()) {
  const date = new Date(now);
  const ahead = ((8 - date.getDay()) % 7) || 7;
  date.setDate(date.getDate() + ahead);
  date.setHours(8, 0, 0, 0);
  return date;
}
