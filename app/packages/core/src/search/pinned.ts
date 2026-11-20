/** The kinds of result that are messages: a space's and a direct message's. */
export const isMessageKind = (kind: string) => kind === 'message' || kind === 'dm_message';

/**
 * C-74 (#1615): a page's pinned messages stand first among its messages. They take the first of the places the messages hold, in their own
 * order, and every other result keeps its place, so a group of messages lists its pinned ones first and nothing else moves. Pinned is a
 * property of the visible row: no statistic of the index decides it (F-042).
 */
export function pinnedFirst<T>(items: readonly T[], isMessage: (item: T) => boolean, isPinned: (item: T) => boolean): T[] {
  const places = items.flatMap((item, index) => (isMessage(item) ? [index] : []));
  const messages = places.map((index) => items[index]!);
  const ordered = [...messages.filter(isPinned), ...messages.filter((item) => !isPinned(item))];
  const out = [...items];
  places.forEach((place, position) => { out[place] = ordered[position]!; });
  return out;
}
