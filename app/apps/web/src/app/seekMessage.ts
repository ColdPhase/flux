/**
 * Opening a conversation at one message (a search result or a source link, #114): when that
 * message is older than the loaded window, page back until it is loaded, so the view shows the
 * exact message rather than the latest ones. The server authorizes every page as usual.
 */
export interface MessagePage<T> { messages: T[]; messagePage: { nextBeforeSequence: number | null } }

const PAGE = 100;
/** At most this many pages (10,000 messages) are read to reach one message. */
const MAX_PAGES = 100;

export async function pageBackTo<T extends { id: string }, P extends MessagePage<T>>(
  target: string, cursor: number | null, fetchPage: (beforeSequence: number, limit: number) => Promise<P>,
): Promise<{ pages: P[]; cursor: number | null; found: boolean }> {
  const pages: P[] = [];
  let next = cursor;
  for (let index = 0; index < MAX_PAGES && next; index += 1) {
    const page = await fetchPage(next, PAGE);
    pages.push(page);
    next = page.messagePage.nextBeforeSequence;
    if (page.messages.some((message) => message.id === target)) return { pages, cursor: next, found: true };
  }
  return { pages, cursor: next, found: false };
}

/**
 * Focuses the message a link opened (#114), retrying for a moment while it cannot take focus yet: a closing
 * dialog keeps the page behind it inert until its exit animation ends, and then hands focus back to whatever
 * it was opened from. Stops once the message has focus, when it leaves the page, or when the person moves
 * focus somewhere new (a field or another dialog) while it waits.
 */
export function focusArrivedMessage(element: HTMLElement, frames = 90) {
  const before = document.activeElement;
  let left = frames;
  const attempt = () => {
    if (!element.isConnected) return;
    const active = document.activeElement as HTMLElement | null;
    const moved = active && active !== before && active !== element && active !== document.body && active.isConnected
      && (active.closest('[role="dialog"]') || active.matches('input, textarea, select, [contenteditable="true"]'));
    if (moved) return;
    element.focus({ preventScroll: true });
    if (document.activeElement === element || --left <= 0) return;
    requestAnimationFrame(attempt);
  };
  attempt();
}
