import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation, Material, Page } from '@flux/contracts';
import type { SentMessage } from '../composer/draft';
import { fluxAnswers, onFluxAnswered } from '../composer/connection';
import { useStreamEvents } from '../api/stream';
import { listMaterials } from '../materials/api';
import { getConversation, olderMessages } from './api';
import { readableError } from './errors';
import { mergeMessages } from './feed';
import type { PaneCore } from './paneCore';

/** Project events that change what a conversation pane shows; the assistant's Undo (#68) can take a message back. */
const LIVE_KINDS = new Set(['project.conversation_created.v1', 'project.message_sent.v1', 'project.assistant_change_undone.v1']);

interface Options {
  /** Replies this person sent and the server confirmed: shown at once until a read includes them (#264). */
  sent: readonly SentMessage[];
  hideIfDenied: (cause: unknown) => void;
  /** The newest first page of the project's sources, read with the replies. */
  mergeMaterials: (latest: Page<Material>) => void;
  onThreadSize?: (conversationId: string, replyCount: number, lastReplyAt: string | null) => void;
}

/**
 * The open thread's replies and how they stay current: earlier pages, and a refresh on every project message
 * (#733), on a resync, when Flux answers again, on focus and every 15 s. The stream's pane refreshes its route.
 */
export function useThreadReplies({ me, project, conversation, revalidateRef }: PaneCore, { sent, hideIfDenied, mergeMaterials, onThreadSize }: Options) {
  const [stored, setMessages] = useState<Conversation['messages']>(conversation?.messages ?? []);
  const messagesRef = useRef(stored);
  useEffect(() => { messagesRef.current = stored; }, [stored]);
  // A reply confirmed here is shown at once, in place of its queued message, until a read includes it (#264).
  const messages = useMemo(() => conversation ? mergeMessages(stored, sent.filter((item) => item.message.conversationId === conversation.id).map((item) => item.message)) : stored,
    [conversation, stored, sent]);
  const [olderCursor, setOlderCursor] = useState(conversation?.messagePage.nextBeforeSequence ?? null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [readFailure, setReadFailure] = useState<{ message: string; retry: () => void } | null>(null);
  const refreshingRef = useRef(false);
  /** A refresh was asked for while one was reading: read once more after it, so a message posted meanwhile is not left to the poll (#733). */
  const refreshAgainRef = useRef(false);
  const conversationId = conversation?.id;
  const refresh = useCallback(async () => {
    // Offline, a read fails and a failed route reload would replace the stream with an error page:
    // the quiet line says why (#264), and the stream reads again when the connection is back.
    if (!fluxAnswers()) return;
    if (refreshingRef.current) { refreshAgainRef.current = true; return; }
    refreshingRef.current = true;
    refreshAgainRef.current = false;
    // The stream's refresh reloads the route (newest roots, the project); a thread reads only its own replies.
    if (!conversationId) revalidateRef.current();
    try {
      const [latestMaterials, latestConversation] = await Promise.all([
        listMaterials(project.id),
        conversationId ? getConversation(conversationId) : Promise.resolve(null),
      ]);
      mergeMaterials(latestMaterials);
      if (latestConversation) {
        const newestSeen = messagesRef.current.at(-1)?.sequence ?? 0;
        let incoming = latestConversation.messages;
        let cursor = incoming[0]?.sequence;
        while (newestSeen > 0 && cursor && cursor > newestSeen + 1) {
          const page = await olderMessages(conversationId!, cursor);
          if (!page.messages.length || page.messages[0]!.sequence >= cursor) throw new Error('Could not load intervening replies');
          incoming = mergeMessages(page.messages, incoming);
          cursor = page.messages[0]?.sequence;
        }
        setMessages((current) => mergeMessages(current, incoming));
      }
    } catch (cause) { hideIfDenied(cause); }
    finally {
      refreshingRef.current = false;
      if (refreshAgainRef.current) { refreshAgainRef.current = false; queueMicrotask(() => { void refreshLatest.current(); }); }
    }
  }, [conversationId, hideIfDenied, project.id, mergeMaterials, revalidateRef]);
  const refreshLatest = useRef(refresh);
  useEffect(() => { refreshLatest.current = refresh; }, [refresh]);
  // Flux answers again (not merely a Retry or the browser's `online` event): read what arrived meanwhile.
  useEffect(() => onFluxAnswered(() => { void refresh(); }), [refresh]);
  // A message or a new conversation in this project (#733) reads at once, not at the 15 s poll: the event carries the
  // project only, so the stream reloads its roots and an open thread reads its own replies. A resync reads the same way.
  useStreamEvents(me.user.id, (event) => {
    if (event.objectType === 'project' && event.objectId === project.id && LIVE_KINDS.has(event.kind)) void refresh();
  }, () => { void refresh(); });
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(onFocus, 15000);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(interval); };
  }, [refresh]);
  // The thread's size goes back to the stream (UI116-1); sequences are dense, so the newest one counts the root.
  useEffect(() => {
    const newest = messages.at(-1);
    if (conversationId && newest) onThreadSize?.(conversationId, newest.sequence - 1, newest.sequence > 1 ? newest.createdAt : null);
  }, [conversationId, messages, onThreadSize]);
  async function loadOlder() {
    if (!conversation || !olderCursor || olderBusy) return;
    setOlderBusy(true); setReadFailure(null);
    try {
      const page = await olderMessages(conversation.id, olderCursor);
      setMessages((current) => mergeMessages(current, page.messages)); setOlderCursor(page.messagePage.nextBeforeSequence);
    } catch (cause) { hideIfDenied(cause); setReadFailure({ message: readableError(cause), retry: () => void loadOlder() }); }
    finally { setOlderBusy(false); }
  }
  return { messages, setMessages, olderCursor, setOlderCursor, olderBusy, loadOlder, refresh, readFailure, setReadFailure };
}
export type ThreadReplies = ReturnType<typeof useThreadReplies>;
