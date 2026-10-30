import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation } from '@flux/contracts';
import { OPENING_REVEAL_MS } from '../app/messageParts';
import { currentEntry, isBooted, recall, useArrival } from '../place/memory';
import { useSpareHeight } from '../ui/spareHeight';
import { threadPlace, useMessageWork } from '../work/useMessageWork';
import { useProjectWorkSummary } from '../work/WorkReadContext';
import { useReferenceWork } from '../work/useReferenceWork';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import type { PaneCore } from './paneCore';

interface Options {
  messages: Conversation['messages']; pendingCount: number; rootMessageId: string | null;
  assistant: ReturnType<typeof useConversationAssistant>;
  accessLost: boolean; hideIfDenied: (cause: unknown) => void;
}

/**
 * The thread as it is read: its scroll area, the bounded reads of what was made from its replies and of the tasks
 * its answers refer to (#155), where a return left the reader (#592), and when it may be shown at all.
 */
export function useThreadReading({ me, project, conversation }: PaneCore, { messages, pendingCount, rootMessageId, assistant, accessLost, hideIfDenied }: Options) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((node: HTMLDivElement | null) => { scrollRef.current = node; setFeedNode(node); }, []);
  // A short thread sits against its reply field instead of at the top of a tall panel (ui/spareHeight.ts).
  const columnRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef<HTMLDivElement>(null);
  useSpareHeight(scrollRef, columnRef, liftRef, conversation ? messages.length + pendingCount : 0, feedNode);
  // The thread shows its root whole at the top (with what was made from it), then the replies: one bounded
  // association read covers the root and the replies around the viewport (#155).
  const sourceIds = useMemo(() => [...(rootMessageId ? [rootMessageId] : []), ...messages.filter((message) => message.sequence > 1 && message.id !== rootMessageId).map((message) => message.id)], [messages, rootMessageId]);
  // Bounded native reads (#155): the visible replies' chips, and the tasks that answers, proposals and the
  // discussed task refer to. Neither is the project's work collection.
  const discussedTask = conversation?.task?.workId ?? null;
  const referenceIds = useMemo(() => [...new Set([...(discussedTask ? [`work:${discussedTask}`] : []), ...assistant.answers.flatMap((answer) => {
    const refs = answer.sources.filter((source) => source.type === 'work').map((source) => `work:${source.id}`);
    const proposal = answer.proposalId ? assistant.proposals.get(answer.proposalId) : null;
    if (proposal?.change.finishes) refs.push(`work:${proposal.change.finishes.workId}`);
    return refs;
  })])].sort(), [assistant.answers, assistant.proposals, discussedTask]);
  const referenceWork = useReferenceWork(me.user.id, project.id, referenceIds, feedNode, !accessLost);
  // Coming back to an entry with this thread open, or back to the thread from an object that covered it in the panel (it was
  // unmounted meanwhile): its replies return to where they were left (#592). A reload opens the thread as it always opens.
  const arrival = useArrival();
  const [threadRestore] = useState(() => {
    const from = arrival ?? (isBooted() ? currentEntry() : null);
    return conversation && from ? threadPlace(recall('thread', from)) : null;
  });
  const messageWork = useMessageWork(me.user.id, project.id, accessLost ? null : conversation?.id ?? null, sourceIds, scrollRef, feedNode, referenceWork.readingRevision, threadRestore);
  // Opening (#155): the replies, their task chips, referenced rows and the header's state line come from
  // separate bounded reads. The thread shows once the first of each has settled (at most OPENING_REVEAL_MS),
  // so nothing shifts under the reader's eyes or pointer as they arrive.
  const workSummary = useProjectWorkSummary();
  const openingSettled = messageWork.state.phase !== 'loading' && referenceWork.state.phase !== 'loading' && workSummary.phase !== 'loading';
  const [openingTimedOut, setOpeningTimedOut] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setOpeningTimedOut(true), OPENING_REVEAL_MS); return () => window.clearTimeout(timer); }, []);
  const [revealed, setRevealed] = useState(false);
  if (!revealed && (openingSettled || openingTimedOut)) setRevealed(true);
  useEffect(() => {
    if (referenceWork.state.phase !== 'unavailable') return;
    const cause = referenceWork.state.error;
    let current = true;
    // A settled current read may retire the view through router authorization.
    // Do not carry a queued denial into a newer observation or unmounted owner.
    queueMicrotask(() => { if (current) hideIfDenied(cause); });
    return () => { current = false; };
  }, [referenceWork.state, hideIfDenied]);
  const scrollToEnd = () => {
    const feed = scrollRef.current;
    if (!feed) return;
    feed.scrollTop = feed.scrollHeight;
    feed.dispatchEvent(new Event('scroll'));
  };
  const discussedRow = discussedTask ? referenceWork.rows.get(`work:${discussedTask}`) ?? null : null;
  return { scrollRef, feedNode, attachFeed, columnRef, liftRef, referenceWork, messageWork, threadRestore, revealed, scrollToEnd, discussedRow };
}
export type ThreadReading = ReturnType<typeof useThreadReading>;
