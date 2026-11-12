import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import type { AssistantAnswer } from '@flux/contracts';
import type { outboxView } from '../composer/draft';
import { pageBackTo } from '../app/seekMessage';
import { UNREAD_READ_BACK, countBelow, openAtUnread, useNewBelow } from '../app/unreadReading';
import { ownRuns, useObservation, useReceiptTick, useReceipts } from '../app/receipts';
import { useArrivals } from '../ui';
import { observeProjectMessages, olderMessages, projectReceipts } from './api';
import { feedEntries, mergeMessages } from './feed';
import type { PaneCore } from './paneCore';
import type { ThreadReading } from './useThreadReading';
import type { ThreadReplies } from './useThreadReplies';

interface Options {
  thread: ThreadReplies; reading: ThreadReading; answers: AssistantAnswer[]; outbox: ReturnType<typeof outboxView>;
  rootMessageId: string | null; hideIfDenied: (cause: unknown) => void;
}

/**
 * Where the open thread is and who saw it: the reply a link or a return arrives at (paging back until it is loaded,
 * #114, #592), replies rising in as they arrive (#155), and the viewing receipts of the replies (#534).
 */
export function useThreadPlace({ me, project, conversation }: PaneCore, { thread, reading, answers, outbox, rootMessageId, hideIfDenied }: Options) {
  const { messages, olderCursor } = thread;
  const { threadRestore, scrollRef, feedNode, columnRef, revealed } = reading;
  // Where the person left off (#1246), as the thread was opened (what is seen is read, so a later read says something else): a reply
  // the "New" divider stands above, or "caught up" (null). A thread never opened has all its replies to read: the first reply, which opens the
  // thread at its root, whole (#436). The pane is made again for each thread.
  const [leftOff, setLeftOff] = useState(conversation?.unreadFrom);
  const unreadFrom = typeof leftOff === 'string' ? leftOff : null;
  const hash = useLocation().hash;
  // The root is the stream's message; the thread arrives only at its replies.
  const arrived = conversation && hash.startsWith('#message-') && hash.slice('#message-'.length) !== rootMessageId ? hash.slice('#message-'.length) : null;
  const arrivedLoaded = !!arrived && messages.some((message) => message.id === arrived);
  // A search result or source older than the loaded window (#114), or the message a return brings back (#592): page back until it is loaded.
  const seek = arrived ?? (threadRestore?.id.startsWith('message-') ? threadRestore.id.slice('message-'.length) : null) ?? (threadRestore ? null : unreadFrom);
  const seekLoaded = !!seek && messages.some((message) => message.id === seek);
  useEffect(() => {
    if (!conversation || !seek || seekLoaded || !olderCursor) return;
    let cancelled = false;
    // The first new reply is read back to a page or two at most (#862): beyond that all that is loaded is new, and the divider goes above the oldest of it.
    const forUnread = seek === unreadFrom && seek !== arrived && !threadRestore;
    void pageBackTo(seek, olderCursor, (before, limit) => olderMessages(conversation.id, before, undefined, limit), forUnread ? UNREAD_READ_BACK : undefined).then(({ pages, cursor, found }) => {
      if (cancelled) return;
      thread.setMessages((current) => pages.reduce((all, page) => mergeMessages(all, page.messages), current));
      thread.setOlderCursor(cursor);
      const oldest = pages.at(-1)?.messages.find((message) => message.sequence > 1);
      if (forUnread && !found && oldest) setLeftOff(oldest.id);
    }).catch((cause: unknown) => { hideIfDenied(cause); });
    return () => { cancelled = true; };
    // Seek once per conversation and target; later pages come from "Load earlier replies".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, seek]);
  const unreadLoaded = !!unreadFrom && messages.some((message) => message.id === unreadFrom);
  const unreadPlaced = useRef(false);
  const stopUnread = useRef<(() => void) | null>(null);
  useEffect(() => () => stopUnread.current?.(), []);
  useEffect(() => {
    // A source link from a notice or search opens on that whole message. Otherwise an open thread opens where the person left off
    // (#1246): on the "New" divider, or at the end when they have read all of it. A divider above the first reply opens it at its root,
    // whole (#436): its feed (the only one this ref holds) is scrolled to the top, so a long thread shows
    // its oldest replies first and the reader scrolls down. It runs again when the thread is first shown: a hidden
    // message cannot take focus. A return to this entry keeps the place the reader left (useMessageWork).
    if (threadRestore) return;
    const feed = scrollRef.current;
    const anchor = arrived ? document.getElementById(`message-${arrived}`) : null;
    if (anchor && feed?.contains(anchor)) { anchor.scrollIntoView({ block: 'start' }); if (revealed) anchor.focus({ preventScroll: true }); return; }
    if (!feed) return;
    if (revealed && unreadLoaded && !unreadPlaced.current) {
      unreadPlaced.current = true;
      stopUnread.current = openAtUnread(feed, columnRef.current);
    }
    if (stopUnread.current) return;
    feed.scrollTop = revealed && leftOff === null ? feed.scrollHeight : 0;
  }, [conversation?.id, arrived, arrivedLoaded, feedNode, revealed, threadRestore, scrollRef, columnRef, unreadLoaded, leftOff]);
  // Genuine replies and answers arriving in an open thread rise in gently when the reader sees them (#155,
  // UI116-5); the history the thread opens with and earlier pages never move. The thread's position owner
  // (useMessageWork) decides whether the reader follows the end.
  // A confirmed reply keeps its queued message's place and id here, so it is not a second arrival (#264).
  const messageDomKey = (id: string) => { const key = outbox.keyOf(id); return key === id ? `message-${id}` : key; };
  const replyEntries = conversation ? feedEntries(messages.filter((message) => message.sequence > 1), answers, !!olderCursor) : [];
  const threadIds = conversation ? [...replyEntries
    .map((entry) => entry.type === 'message' ? messageDomKey(entry.message.id) : entry.type === 'answer' ? `answer-${entry.answer.runId}` : entry.key), ...outbox.pending.map((item) => `pending-${item.id}`)] : [];
  // What arrives below a reader who is above the end is counted in "↓ N new" (#1246); a reader at the end follows it.
  const newBelow = useNewBelow(feedNode);
  useArrivals(scrollRef, threadIds, (id) => document.getElementById(id), (arrivedIds, following) => {
    if (!following) newBelow.add(countBelow(scrollRef.current, arrivedIds, (id) => document.getElementById(id)));
  });
  // #534: a thread's replies are watched like the stream's roots, and "Seen by" needs every reply of the person's own run.
  const receiptLines = [...replyEntries.map((entry) => entry.type === 'message'
    ? { id: entry.message.id as string | null, authorId: entry.message.authorId === null ? entry.message.author.id : entry.message.authorId, createdAt: entry.message.createdAt }
    : { id: null, authorId: `~${entry.key}`, createdAt: entry.at }),
    ...outbox.pending.map((item) => ({ id: null, authorId: me.user.id, createdAt: item.at }))];
  const receiptRuns = ownRuns(receiptLines, me.user.id, !!olderCursor);
  const receiptTick = useReceiptTick(receiptRuns.length > 0, me.user.id, project.id);
  const seen = useReceipts({ scope: `${project.id}/${conversation?.id ?? ''}`, fetchReceipts: (list, signal) => projectReceipts(project.id, list, signal), runs: receiptRuns, tick: receiptTick });
  useObservation({ scope: project.id, observe: (ids) => observeProjectMessages(project.id, ids), enabled: !!conversation && revealed, feed: scrollRef,
    ids: replyEntries.flatMap((entry) => entry.type === 'message' && entry.message.authorId !== me.user.id ? [entry.message.id] : []), depend: replyEntries.length });
  return { arrived, seen, unreadFrom: unreadLoaded ? unreadFrom : null, newBelow };
}
