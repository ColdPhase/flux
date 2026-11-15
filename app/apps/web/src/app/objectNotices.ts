import type { ObjectNotice } from '@flux/contracts';
import { messageOf, noticeSource } from './conversationEvents';

// What the conversation says about a decision (#694, F-026 P5). Pure functions: the stream and the
// open thread render the same lines, and the thread picks out the ones that came from it.

/** The words of the card's line after the name: "proposed a decision from", with the part that links, "Jonas’s message". */
export function objectPhrase(notice: ObjectNotice, authorOf: (messageId: string) => string | null, inThread: boolean, actor?: { name: string; mine: boolean }): { lead: string; link?: string; linkTo?: 'message' | 'thread' | 'object' } {
  const what = 'proposed a decision';
  const source = noticeSource(notice, authorOf);
  if (source.kind === 'message') {
    // In its own thread the line does not say where: it is already there.
    if (inThread) return { lead: what };
    if (source.author) return { lead: `${what} from`, link: messageOf(source.author, actor), linkTo: 'message' };
    return notice.conversationId ? { lead: `${what} in`, link: 'a thread', linkTo: 'thread' } : { lead: `${what} from`, link: 'a message' };
  }
  if (source.kind === 'map') return { lead: `${what} from a thought` };
  if (source.kind === 'material') return { lead: `${what} from a source` };
  return { lead: what };
}

/** The card's state word: where the decision stands now. */
export function objectState(notice: ObjectNotice): { word: string; state: string } {
  if (notice.status === 'accepted') return { word: 'Accepted', state: 'accepted' };
  if (notice.status === 'superseded') return { word: 'Replaced', state: 'superseded' };
  return { word: 'Proposed', state: 'proposed' };
}

/** The object a line opens in Details. */
export function objectTarget(notice: ObjectNotice): { kind: 'decision'; id: string } {
  return { kind: 'decision', id: notice.decisionId };
}

/**
 * What came of one thread, oldest first: the decisions made from it (by the conversation of their first
 * source, or by any source among the messages the thread holds). A task made from a message already shows as a chip under
 * that message and as an announcement in the stream; a decision had neither.
 */
export function threadObjects(conversationId: string, messageIds: ReadonlySet<string>, objects: readonly ObjectNotice[]): ObjectNotice[] {
  return objects.filter((notice) => notice.conversationId === conversationId || notice.sources.some((source) => source.type === 'message' && messageIds.has(source.id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
