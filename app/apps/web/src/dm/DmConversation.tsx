import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import { useSpareHeight } from '../ui/spareHeight';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, Navigate, useLoaderData, useLocation, useNavigate, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import type { Dm, DmMessage, DmPerson, DmTaskCopyResult } from '@flux/contracts';
import { ApiError } from '../api/client';
import { dmReceipts, getDm, observeDmMessages, olderDmMessages } from '../api/direct-messages';
import { ComposerBox } from '../composer/ComposerBox';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { ConnectionLine, SendAnnouncer } from '../composer/Outbox';
import { CiteTile } from '../composer/References';
import { takeHeldCite } from '../app/citeBus';
import { createDmSketch } from '../api/sketches';
import { sketchHref } from '../sketch/format';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { Avatar, Button, Icon, MEDIA, sendsOnEnter, useMediaQuery, useToast } from '../ui';
import { audienceLine, dmTitle, othersIn } from './names';
import { pageBackTo } from '../app/seekMessage';
import { taskHref } from '../sketch/ThoughtTasks';
import { OwnedPanelContent, useOwnedPanel } from '../app/ownedPanel';
import { DmBubble } from './DmBubble';
import { DmTaskCopy } from './DmTaskCopy';
import { DmThreadPanel } from './DmThreadPanel';
import { groupRows } from './rows';
import { ownRuns, useObservation, useReceipts } from '../app/receipts';
import './dm.css';
import { useOriginPanelBack } from '../place/origin';
import { useReturning } from '../place/memory';
import { useMessageReadingPosition } from '../work/readingPosition';
import { useLeftPlace, useReturnPlace } from './returnPlace';

/**
 * One direct message (#107): a private conversation with its audience always in view. Messages
 * reuse the #36 contract (sequence order, `clientMessageId` retries) and the conversation
 * composer. Replies inherit the DM's audience; there is no audience checkbox. Sending is instant
 * (#264): the shared composer queue keeps each message and its client id in this tab until it is
 * stored, so Retry and automatic resends never duplicate a message.
 */
export async function dmLoader({ params, request }: LoaderFunctionArgs): Promise<Dm | null> {
  try {
    return await getDm(params.dmId!, request.signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export function DmConversation() {
  const dm = useLoaderData() as Dm | null;
  const { me } = useShellData();
  // Back to a conversation that was left or closed to this person: the list of conversations, with a line saying so, not a dead end (#592).
  const returning = useReturning();
  if (!dm) return returning ? <Navigate to="/dm" replace state={{ note: 'That conversation is no longer available to you.' }} /> : <DmUnavailable />;
  return <DmContent key={`${me.user.id}:${dm.id}`} initial={dm} />;
}

function DmUnavailable() {
  return (
    <div className="pane-scroll"><div className="pane-in dm-gone" role="alert">
      <Icon name="lock" size={16} />
      <div><h2>This conversation isn’t available</h2><p>It may have been left, or you are no longer in it. Only the people in a direct message can open it.</p>
        <Link className="ui-btn ui-btn--secondary" to="/dm">Back to direct messages</Link></div>
    </div></div>
  );
}

function merge(current: DmMessage[], incoming: DmMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

function DmContent({ initial }: { initial: Dm }) {
  // Touch devices add a line with Enter and send with the button (#189).
  const touch = useMediaQuery(MEDIA.touch);
  const phone = useMediaQuery(MEDIA.phone);
  const { me } = useShellData();
  const revalidator = useRevalidator();
  const audienceId = useId();
  const [dm, setDm] = useState(initial);
  const [messages, setMessages] = useState(initial.messages);
  const [people, setPeople] = useState(() => new Map(initial.people.map((p) => [p.id, p])));
  const [olderCursor, setOlderCursor] = useState(initial.messagePage.nextBeforeSequence);
  const [olderBusy, setOlderBusy] = useState(false);
  // The shared composer record, kept in this tab: the draft and the messages being sent (#264).
  const composer = useComposerDraft(me.user.id, 'dm', `dm:${initial.id}`);
  const captureScope = useComposerScope(composer.key);
  // A thought cited on the map of this conversation's sketch waits here for its composer (#469).
  useEffect(() => { const held = takeHeldCite(`dm:${initial.id}`); if (held) composer.addCite(held); }, [initial.id, composer]);
  const draft = composer.draft.body;
  const [gone, setGone] = useState(false);
  const [leftNotice, setLeftNotice] = useState('');
  const feedRef = useRef<HTMLDivElement | null>(null);
  // The feed element as state too, so the reading-position owner starts once it is on screen.
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((element: HTMLDivElement | null) => { feedRef.current = element; setFeedNode(element); }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef(messages);
  // A message confirmed here shows at once, in its queued place, until the DM's own read includes it.
  const shown = useMemo(() => merge(messages, composer.sent.map((item) => item.message as DmMessage)), [messages, composer.sent]);
  const outbox = outboxView(shown, composer.pending, composer.sent, me.user.id);
  const refreshing = useRef(false);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // #96: selecting messages to start a sketch that stays in this DM.
  const navigate = useNavigate();
  const toast = useToast();
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const startAttempt = useRef<{ ids: string; key: string } | null>(null);
  const selectButtonRef = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const composerBox = useRef<HTMLDivElement>(null);
  const held = useRef<{ anchor: HTMLElement; offset: number } | null>(null);
  const { actionSlot } = useShellActions();
  // #536: the open thread lives in the address (?thread=<root>), so reload and Back reflect the same state.
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const threadId = params.get('thread');
  const [refreshTick, setRefreshTick] = useState(0);
  const [receiptTick, setReceiptTick] = useState(0);
  const opener = useRef<string | null>(null);
  const [replyFocus, setReplyFocus] = useState(false);
  // #537: the task copy being previewed. Nothing is written until it is confirmed there.
  const [copy, setCopy] = useState<{ message: DmMessage; excerpt: string | undefined } | null>(null);

  const title = dmTitle(dm, me.user.id);
  const audience = audienceLine(dm, me.user.id);
  const others = othersIn(dm, me.user.id);
  const nameOf = (id: string) => id === me.user.id ? 'You' : people.get(id)?.name ?? 'Former participant';

  const learn = useCallback((list: DmPerson[]) => setPeople((current) => {
    const next = new Map(current);
    for (const person of list) next.set(person.id, person);
    return next;
  }), []);

  const denied = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && (cause.status === 404 || cause.status === 401)) { setGone(true); revalidator.revalidate(); return true; }
    return false;
  }, [revalidator]);

  const atBottom = () => { const el = feedRef.current; return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80; };
  const toBottom = () => requestAnimationFrame(() => { const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight; });

  /** Fetches the newest window and any replies between it and what is on screen. */
  const refresh = useCallback(async () => {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const latest = await getDm(initial.id);
      const follow = atBottom();
      const newestSeen = messagesRef.current.at(-1)?.sequence ?? 0;
      let incoming = latest.messages;
      let cursor = incoming[0]?.sequence;
      while (newestSeen > 0 && cursor && cursor > newestSeen + 1) {
        const page = await olderDmMessages(initial.id, cursor);
        if (!page.messages.length || page.messages[0]!.sequence >= cursor) break;
        incoming = merge(page.messages, incoming);
        learn(page.people);
        cursor = page.messages[0]?.sequence;
      }
      setDm(latest);
      learn(latest.people);
      setMessages((current) => merge(current, incoming));
      if (follow) toBottom();
    } catch (cause) { denied(cause); }
    finally { refreshing.current = false; }
  }, [denied, initial.id, learn]);

  useStreamEvents(me.user.id, (event) => {
    if (event.objectType !== 'dm' || event.objectId !== initial.id) return;
    // Someone saw a message: only the "Seen by" lines ask again, not the whole conversation.
    if (event.kind === 'dm.observed.v1') { setReceiptTick((tick) => tick + 1); return; }
    void refresh(); setRefreshTick((tick) => tick + 1);
  }, () => { void refresh(); setRefreshTick((tick) => tick + 1); });
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [refresh]);
  // A search result opens on that whole message when it is in the loaded window (#114); otherwise on the latest.
  const hash = location.hash;
  const arrived = hash.startsWith('#message-') ? hash.slice('#message-'.length) : null;
  const arrivedLoaded = !!arrived && messages.some((message) => message.id === arrived);
  // Coming back (#592): the message that was in view returns to where it was, read back to when it is older than the newest window.
  // A link that names a message wins; a reload or a first visit opens on the latest as always.
  const wanted = useLeftPlace('dm-stream', { skip: !!arrived });
  const seekPlace = useCallback(async (elementId: string) => {
    const target = /^message-(.+)$/.exec(elementId)?.[1];
    if (!target || !olderCursor) return false;
    const { pages, cursor, found } = await pageBackTo(target, olderCursor, (before, limit) => olderDmMessages(initial.id, before, undefined, limit));
    for (const page of pages) learn(page.people);
    setMessages((current) => pages.reduce((all, page) => merge(all, page.messages), current));
    setOlderCursor(cursor);
    return found;
  }, [initial.id, learn, olderCursor]);
  const returned = useReturnPlace({ wanted, loaded: true, have: (id) => messages.some((message) => `message-${message.id}` === id), hasOlder: olderCursor !== null, seek: seekPlace });
  useMessageReadingPosition(feedRef, returned.pending ? null : feedNode, !returned.pending, '', returned.restore, 'dm-stream');
  // Older than the loaded window: page back until the message is loaded, then show it.
  useEffect(() => {
    if (!arrived || arrivedLoaded || !olderCursor) return;
    let cancelled = false;
    void pageBackTo(arrived, olderCursor, (before, limit) => olderDmMessages(initial.id, before, undefined, limit)).then(({ pages, cursor }) => {
      if (cancelled) return;
      for (const page of pages) learn(page.people);
      setMessages((current) => pages.reduce((all, page) => merge(all, page.messages), current));
      setOlderCursor(cursor);
    }).catch((cause: unknown) => { denied(cause); });
    return () => { cancelled = true; };
    // Seek once per target; later pages come from "Show earlier messages".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrived]);
  useLayoutEffect(() => {
    const anchor = arrived ? document.getElementById(`message-${arrived}`) : null;
    if (anchor) { anchor.scrollIntoView({ block: 'start' }); anchor.focus({ preventScroll: true }); return; }
    // A return positions itself, once its message is loaded; everything else opens on the latest.
    if (returned.pending || returned.restore) return;
    const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [arrived, arrivedLoaded, returned.pending, returned.restore]);

  const autosize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };
  // The field follows its text, including when Send empties it at once.
  useLayoutEffect(autosize, [draft]);

  function change(value: string) {
    typing.input(Boolean(value.trim()));
    composer.setBody(value);
  }

  async function send() {
    typing.stop();
    if (recipientGone) return;
    // The message shows at once at the end, marked "Sending…", and the field empties (#264).
    const outcome = composer.submit(shown.at(-1)?.sequence ?? 0);
    if (!outcome) return;
    const active = captureScope();
    toBottom();
    const result = await outcome;
    if (!active()) return;
    if (result.status === 'delivered') {
      setMessages((current) => merge(current, [result.message as DmMessage]));
      return;
    }
    if (result.status !== 'failed') return;
    const cause = result.cause;
    if (cause instanceof ApiError && (cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE')) {
      // The other person left meanwhile: nothing was stored. The text is back in the field; show why, refresh.
      setLeftNotice(cause.message); void refresh();
      return;
    }
    denied(cause);
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (sendsOnEnter(event, touch)) { event.preventDefault(); void send(); }
  }

  async function loadOlder() {
    if (!olderCursor || olderBusy) return;
    setOlderBusy(true);
    const el = feedRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      const page = await olderDmMessages(initial.id, olderCursor);
      learn(page.people);
      setMessages((current) => merge(current, page.messages));
      setOlderCursor(page.messagePage.nextBeforeSequence);
      requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before; });
    } catch (cause) { denied(cause); }
    finally { setOlderBusy(false); }
  }

  function toggleSelecting(on: boolean) {
    // The swap of the composer and the selection bar must not move what the person is reading (#594): remember the first
    // message in view and give the bar the composer's height, then put the message back where it was once both have changed.
    const feed = feedRef.current;
    if (feed) {
      const top = feed.getBoundingClientRect().top;
      const anchor = [...feed.querySelectorAll<HTMLElement>('.dm-msg[data-message-id]')].find((item) => item.getBoundingClientRect().bottom > top);
      held.current = anchor ? { anchor, offset: anchor.getBoundingClientRect().top - top } : null;
    }
    if (on) root.current?.style.setProperty('--dm-swap', `${composerBox.current?.offsetHeight ?? 0}px`);
    setSelecting(on);
    setPicked([]);
    requestAnimationFrame(() => {
      if (on) feedRef.current?.querySelector<HTMLElement>('.dm-msel')?.focus({ preventScroll: true });
      else selectButtonRef.current?.focus({ preventScroll: true });
    });
  }
  // Entering or leaving the selection changes the height of what sits under the messages, and a long own message on a
  // phone wraps once more beside the check: the message the person was on goes back to its place before anything paints.
  useLayoutEffect(() => {
    const feed = feedRef.current;
    const was = held.current;
    held.current = null;
    if (!feed || !was || !was.anchor.isConnected) return;
    const shift = was.anchor.getBoundingClientRect().top - feed.getBoundingClientRect().top - was.offset;
    if (Math.abs(shift) >= 0.5) feed.scrollTop += shift;
  }, [selecting]);
  const pick = (id: string) => setPicked((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  async function startSketch() {
    if (!picked.length || starting) return;
    // In conversation order, whatever order they were picked in; a retry reuses its key.
    const ids = messages.filter((m) => picked.includes(m.id)).map((m) => m.id);
    const signature = ids.join(',');
    if (startAttempt.current?.ids !== signature) startAttempt.current = { ids: signature, key: crypto.randomUUID() };
    setStarting(true);
    try {
      const sketch = await createDmSketch(dm.workspaceId, dm.id, `From ${ids.length} ${ids.length === 1 ? 'message' : 'messages'}`, ids, startAttempt.current.key);
      startAttempt.current = null;
      navigate(sketchHref(sketch), { state: { fresh: true, started: ids.length } });
    } catch (cause) {
      setStarting(false);
      if (cause instanceof ApiError && (cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE')) {
        setLeftNotice(cause.message); setSelecting(false); setPicked([]); void refresh();
        return;
      }
      if (!denied(cause)) toast({ message: 'The sketch couldn’t be started. Your selection is kept; try again.', tone: 'danger' });
    }
  }

  // Stored messages, then the ones being sent, grouped by day and author as one list.
  const lines = [...shown.map((message) => ({ message, item: null, authorId: message.authorId, at: message.createdAt })),
    ...outbox.pending.map((item) => ({ message: null, item, authorId: me.user.id, at: item.at }))];
  const rows = groupRows(lines);
  // A short conversation sits against its composer instead of at the top of a tall screen (ui/spareHeight.ts).
  const columnRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef<HTMLDivElement>(null);
  useSpareHeight(feedRef, columnRef, liftRef, rows.length, feedNode);
  // #534: what this person observed, and who observed every message of their own whole runs.
  const feedBox = feedRef;
  useObservation({ scope: dm.id, observe: (ids) => observeDmMessages(dm.id, ids), enabled: !gone && !selecting && !returned.pending, feed: feedBox,
    ids: shown.filter((m) => m.authorId !== me.user.id).map((m) => m.id), depend: shown.length });
  const runs = ownRuns(lines.map((line) => ({ id: line.message?.id ?? null, authorId: line.authorId, createdAt: line.at })), me.user.id, olderCursor !== null);
  const seen = useReceipts({ scope: dm.id, fetchReceipts: (list, signal) => dmReceipts(dm.id, list, signal), runs, tick: receiptTick + refreshTick });

  function openThread(rootId: string, reply: boolean) {
    opener.current = rootId;
    setReplyFocus(reply);
    const next = new URLSearchParams(params);
    next.set('thread', rootId);
    // Opening another thread replaces the open one, so closing is still one step back to the conversation.
    // The entry's state, with the origin the page was followed from, stays when a thread replaces a thread (#592).
    setParams(next, { replace: !!threadId, state: threadId ? { ...(location.state as object | null), dmThread: true } : { dmThread: true } });
  }
  function closeThread() {
    const target = opener.current ?? threadId;
    opener.current = null;
    if ((location.state as { dmThread?: boolean } | null)?.dmThread) navigate(-1);
    else { const next = new URLSearchParams(params); next.delete('thread'); setParams(next, { replace: true, state: location.state }); }
    setReplyFocus(false);
    // The message that opened it takes focus back, with the reading position where it was.
    requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById(`message-${target}`)?.focus({ preventScroll: true })));
  }
  const threadDenied = useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 404 && !denied(cause)) return;
    denied(cause);
  }, [denied]);
  const threadCount = useCallback((rootId: string, replies: number) => {
    setMessages((current) => current.some((m) => m.id === rootId && m.replyCount !== replies) ? current.map((m) => m.id === rootId ? { ...m, replyCount: replies } : m) : current);
  }, []);
  const copyTrigger = useRef<string | null>(null);
  function startCopy(message: DmMessage, excerpt: string | undefined) {
    copyTrigger.current = message.id;
    setCopy({ message, excerpt });
  }
  function stopCopy() {
    const target = copyTrigger.current;
    setCopy(null);
    requestAnimationFrame(() => (target ? document.getElementById(`message-${target}`) : null)?.focus({ preventScroll: true }));
  }
  function copied(result: DmTaskCopyResult) {
    stopCopy();
    toast({ message: `Task created in ${result.project.name}`, action: { label: 'Open task', onClick: () => navigate(taskHref(result.project.id, result.task.id)) } });
  }

  // A 1:1 whose other person left (or was removed) has nobody to send to: say so, disable sending.
  const counterpart = dm.kind === 'pair' ? dm.counterpart : null;
  const recipientGone = Boolean(counterpart && !dm.participants.some((p) => p.id === counterpart.id));
  const goneNotice = recipientGone
    ? leftNotice || `${counterpart!.name.split(/\s+/)[0]} left this conversation. They can reopen it by messaging you.`
    : '';
  const typing = useTyping(me.user.id, !gone && !selecting ? { kind: 'dm', id: dm.id } : null, !recipientGone);
  const threadOpen = !!threadId && !!messages.length && !gone;
  const originBack = useOriginPanelBack();
  const slot = useOwnedPanel(threadOpen ? { key: `dm-thread:${threadId}`, chip: 'Thread', label: 'Replies', startFull: true, ...(originBack ? { origin: originBack } : {}), onClose: closeThread } : null);
  if (gone) return <DmUnavailable />;
  const canSend = composer.canSend && !recipientGone;
  // On the phone the header keeps only Back, the title, Together and Search (Spokój #507): choosing starts by the composer.
  const canChoose = messages.length > 0 && !recipientGone;
  const selectButton = actionSlot && canChoose && !phone ? createPortal(
    <Button ref={selectButtonRef} variant="quiet" icon="check" aria-pressed={selecting} className="dm-select-btn" onClick={() => toggleSelecting(!selecting)}>Choose messages</Button>,
    actionSlot,
  ) : null;
  return (
    <div className="convo-split dm-split">
    <div className="convo-split__stream">
    <div ref={root} className={`dm${selecting ? ' dm--selecting' : ''}`} data-dm-id={dm.id}
      onKeyDown={(event) => { if (selecting && event.key === 'Escape') { event.preventDefault(); toggleSelecting(false); } }}>
      {selectButton}
      <div className={`dm__feed${returned.pending ? ' is-returning' : ''}`} ref={attachFeed}>
        <div className="dm__lift" aria-hidden="true" ref={liftRef} />
        <div className="dm__in" ref={columnRef}>
          {olderCursor ? null : (
            // The start of the conversation: who is in it. The top bar keeps the name and audience in view.
            <header className="dm__head">
              <span className="dm__faces" aria-hidden="true">
                {(others.length ? others : dm.counterpart ? [dm.counterpart] : [{ id: me.user.id, name: me.user.name }]).slice(0, 3).map((person) => <Avatar key={person.id} name={person.name} size="lg" />)}
              </span>
              <div className="dm__who">
                <h2>{title}</h2>
                <p><Icon name="lock" size={12} /> {audience} can read this conversation. It stays outside every project.</p>
              </div>
            </header>
          )}
          {olderCursor ? <div className="dm__older"><Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Show earlier messages</Button></div> : null}
          {rows.length ? (
            <ol className="dm__list" aria-label="Messages">
              {rows.map(({ line, label, newDay, continued, groupLast }) => {
                if (!line.message) {
                  const item = line.item!;
                  return <DmBubble key={`pending-${item.id}`} message={null} pending={item} mine name={me.user.name} continued={continued} groupLast={groupLast} day={newDay ? label : null}
                    writable={!recipientGone} selecting={false} picked={false} arrived={false} observed={false} seenBy={[]} nav="stream"
                    onCreateTask={startCopy} onPick={pick} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} />;
                }
                const message = line.message;
                const mine = message.authorId === me.user.id;
                // A message confirmed from its queued one keeps that list item: nothing moves (#264).
                return <DmBubble key={outbox.keyOf(message.id)} message={message} mine={mine} name={mine ? me.user.name : nameOf(message.authorId)} continued={continued} groupLast={groupLast}
                  day={newDay ? label : null} writable={!recipientGone} selecting={selecting} picked={selecting && picked.includes(message.id)} arrived={arrived === message.id}
                  observed={!mine} seenBy={(seen.get(message.id) ?? []).map((p) => p.name)} nav="stream"
                  onReply={() => openThread(message.id, true)} onOpenThread={(root) => openThread(root.id, false)} onCreateTask={startCopy} onPick={pick} />;
              })}
            </ol>
          ) : (
            <p className="dm__first">No messages yet. Say hello{others.length === 1 ? ` to ${others[0]!.name.split(/\s+/)[0]}` : ''}.</p>
          )}
        </div>
      </div>
      {selecting ? (
        <div className="dm-selbar" role="region" aria-label="Selected messages">
          <div className="dm-selbar__in">
            <span className="dm-selbar__count" role="status">{picked.length ? `${picked.length} ${picked.length === 1 ? 'message' : 'messages'} selected` : 'Choose the messages to sketch from'}</span>
            <Button variant="quiet" onClick={() => toggleSelecting(false)}>Cancel</Button>
            <Button variant="primary" icon="map" busy={starting} aria-disabled={!picked.length || undefined} onClick={() => void startSketch()}>Start sketch from these messages</Button>
            <p className="dm-selbar__note"><Icon name="lock" size={12} />The sketch stays in this conversation: {audience.replace(/^Only /, 'only ')} can see it. No project is created.</p>
          </div>
        </div>
      ) : null}
      <div ref={composerBox} className="composer dm__composer" hidden={selecting}>
        <div className="composer__in">
          {goneNotice ? <p className="dm__notice" role="status"><Icon name="lock" size={13} />{goneNotice}</p> : null}
          <ConnectionLine />
          {composer.draft.cites.map((cite) => <CiteTile key={`${cite.kind}:${cite.id}`} cite={cite} disabled={composer.sending} onRemove={() => composer.removeCite(cite.kind, cite.id)} />)}
          <ComposerBox id="dm-composer" label={`Message ${title}`} fieldRef={textareaRef} value={draft} onChange={(value) => change(value)} onBlur={typing.stop} onKeyDown={onKey}
            disabled={recipientGone} boxDisabled={recipientGone} placeholder={recipientGone ? 'Nobody else is in this conversation' : `Message ${others.length === 1 ? others[0]!.name.split(/\s+/)[0] : title}…`}
            fieldProps={{ 'aria-describedby': audienceId }} sendLabel="Send message" sendDisabled={!canSend} onSend={() => void send()} />
          <p className="composer__audience"><Icon name="lock" size={13} /><span id={audienceId}>{audience}<span aria-hidden="true"> · </span><span className="composer__where">direct message</span></span>
            {phone && canChoose ? <Button ref={selectButtonRef} variant="quiet" icon="check" className="dm-select-btn dm-select-btn--phone" onClick={() => toggleSelecting(true)}>Choose messages</Button> : null}</p>
          <TypingNotice {...typing} />
          <SendAnnouncer pending={composer.pending} />
          {composer.error && composer.error !== goneNotice ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{composer.error}</p> : null}
          <p hidden className="composer__hint" ><span className="composer__keys">Enter sends · Shift+Enter adds a line · </span>Unsent text stays in this tab</p>
        </div>
      </div>
    </div>
    </div>
    {threadOpen && slot ? (
      <OwnedPanelContent slot={slot} className="thread" id="thread">
      <DmThreadPanel key={threadId} dmId={dm.id} rootId={threadId!} meId={me.user.id} meName={me.user.name} nameOf={nameOf}
        audience={audience} writable={!recipientGone} refreshTick={refreshTick} receiptTick={receiptTick} focusComposer={replyFocus} canObserve
        onDenied={threadDenied} onCreateTask={startCopy} onCount={threadCount} />
      </OwnedPanelContent>) : null}
    {copy ? <DmTaskCopy dmId={dm.id} message={copy.message} excerpt={copy.excerpt} participants={dm.participants} onClose={() => stopCopy()}
      onCreated={copied} onUnavailable={(cause) => { setLeftNotice(cause instanceof ApiError && cause.code?.startsWith('DM_RECIPIENT') ? cause.message : leftNotice); void refresh(); denied(cause); }} /> : null}
    </div>
  );
}
