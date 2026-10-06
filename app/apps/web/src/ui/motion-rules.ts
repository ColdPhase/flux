/**
 * Motion rules (#155, Studio 11.6 UI116-5), kept free of the DOM so views and unit tests share them.
 * Motion reinforces a state change after input or a genuine arrival; it never delays or blocks.
 */

/** Where a looping mark is: a hidden page, an element off screen or one covered by a modal. */
export interface LoopState { hidden: boolean; intersecting: boolean; obscured: boolean }

/** A looping mark (an active run, a live session) runs only while it can be seen. */
export const loopShouldRun = ({ hidden, intersecting, obscured }: LoopState): boolean => !hidden && intersecting && !obscured;

/**
 * The entries that genuinely arrived since the previous render: ids not shown before that come after
 * the newest entry that was. The first render (restored history), earlier history joining above (a link,
 * "Load earlier") and a window with nothing in common (another conversation) never count.
 */
export function arrivals(previous: readonly string[] | null, next: readonly string[]): string[] {
  if (!previous?.length) return [];
  const seen = new Set(previous);
  let last = -1;
  next.forEach((id, index) => { if (seen.has(id)) last = index; });
  if (last < 0) return [];
  return next.slice(last + 1).filter((id) => !seen.has(id));
}

/** Where an arrived entry is when it arrives. */
export interface ArrivalState { reduced: boolean; hidden: boolean; visible: boolean; obscured: boolean }

/**
 * An arrival is animated only for content the reader can see as it arrives: not with reduced motion,
 * in a hidden page, below or above the visible part of the feed, or under a modal.
 */
export const arrivalShouldAnimate = ({ reduced, hidden, visible, obscured }: ArrivalState): boolean => !reduced && !hidden && visible && !obscured;

/** The quiet "new below" line for a reader who is reading earlier content (UI116-5 New messages). */
export function newBelowText(messages: number, tasks: number): string {
  const parts = [messages ? `${messages} new ${messages === 1 ? 'message' : 'messages'}` : null, tasks ? `${tasks} new ${tasks === 1 ? 'task' : 'tasks'}` : null];
  return parts.filter(Boolean).join(' · ');
}

/**
 * A CSS <time> as milliseconds (#264). The production build minifies `180ms` to `.18s`, so a bare
 * parseFloat read the drawer's 180 ms as 0.18 ms and every script-driven motion jumped in one frame.
 * Anything that is not a number with `ms` or `s` is 0, so motion stays off rather than misbehaving.
 */
export function cssTimeToMs(value: string): number {
  const match = /^\s*(-?(?:\d+\.?\d*|\.\d+))(ms|s)\s*$/i.exec(value);
  if (!match) return 0;
  const amount = Number(match[1]) * (match[2]!.toLowerCase() === 's' ? 1000 : 1);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
