import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation } from 'react-router';
import type { DmMessage, DmPerson, DmThread } from '@flux/contracts';
import { dmReaders, dmReceipts, getDmThread, observeDmMessages, olderDmReplies } from '../api/direct-messages';
import { askError, askState } from '../assistant/format';
import { noteAssistantUse } from '../assistant/MeetAssistant';
import { PrivateAiLines } from '../assistant/PrivateAiLines';
import { useConversationAssistant } from '../assistant/useConversationAssistant';
import { useFollowEnd } from '../assistant/useFollowEnd';
import { useShellData } from '../app/data';
import { ComposerBox } from '../composer/ComposerBox';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { SendAnnouncer } from '../composer/Outbox';
import { Button, Icon, MEDIA, PanelMeta, sendsOnEnter, useArrivals, useMediaQuery } from '../ui';
import '../app/one-conversation.css';
import { DmBubble } from './DmBubble';
import { onMessageChanged } from '../conversations/messageChanges';
import { groupRows } from './rows';
import { ownRuns, useObservation, useReceipts } from '../app/receipts';
import { pageBackTo } from '../app/seekMessage';
import { useMessageReadingPosition } from '../work/readingPosition';
import { useLeftPlace, useReturnPlace } from './returnPlace';
import { useSpareHeight } from '../ui/spareHeight';
import { MessageDay } from '../app/messageParts';
import { NewBelow, UnreadDivider, countBelow, openAtUnread, useNewBelow } from '../app/unreadReading';

function merge(current: DmMessage[], incoming: DmMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

/**
 * The private replies to one message (#536), in the one panel (F-026 S4) beside the conversation or as the phone's sheet.
 * Its audience is the conversation's current participants and nothing else; every read, send and refresh
 * asks the server again. Esc and the close control give focus back to the message that opened it.
 */
export function DmThreadPanel({ dmId, rootId, meId, meName, nameOf, others, writable, refreshTick, receiptTick, focusComposer, canObserve,
  onDenied, onCreateTask, onCount }: {
  dmId: string; rootId: string; meId: string; meName: string; nameOf: (id: string) => string;
  /** First names of the other people of the conversation: the ones who do not see a private answer. */
  others: readonly string[]; writable: boolean;
  refreshTick: number; receiptTick: number; focusComposer: boolean; canObserve: boolean;
  onDenied: (cause: unknown) => void; onCreateTask: (message: DmMessage, excerpt: string | undefined) => void;
  onCount: (rootId: string, replies: number) => void;
}) {
  const touch = useMediaQuery(MEDIA.touch);
  const [thread, setThread] = useState<DmThread | null>(null);
  const [replies, setReplies] = useState<DmMessage[]>([]);
  const [people, setPeople] = useState<Map<string, DmPerson>>(new Map());
  // The cursor to earlier replies: undefined until the thread is first read, null once every earlier reply is loaded.
  const [older, setOlder] = useState<number | null | undefined>(undefined);
  const [olderBusy, setOlderBusy] = useState(false);
  // Where the person left off (#1246), as the thread was first read: the reply the "New" divider stands above, null when none, undefined until read.
  const [unreadFrom, setUnreadFrom] = useState<string | null | undefined>(undefined);
  const feed = useRef<HTMLDivElement | null>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  // The feed element as state too, so the reading-position owner starts once it is on screen.
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((element: HTMLDivElement | null) => { feed.current = element; setFeedNode(element); }, []);
  const field = useRef<HTMLTextAreaElement>(null);
  const loading = useRef(false);
  const loadAgain = useRef(false);
  const composer = useComposerDraft(meId, 'dm', `dm:${dmId}/${rootId}`);
  const captureScope = useComposerScope(composer.key);
  const draft = composer.draft.body;
  // `/ai` in this thread (#1016): the answer is a card in this panel that only the asker sees; Show everyone posts it as a reply here. A guest has no AI (AG-2).
  const { workspace } = useShellData();
  const [askFailure, setAskFailure] = useState('');
  const asking = workspace?.role !== 'guest' && /^\/ai(\s|$)/.test(draft);
  // A reply confirmed here shows at once until a read includes it; then the stored copy wins, so an edit or a delete shows (#1006).
  const shown = useMemo(() => merge(composer.sent.map((item) => item.message as DmMessage), replies), [replies, composer.sent]);
  const outbox = outboxView(shown, composer.pending, composer.sent, meId);

  // The author edited or deleted the root or a reply of this thread (#1006): it is replaced at once.
  useEffect(() => onMessageChanged((message) => {
    const changed = message as DmMessage;
    if (changed.conversationId !== dmId) return;
    if (changed.id === rootId) setThread((current) => (current ? { ...current, root: changed } : current));
    else if (changed.threadRootId === rootId) setReplies((current) => merge(current, [changed]));
  }), [dmId, rootId]);
  const learn = useCallback((list: DmPerson[]) => setPeople((current) => { const next = new Map(current); for (const p of list) next.set(p.id, p); return next; }), []);
  const label = (id: string) => (people.get(id)?.name ?? nameOf(id));
  const load = useCallback(async () => {
    // A change that is told while a read is on its way asks for one more when it ends: that read may have been made before it was stored.
    if (loading.current) { loadAgain.current = true; return; }
    loading.current = true;
    try {
      do {
        loadAgain.current = false;
        try {
          const next = await getDmThread(dmId, rootId);
          setThread(next); learn(next.people);
          setReplies((current) => merge(current, next.replies));
          setOlder((current) => (current === undefined ? next.messagePage.nextBeforeSequence : current));
          setUnreadFrom((current) => current === undefined ? next.unreadFrom ?? null : current);
          onCount(rootId, next.root.replyCount);
        } catch (cause) { onDenied(cause); }
      } while (loadAgain.current);
    } finally { loading.current = false; }
  }, [dmId, rootId, learn, onCount, onDenied]);
  // Reading the thread from the server is what this effect is for.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load, refreshTick]);

  const opening = thread === null;
  // Coming back (#592): the reply that was in view returns to where it was, read back to when it is older than the newest
  // replies. Reopening a thread, or uncovering it, finds the place it had under this entry; a reload opens it at the latest.
  const slot = `dm-thread:${rootId}`;
  const wanted = useLeftPlace(slot, { here: true });
  const seekPlace = useCallback(async (elementId: string) => {
    const target = /^thread-message-(.+)$/.exec(elementId)?.[1];
    if (!target || !older) return false;
    const { pages, cursor, found } = await pageBackTo(target, older, async (before) => {
      const page = await olderDmReplies(dmId, rootId, before);
      return { messages: page.replies, messagePage: page.messagePage, people: page.people };
    });
    for (const page of pages) learn(page.people);
    setReplies((current) => pages.reduce((all, page) => merge(all, page.messages), current));
    setOlder(cursor);
    return found;
  }, [dmId, rootId, older, learn]);
  // A link to one reply (`?thread=<root>#thread-message-<reply>`, Copy link on a reply) opens this thread at that reply: it is read back to
  // when it is older than the newest replies, then brought into view and focused.
  const hash = useLocation().hash;
  const target = hash.startsWith('#thread-message-') ? hash.slice('#thread-message-'.length) : null;
  const targetLoaded = !!target && shown.some((message) => message.id === target);
  useEffect(() => {
    if (!target || opening || targetLoaded || !older) return;
    let cancelled = false;
    void pageBackTo(target, older, async (before) => {
      const page = await olderDmReplies(dmId, rootId, before);
      return { messages: page.replies, messagePage: page.messagePage, people: page.people };
    }).then(({ pages, cursor }) => {
      if (cancelled) return;
      for (const page of pages) learn(page.people);
      setReplies((current) => pages.reduce((all, page) => merge(all, page.messages), current));
      setOlder(cursor);
    }).catch((cause: unknown) => { onDenied(cause); });
    return () => { cancelled = true; };
    // Seek once per target; later pages come from "Show earlier replies".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, opening]);
  useLayoutEffect(() => {
    const anchor = target && targetLoaded ? document.getElementById(`thread-message-${target}`) : null;
    if (anchor) { anchor.scrollIntoView({ block: 'center' }); anchor.focus({ preventScroll: true }); }
  }, [target, targetLoaded]);
  const rootElementId = thread ? `thread-message-${thread.root.id}` : null;
  const returned = useReturnPlace({ wanted, loaded: !opening, have: (id) => id === rootElementId || shown.some((message) => `thread-message-${message.id}` === id), hasOlder: !!older, seek: seekPlace });
  useMessageReadingPosition(feed, returned.pending ? null : feedNode, !returned.pending && !opening, '', returned.restore, slot);
  // A reader at the end follows the replies that arrive there; one who has scrolled up to read is never pulled down.
  const stick = useRef(true);
  useEffect(() => {
    if (!feedNode) return;
    const note = () => { stick.current = feedNode.scrollHeight - feedNode.scrollTop - feedNode.clientHeight < 48; };
    feedNode.addEventListener('scroll', note, { passive: true });
    return () => feedNode.removeEventListener('scroll', note);
  }, [feedNode]);

  // The person's own agent asked from this thread (#1016): its work and its answer are theirs alone, at the end of the replies.
  const toEnd = () => requestAnimationFrame(() => { const el = feed.current; if (el) el.scrollTop = el.scrollHeight; });
  const assistant = useConversationAssistant({ meId, place: { kind: 'dm', dmId, threadRootId: rootId }, onShown: () => { stick.current = true; void load(); toEnd(); } });
  const privateItems = [...assistant.privateAnswers.map((item) => item.id), assistant.run?.id ?? ''].join(',');
  useFollowEnd(() => feed.current, privateItems.replaceAll(',', '') ? privateItems : '', assistant.run?.id ?? null);
  // Opening is on the "New" divider when there is one in the replies read (#1246), otherwise at the end.
  const unreadLoaded = !opening && !!unreadFrom && shown.some((message) => message.id === unreadFrom);
  const unreadPlaced = useRef(false);
  const stopUnread = useRef<(() => void) | null>(null);
  useEffect(() => () => stopUnread.current?.(), []);
  useLayoutEffect(() => {
    // A return positions itself, once its reply is loaded.
    if (returned.pending || returned.restore || target) return;
    const el = feed.current;
    if (!el) return;
    if (unreadLoaded && !unreadPlaced.current) {
      unreadPlaced.current = true;
      stopUnread.current = openAtUnread(el, columnRef.current);
      if (stopUnread.current) { stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; return; }
    }
    if (opening || stick.current) el.scrollTop = el.scrollHeight;
  }, [opening, shown.length, returned.pending, returned.restore, target, unreadLoaded]);
  useEffect(() => { if (!opening && focusComposer) field.current?.focus({ preventScroll: true }); }, [opening, focusComposer]);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  async function loadOlder() {
    if (!older || olderBusy) return;
    setOlderBusy(true);
    // Earlier replies join above what is being read, which stays where it is.
    const el = feed.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const page = await olderDmReplies(dmId, rootId, older);
      learn(page.people);
      setReplies((current) => merge(current, page.replies));
      setOlder(page.messagePage.nextBeforeSequence);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
    } catch (cause) { onDenied(cause); }
    finally { setOlderBusy(false); }
  }

  /** `/ai …` asks the person's agent about this thread; the words are not a reply. */
  async function askAgent() {
    const prompt = draft.replace(/^\/ai\s*/, '').trim();
    const state = askState(assistant.status);
    if (!prompt) { setAskFailure('Say what to ask after /ai, for example /ai summarise this thread.'); return; }
    if (state.kind !== 'ready') { setAskFailure(state.note); return; }
    const active = captureScope();
    setAskFailure('');
    noteAssistantUse(meId);
    try {
      await assistant.ask(prompt);
      if (!active()) return;
      composer.setBody('');
      stick.current = true; toEnd();
    } catch (cause) { if (active()) setAskFailure(askError(cause)); }
  }

  async function send() {
    if (!writable) return;
    if (asking) { await askAgent(); return; }
    const outcome = composer.submit(shown.at(-1)?.sequence ?? 0);
    if (!outcome) return;
    const active = captureScope();
    const result = await outcome;
    if (!active()) return;
    if (result.status === 'delivered') { setReplies((current) => merge(current, [result.message as DmMessage])); void load(); return; }
    if (result.status === 'failed') onDenied(result.cause);
  }
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (sendsOnEnter(event, touch)) { event.preventDefault(); void send(); }
  }

  const root = thread?.root ?? null;
  const lines = [...shown.map((message) => ({ message, authorId: message.authorId, via: message.via ?? null, at: message.createdAt })),
    ...outbox.pending.map((item) => ({ message: null, item, authorId: meId, at: item.at }))];
  const rows = groupRows(lines, (line) => !!line.message && line.message.id === unreadFrom);
  // A short thread sits against its reply field instead of at the top of a tall panel (ui/spareHeight.ts).
  const liftRef = useRef<HTMLDivElement>(null);
  useSpareHeight(feed, columnRef, liftRef, (root ? 1 : 0) + rows.length, feedNode);
  // What arrives while the person reads above the end is counted in "↓ N new" (#1246).
  const newBelow = useNewBelow(feedNode);
  useArrivals(feed, [...shown.map((message) => `thread-message-${message.id}`), ...outbox.pending.map((item) => `pending-${item.id}`)], (id) => document.getElementById(id), (ids, atEnd) => {
    if (!atEnd) newBelow.add(countBelow(feed.current, ids, (id) => document.getElementById(id)));
  }, { animate: false });
  const runs = ownRuns(shown.map((m) => ({ id: m.id, authorId: m.authorId, createdAt: m.createdAt })).concat(outbox.pending.map((item) => ({ id: null as unknown as string, authorId: meId, createdAt: item.at }))), meId, !!older);
  const seen = useReceipts({ scope: `${dmId}/${rootId}`, fetchReceipts: (list, signal) => dmReceipts(dmId, list, signal), fetchReaders: (list, run, after, signal) => dmReaders(dmId, list, run, after, signal), runs, tick: receiptTick });
  useObservation({ scope: dmId, observe: (list) => observeDmMessages(dmId, list), enabled: canObserve && !!root && !returned.pending, feed,
    ids: (root ? [root, ...shown] : shown).filter((m) => m.authorId !== meId).map((m) => m.id), depend: shown.length });
  const count = root?.replyCount ?? shown.length;

  return (
    <>
      <PanelMeta>{count} {count === 1 ? 'reply' : 'replies'}</PanelMeta>
      <div className="thread__pane dm-thread" data-dm-thread={rootId}>
        <div className="convo-stream">
        <div className={`thread__feed${returned.pending ? ' is-returning' : ''}`} ref={attachFeed}>
          <div className="thread__lift" aria-hidden="true" ref={liftRef} />
          <div className="thread__in dm__in" ref={columnRef}>
            {root ? (
              <ol className="dm__list dm-thread__root" aria-label="Message">
                <DmBubble dmId={dmId} key={root.id} message={root} mine={root.authorId === meId} name={label(root.authorId)} continued={false} groupLast day={null}
                  writable={writable} arrived={false} observed={root.authorId !== meId} nav="thread"
                  onReply={() => field.current?.focus()} onCreateTask={onCreateTask} />
              </ol>
            ) : <p className="thread__hint" role="status">Opening…</p>}
            {/* The head says how many replies there are: the line between the message and them is then only the rule, not the count again (#1374). */}
            <p className="thread__hint">{count ? null : writable ? 'Reply to this message. Only the people in this conversation can read it.' : 'No replies yet.'}</p>
            {older ? <div className="dm__older"><Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Show earlier replies</Button></div> : null}
            <ol className="dm__list thread__list" aria-label="Replies">
              {rows.flatMap(({ line, label: dayLabel, newDay, continued, groupLast }) => {
                const mine = line.authorId === meId;
                if (!line.message) {
                  const item = (line as { item: NonNullable<ReturnType<typeof outbox.pending.at>> }).item;
                  return <DmBubble dmId={dmId} key={`pending-${item.id}`} message={null} pending={item} mine name={meName} continued={continued} groupLast={groupLast} day={newDay ? dayLabel : null}
                    writable={writable} arrived={false} observed={false} nav="thread"
                    onCreateTask={onCreateTask} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} />;
                }
                const message = line.message;
                const starts = message.id === unreadFrom;
                const bubble = <DmBubble dmId={dmId} key={outbox.keyOf(message.id)} message={message} mine={mine} name={mine ? meName : label(message.authorId)} continued={continued} groupLast={groupLast}
                  day={newDay && !starts ? dayLabel : null} writable={writable} arrived={target === message.id} observed={!mine} nav="thread"
                  receipt={seen.get(message.id)}
                  onReply={() => field.current?.focus()} onCreateTask={onCreateTask} />;
                // Where what is new begins (#1246): its day line first, then the divider, then the reply.
                return starts ? [newDay ? <MessageDay key={`day-${message.id}`} label={dayLabel} /> : null, <UnreadDivider key="unread" />, bubble] : bubble;
              })}
            </ol>
            {/* The person's own agent at work in this thread and what it answered them: theirs alone, at the end like a reply about to be sent (#1016). */}
            <PrivateAiLines own assistant={assistant} meId={meId} meName={meName} others={others} composerId="dm-thread-composer"
              lookups={{ projectId: '', messages: [], work: new Map(), author: nameOf, people: [...people.values(), { name: meName }].map((person) => ({ kind: 'human' as const, name: person.name })) }} />
          </div>
        </div>
        <NewBelow count={newBelow.count} onClick={newBelow.toEnd} />
        </div>
        <div className="composer dm__composer dm-thread__composer">
          <div className="composer__in">
            <ComposerBox id="dm-thread-composer" label="Reply in thread" fieldRef={field} value={draft} onChange={(value) => { setAskFailure(''); composer.setBody(value); }} onKeyDown={onKey}
              disabled={!writable} boxDisabled={!writable} placeholder={writable ? 'Reply in thread…' : 'Nobody else is in this conversation'}
              sendLabel={asking ? 'Ask your agent' : 'Send reply'} sendDisabled={!composer.canSend || !writable} onSend={() => void send()} />
            {asking ? <p className="composer__audience" data-asking="true"><Icon name="lock" size={13} /><span>Only you see the answer · {others.join(', ') || 'The others'} {others.length === 1 ? 'sees' : 'see'} only a line that AI was used here</span></p>
              : null}
            <SendAnnouncer pending={composer.pending} />
            {askFailure ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{askFailure}</p> : null}
            {composer.error ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{composer.error}</p> : null}
          </div>
        </div>
      </div>
    </>
  );
}
