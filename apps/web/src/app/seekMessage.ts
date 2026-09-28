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
