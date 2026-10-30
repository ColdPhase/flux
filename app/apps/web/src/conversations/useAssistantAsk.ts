import { useEffect, useRef, useState, type RefObject } from 'react';
import { ApiError, NetworkError } from '../api/client';
import { askError as askErrorText, askState } from '../assistant/format';
import { noteAssistantUse } from '../assistant/MeetAssistant';
import type { useConversationAssistant } from '../assistant/useConversationAssistant';
import type { ComposerDrafts } from './useComposerDrafts';
import type { PaneCore } from './paneCore';

/** A request made offline, held under its own id until it can go out (AST-10.15). */
interface WaitingAsk { conversationId: string; prompt: string; clientRunId: string }

interface Options {
  drafts: ComposerDrafts; assistant: ReturnType<typeof useConversationAssistant>;
  scrollRef: RefObject<HTMLDivElement | null>; scrollToEnd: () => void;
}

/**
 * Asking the person's own assistant in a thread (#68): the private prompt goes out, a refused one comes back
 * with the reason, and one made offline waits as "Sends when you're back" and goes out once on reconnect.
 */
export function useAssistantAsk({ me, conversation, writable, audience, composerId }: PaneCore, { drafts, assistant, scrollRef, scrollToEnd }: Options) {
  const { helperComposer, setAsking, captureHelperScope } = drafts;
  const [askFailure, setAskFailure] = useState('');
  const [askFailureCode, setAskFailureCode] = useState<string | null>(null);
  const fail = (cause: unknown) => { setAskFailure(askErrorText(cause)); setAskFailureCode(cause instanceof ApiError ? cause.code : null); };
  // Requests made offline wait in order, each under its own id, and go out one at a time on reconnect (AST-10.15). The ref is
  // the list the flush reads; the state only mirrors it for rendering.
  const [waitingAsks, setWaitingAsks] = useState<WaitingAsk[]>([]);
  const waitingRef = useRef<WaitingAsk[]>([]);
  const sendingRef = useRef(false);
  const changeWaiting = (change: (list: WaitingAsk[]) => WaitingAsk[]) => { waitingRef.current = change(waitingRef.current); setWaitingAsks(waitingRef.current); };
  const holdAsk = (ask: WaitingAsk) => changeWaiting((list) => (list.some((item) => item.clientRunId === ask.clientRunId) ? list : [...list, ask]));
  const waitingHere = waitingAsks.filter((item) => item.conversationId === conversation?.id);
  const offline = useRef<{ ask: typeof assistant.ask; refused: (ask: WaitingAsk, cause: unknown) => void }>({ ask: assistant.ask, refused: () => undefined });
  // A held request the server refuses on reconnect comes back as the person's own text with the reason, as a refused ask does.
  useEffect(() => {
    offline.current = {
      ask: assistant.ask,
      refused: (ask, cause) => {
        const kept = helperComposer.draft.body;
        helperComposer.setBody(kept.trim() ? `${ask.prompt}\n${kept}` : ask.prompt);
        fail(cause); setAsking(true);
        assistant.refreshStatus();
      },
    };
  });
  const heldHere = waitingHere.length > 0;
  useEffect(() => {
    if (!heldHere || !conversation) return undefined;
    const here = conversation.id;
    let stopped = false;
    const flush = () => {
      if (stopped || sendingRef.current || !navigator.onLine) return;
      const next = waitingRef.current.find((item) => item.conversationId === here);
      if (!next) return;
      sendingRef.current = true;
      offline.current.ask(next.prompt, { clientRunId: next.clientRunId }).then(() => {
        sendingRef.current = false;
        changeWaiting((list) => list.filter((item) => item.clientRunId !== next.clientRunId));
        flush();
      }, (cause) => {
        sendingRef.current = false;
        if (cause instanceof NetworkError) return;
        changeWaiting((list) => list.filter((item) => item.clientRunId !== next.clientRunId));
        offline.current.refused(next, cause);
      });
    };
    window.addEventListener('online', flush);
    const timer = window.setInterval(flush, 4000);
    return () => { stopped = true; window.removeEventListener('online', flush); window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heldHere, conversation?.id]);
  async function sendToAssistant() {
    if (!conversation || !writable || drafts.askBusy || askState(assistant.status, audience).kind !== 'ready') return;
    const command = helperComposer.begin();
    if (!command) return;
    const active = captureHelperScope();
    // The box is disabled while the request goes out, which takes a keyboard user's focus with it (AC-8): back in the box after.
    const inBox = document.activeElement?.id === composerId;
    const backToBox = () => {
      if (!inBox) return;
      requestAnimationFrame(() => { const now = document.activeElement; if (active() && (!now || now === document.body)) document.getElementById(composerId)?.focus({ preventScroll: true }); });
    };
    setAskFailure('');
    try {
      noteAssistantUse(me.user.id);
      scrollToEnd();
      await assistant.ask(command.body, { clientRunId: command.clientMessageId });
      helperComposer.finish(command.clientMessageId);
      // The run's working line joins the end of the thread; follow it as a sent message does, or it starts off screen.
      if (active()) { scrollToEnd(); requestAnimationFrame(() => { if (active()) scrollToEnd(); }); }
      if (active()) setAsking(false);
      backToBox();
    } catch (cause) {
      // Offline: the request waits as "Sends when you're back" and goes out once, under the same id, on reconnect (AST-10.15).
      if (cause instanceof NetworkError && conversation) {
        helperComposer.finish(command.clientMessageId);
        holdAsk({ conversationId: conversation.id, prompt: command.body, clientRunId: command.clientMessageId });
        if (active()) setAsking(false);
        backToBox();
        return;
      }
      helperComposer.finish(command.clientMessageId, cause);
      backToBox();
      if (!active()) return;
      fail(cause);
      assistant.refreshStatus();
    }
  }
  /** A suggested question under a thread (#68): asked at once, held while offline. */
  function askSuggestion(text: string) {
    noteAssistantUse(me.user.id);
    const clientRunId = crypto.randomUUID();
    void assistant.ask(text, { clientRunId }).then(() => requestAnimationFrame(() => { const feed = scrollRef.current; if (feed) feed.scrollTop = feed.scrollHeight; }))
      .catch((cause) => { if (cause instanceof NetworkError && conversation) holdAsk({ conversationId: conversation.id, prompt: text, clientRunId }); else { fail(cause); setAsking(true); } });
  }
  function exitAsk() { setAsking(false); setAskFailure(''); document.getElementById(composerId)?.focus(); }
  return { askFailure, setAskFailure, askFailureCode, setAskFailureCode, waitingHere, sendToAssistant, askSuggestion, exitAsk };
}
export type AssistantAsk = ReturnType<typeof useAssistantAsk>;
