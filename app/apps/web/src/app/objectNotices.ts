import type { ObjectNotice } from '@flux/contracts';
import { messageOf, noticeSource } from './conversationEvents';

// What the conversation says about a decision or a result (#694, F-026 P5). Pure functions: the stream and the
// open thread render the same lines, and the thread picks out the ones that came from it.

/** The words of one line after the name: "proposed a decision from", with the part that links, "Jonas’s message". */
export function objectPhrase(notice: ObjectNotice, authorOf: (messageId: string) => string | null, inThread: boolean, actor?: { name: string; mine: boolean }, follows = false): { lead: string; link?: string; linkTo?: 'message' | 'thread' } {
  // Right under its proposal's card (`followsProposal`): the card names the decision.
  if (follows && notice.kind === 'decision.accepted') return { lead: 'accepted it' };
  const what = notice.kind === 'result.recorded' ? `recorded a ${notice.finding === 'negative' ? 'negative ' : ''}result`
    : notice.kind === 'decision.accepted' ? 'accepted a decision' : 'proposed a decision';
  // Accepting is a person's step on the proposal, not a new origin: it names no source.
  if (notice.kind === 'decision.accepted') return { lead: what };
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

/**
 * Whether an acceptance line directly follows the proposal of the same decision, with nothing between (#763 H11-9): the
 * proposal's card already says "Accepted", so the acceptance is told as one line under it, with no second card.
 */
export function followsProposal(notice: ObjectNotice, previous: ObjectNotice | null | undefined): boolean {
  return notice.kind === 'decision.accepted' && previous?.kind === 'decision.proposed' && previous.decisionId === notice.decisionId;
}

/** The card's state word: where the decision stands now, or the finding of the result. */
export function objectState(notice: ObjectNotice): { word: string; state: string } {
  if (notice.kind === 'result.recorded') return notice.finding === 'negative' ? { word: 'Negative', state: 'negative' } : { word: 'Positive', state: 'positive' };
  if (notice.status === 'accepted') return { word: 'Accepted', state: 'accepted' };
  if (notice.status === 'superseded') return { word: 'Replaced', state: 'superseded' };
  return { word: 'Proposed', state: 'proposed' };
}

/** The object a line opens in Details. */
export function objectTarget(notice: ObjectNotice): { kind: 'decision' | 'result'; id: string } {
  return notice.kind === 'result.recorded' ? { kind: 'result', id: notice.resultId } : { kind: 'decision', id: notice.decisionId };
}

/**
 * What came of one thread, oldest first: the decisions and results made from it (by the conversation of their first
 * source, or by any source among the messages the thread holds). A task made from a message already shows as a chip under
 * that message and as an announcement in the stream; these two kinds had neither.
 */
export function threadObjects(conversationId: string, messageIds: ReadonlySet<string>, objects: readonly ObjectNotice[]): ObjectNotice[] {
  return objects.filter((notice) => notice.conversationId === conversationId || notice.sources.some((source) => source.type === 'message' && messageIds.has(source.id)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
