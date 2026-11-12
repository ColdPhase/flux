// One formatter for every message's hover title: `toLocaleString` with options builds a new ICU formatter on each call, which
// at a screenful of messages was the largest single cost of opening a conversation on a phone (#716).
const stampFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function when(iso: string) { return stampFormat.format(new Date(iso)); }
// A natural clock as drawn ("11:02", or "4:55 PM" in a 12-hour locale), never a zero-padded "04:55 PM" (#436).
const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
export function clock(iso: string) { return clockFormat.format(new Date(iso)); }
export function day(iso: string) {
  const date = new Date(iso);
  return new Date().toDateString() === date.toDateString() ? 'Today' : dayFormat.format(date);
}
