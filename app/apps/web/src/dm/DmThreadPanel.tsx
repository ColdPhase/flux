import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DmMessage, DmPerson, DmThread } from '@flux/contracts';
import { dmReceipts, getDmThread, observeDmMessages, olderDmReplies } from '../api/direct-messages';
import { ComposerBox } from '../composer/ComposerBox';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { SendAnnouncer } from '../composer/Outbox';
import { Button, Icon, MEDIA, PanelMeta, sendsOnEnter, useMediaQuery } from '../ui';
import '../app/one-conversation.css';
import { DmBubble } from './DmBubble';
import { groupRows } from './rows';
import { ownRuns, useObservation, useReceipts } from '../app/receipts';
import { pageBackTo } from '../app/seekMessage';
import { useMessageReadingPosition } from '../work/readingPosition';
import { useLeftPlace, useReturnPlace } from './returnPlace';
import { useSpareHeight } from '../ui/spareHeight';

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
export function DmThreadPanel({ dmId, rootId, meId, meName, nameOf, audience, writable, refreshTick, receiptTick, focusComposer, canObserve,
  onDenied, onCreateTask, onCount }: {
  dmId: string; rootId: string; meId: string; meName: string; nameOf: (id: string) => string; audience: string; writable: boolean;
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
  const feed = useRef<HTMLDivElement | null>(null);
  // The feed element as state too, so the reading-position owner starts once it is on screen.
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((element: HTMLDivElement | null) => { feed.current = element; setFeedNode(element); }, []);
  const field = useRef<HTMLTextAreaElement>(null);
  const loading = useRef(false);
  const composer = useComposerDraft(meId, 'dm', `dm:${dmId}/${rootId}`);
  const captureScope = useComposerScope(composer.key);
  const draft = composer.draft.body;
  const shown = useMemo(() => merge(replies, composer.sent.map((item) => item.message as DmMessage)), [replies, composer.sent]);
  const outbox = outboxView(shown, composer.pending, composer.sent, meId);

  const learn = useCallback((list: DmPerson[]) => setPeople((current) => { const next = new Map(current); for (const p of list) next.set(p.id, p); return next; }), []);
  const label = (id: string) => (people.get(id)?.name ?? nameOf(id));
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await getDmThread(dmId, rootId);
      setThread(next); learn(next.people);
      setReplies((current) => merge(current, next.replies));
      setOlder((current) => (current === undefined ? next.messagePage.nextBeforeSequence : current));
      onCount(rootId, next.root.replyCount);
    } catch (cause) { onDenied(cause); }
    finally { loading.current = false; }
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
  useLayoutEffect(() => {
    // A return positions itself, once its reply is loaded.
    if (returned.pending || returned.restore) return;
    const el = feed.current;
    if (el && (opening || stick.current)) el.scrollTop = el.scrollHeight;
  }, [opening, shown.length, returned.pending, returned.restore]);
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

  async function send() {
    if (!writable) return;
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
  const lines = [...shown.map((message) => ({ message, authorId: message.authorId, at: message.createdAt })),
    ...outbox.pending.map((item) => ({ message: null, item, authorId: meId, at: item.at }))];
  const rows = groupRows(lines);
  // A short thread sits against its reply field instead of at the top of a tall panel (ui/spareHeight.ts).
  const columnRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef<HTMLDivElement>(null);
  useSpareHeight(feed, columnRef, liftRef, (root ? 1 : 0) + rows.length, feedNode);
  const runs = ownRuns(shown.map((m) => ({ id: m.id, authorId: m.authorId, createdAt: m.createdAt })).concat(outbox.pending.map((item) => ({ id: null as unknown as string, authorId: meId, createdAt: item.at }))), meId, !!older);
  const seen = useReceipts({ scope: `${dmId}/${rootId}`, fetchReceipts: (list, signal) => dmReceipts(dmId, list, signal), runs, tick: receiptTick });
  useObservation({ scope: dmId, observe: (list) => observeDmMessages(dmId, list), enabled: canObserve && !!root && !returned.pending, feed,
    ids: (root ? [root, ...shown] : shown).filter((m) => m.authorId !== meId).map((m) => m.id), depend: shown.length });
  const count = root?.replyCount ?? shown.length;

  return (
    <>
      <PanelMeta>{count} {count === 1 ? 'reply' : 'replies'}</PanelMeta>
      <div className="thread__pane dm-thread" data-dm-thread={rootId}>
        <div className={`thread__feed${returned.pending ? ' is-returning' : ''}`} ref={attachFeed}>
          <div className="thread__lift" aria-hidden="true" ref={liftRef} />
          <div className="thread__in dm__in" ref={columnRef}>
            {root ? (
              <ol className="dm__list dm-thread__root" aria-label="Message">
                <DmBubble key={root.id} message={root} mine={root.authorId === meId} name={label(root.authorId)} continued={false} groupLast day={null}
                  writable={writable} selecting={false} picked={false} arrived={false} observed={root.authorId !== meId} seenBy={[]} nav="thread"
                  onReply={() => field.current?.focus()} onCreateTask={onCreateTask} onPick={() => undefined} />
              </ol>
            ) : <p className="thread__hint" role="status">Opening…</p>}
            <p className="thread__hint">{count ? `${count} ${count === 1 ? 'reply' : 'replies'}` : writable ? 'Reply to this message. Only the people in this conversation can read it.' : 'No replies yet.'}</p>
            {older ? <div className="dm__older"><Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Show earlier replies</Button></div> : null}
            <ol className="dm__list thread__list" aria-label="Replies">
              {rows.map(({ line, label: dayLabel, newDay, continued, groupLast }) => {
                const mine = line.authorId === meId;
                if (!line.message) {
                  const item = (line as { item: NonNullable<ReturnType<typeof outbox.pending.at>> }).item;
                  return <DmBubble key={`pending-${item.id}`} message={null} pending={item} mine name={meName} continued={continued} groupLast={groupLast} day={newDay ? dayLabel : null}
                    writable={writable} selecting={false} picked={false} arrived={false} observed={false} seenBy={[]} nav="thread"
                    onCreateTask={onCreateTask} onPick={() => undefined} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} />;
                }
                const message = line.message;
                return <DmBubble key={outbox.keyOf(message.id)} message={message} mine={mine} name={mine ? meName : label(message.authorId)} continued={continued} groupLast={groupLast}
                  day={newDay ? dayLabel : null} writable={writable} selecting={false} picked={false} arrived={false} observed={!mine} nav="thread"
                  seenBy={(seen.get(message.id) ?? []).map((p) => p.name)}
                  onReply={() => field.current?.focus()} onCreateTask={onCreateTask} onPick={() => undefined} />;
              })}
            </ol>
          </div>
        </div>
        <div className="composer dm__composer dm-thread__composer">
          <div className="composer__in">
            <ComposerBox id="dm-thread-composer" label="Reply in thread" fieldRef={field} value={draft} onChange={(value) => composer.setBody(value)} onKeyDown={onKey}
              disabled={!writable} boxDisabled={!writable} placeholder={writable ? 'Reply in thread…' : 'Nobody else is in this conversation'}
              sendLabel="Send reply" sendDisabled={!composer.canSend || !writable} onSend={() => void send()} />
            <p className="composer__audience"><Icon name="lock" size={13} /><span>{audience}<span aria-hidden="true"> · </span><span className="composer__where">private reply</span></span></p>
            <SendAnnouncer pending={composer.pending} />
            {composer.error ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{composer.error}</p> : null}
          </div>
        </div>
      </div>
    </>
  );
}
