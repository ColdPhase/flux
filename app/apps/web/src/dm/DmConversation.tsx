import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import { useSpareHeight } from '../ui/spareHeight';
import { NewBelow, UNREAD_READ_BACK, UnreadDivider, countBelow, openAtUnread, useNewBelow } from '../app/unreadReading';
import { MessageDay } from '../app/messageParts';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLoaderData, useLocation, useNavigate, useRevalidator, useSearchParams, type LoaderFunctionArgs } from 'react-router';
import { NavigateWithNote } from '../app/NavigateWithNote';
import type { Dm, DmMessage, DmPerson, DmTaskCopyResult } from '@flux/contracts';
import { ApiError } from '../api/client';
import { dmReaders, dmReceipts, getDm, observeDmMessages, olderDmMessages } from '../api/direct-messages';
import { ComposerBox } from '../composer/ComposerBox';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { ConnectionLine, SendAnnouncer } from '../composer/Outbox';
import { askError, askState } from '../assistant/format';
import { PrivateAiLines, firstNames } from '../assistant/PrivateAiLines';
import { useConversationAssistant } from '../assistant/useConversationAssistant';
import { useFollowEnd } from '../assistant/useFollowEnd';
import { noteAssistantUse } from '../assistant/MeetAssistant';
import { CiteTile } from '../composer/References';
import { takeHeldCite } from '../app/citeBus';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { Avatar, Button, Icon, MEDIA, sendsOnEnter, useArrivals, useMediaQuery, useToast } from '../ui';
import { audienceLine, dmTitle, othersIn } from './names';
import { pageBackTo } from '../app/seekMessage';
import { taskHref } from '../sketch/ThoughtTasks';
import { OwnedPanelContent, useOwnedPanel } from '../app/ownedPanel';
import { DmBubble } from './DmBubble';
import { onMessageChanged } from '../conversations/messageChanges';
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
  if (!dm) return returning ? <NavigateWithNote to="/dm" note="That conversation is no longer available to you." /> : <DmUnavailable />;
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
  const { me, workspace } = useShellData();
  const revalidator = useRevalidator();
  const audienceId = useId();
  const [dm, setDm] = useState(initial);
  const [messages, setMessages] = useState(initial.messages);
  const [people, setPeople] = useState(() => new Map(initial.people.map((p) => [p.id, p])));
  const [olderCursor, setOlderCursor] = useState(initial.messagePage.nextBeforeSequence);
  // Where the person left off (#1246), as this conversation was opened: the "New" divider stands above this message and opening scrolls to it
  // (a conversation never opened: its first message, from the very top). Later reads move it (what is seen is read), so it is kept as it was.
  const [unreadFrom, setUnreadFrom] = useState(initial.unreadFrom ?? null);
  const [olderBusy, setOlderBusy] = useState(false);
  // The shared composer record, kept in this tab: the draft and the messages being sent (#264).
  const composer = useComposerDraft(me.user.id, 'dm', `dm:${initial.id}`);
  const captureScope = useComposerScope(composer.key);
  // A thought cited on the map of this conversation's sketch waits here for its composer (#469).
  useEffect(() => { const held = takeHeldCite(`dm:${initial.id}`); if (held) composer.addCite(held); }, [initial.id, composer]);
  const draft = composer.draft.body;
  const [gone, setGone] = useState(false);
  // `/ai` in this conversation (#842): the answer is the asker's alone, and both people see one line that AI was used here.
  const [askFailure, setAskFailure] = useState('');
  // A guest has no AI (AG-2): `/ai` is only words for them.
  const asking = workspace?.role !== 'guest' && /^\/ai(\s|$)/.test(draft);
  const [leftNotice, setLeftNotice] = useState('');
  const feedRef = useRef<HTMLDivElement | null>(null);
  // The feed element as state too, so the reading-position owner starts once it is on screen.
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((element: HTMLDivElement | null) => { feedRef.current = element; setFeedNode(element); }, []);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef(messages);
  // The author edited or deleted a root here (#1006): it is replaced at once; a reply is the thread panel's.
  useEffect(() => onMessageChanged((message) => {
    if (message.conversationId === initial.id && !(message as DmMessage).threadRootId) setMessages((current) => merge(current, [message as DmMessage]));
  }), [initial.id]);
  // A message confirmed here shows at once, in its queued place, until the DM's own read includes it; then the stored copy wins,
  // so a message its author edited or deleted since shows the new words (#1006), not the ones it was sent with.
  const shown = useMemo(() => merge(composer.sent.map((item) => item.message as DmMessage), messages), [messages, composer.sent]);
  const outbox = outboxView(shown, composer.pending, composer.sent, me.user.id);
  const refreshing = useRef(false);
  const refreshAgain = useRef(false);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  const navigate = useNavigate();
  const toast = useToast();
  const root = useRef<HTMLDivElement>(null);
  // #536: the open thread lives in the address (?thread=<root>), so reload and Back reflect the same state.
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const threadId = params.get('thread');
  const [refreshTick, setRefreshTick] = useState(0);
  const [receiptTick, setReceiptTick] = useState(0);
  const opener = useRef<string | null>(null);
  const [replyFocus, setReplyFocus] = useState(false);
  // A notice's Reply (#1243) arrives asking to write: the composer takes focus, once per arrival.
  useEffect(() => {
    if (!(location.state as { focusComposer?: boolean } | null)?.focusComposer) return undefined;
    const frame = requestAnimationFrame(() => document.getElementById('dm-composer')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
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
    // A change that is told while a read is on its way asks for one more when it ends: that read may have been made before the change was stored.
    if (refreshing.current) { refreshAgain.current = true; return; }
    refreshing.current = true;
    try {
      do {
        refreshAgain.current = false;
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
      } while (refreshAgain.current);
    } finally { refreshing.current = false; }
  }, [denied, initial.id, learn]);

  const assistant = useConversationAssistant({ meId: me.user.id, place: { kind: 'dm', dmId: initial.id, threadRootId: null }, onShown: () => { void refresh(); toBottom(); } });
  // A new answer, or the agent at work, comes into view at the end, also when the working line becomes the taller answer (#842).
  const privateItems = [...assistant.privateAnswers.map((item) => item.id), assistant.run?.id ?? ''].join(',');
  useFollowEnd(() => feedRef.current, privateItems.replaceAll(',', '') ? privateItems : '', assistant.run?.id ?? null);
  useStreamEvents(me.user.id, (event) => {
    // A notice (#1243) is for the notice card; the message it is about came as its own event.
    if (event.objectType !== 'dm' || event.objectId !== initial.id || event.kind === 'dm.notice.v1') return;
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
  // Older than the loaded window: page back until the message is loaded, then show it. A link names a message; with none, the first new one does (#1246).
  const unreadWanted = !arrived && !wanted && !!unreadFrom;
  const seek = arrived ?? (unreadWanted ? unreadFrom : null);
  const [sought, setSought] = useState(false);
  useEffect(() => {
    if (!seek || messages.some((message) => message.id === seek) || !olderCursor) return;
    let cancelled = false;
    // The first new message is read back to a page or two at most (#862): beyond that all that is loaded is new, and the divider goes above the oldest of it.
    const forUnread = !arrived && seek === unreadFrom;
    void pageBackTo(seek, olderCursor, (before, limit) => olderDmMessages(initial.id, before, undefined, limit), forUnread ? UNREAD_READ_BACK : undefined).then(({ pages, cursor, found }) => {
      if (cancelled) return;
      for (const page of pages) learn(page.people);
      setMessages((current) => pages.reduce((all, page) => merge(all, page.messages), current));
      setOlderCursor(cursor);
      const oldest = pages.at(-1)?.messages[0];
      if (forUnread && !found && oldest) setUnreadFrom(oldest.id);
    }).catch((cause: unknown) => { denied(cause); }).finally(() => { if (!cancelled) setSought(true); });
    return () => { cancelled = true; };
    // Seek once per target; later pages come from "Show earlier messages".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seek]);
  // The divider is where the conversation opens once its message is loaded; until then (and when it never loads) it opens on the latest.
  const unreadLoaded = unreadWanted && messages.some((message) => message.id === unreadFrom);
  const waitingForUnread = unreadWanted && !unreadLoaded && olderCursor !== null && !sought;
  const columnRef = useRef<HTMLDivElement>(null);
  const unreadPlaced = useRef(false);
  const stopUnread = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const anchor = arrived ? document.getElementById(`message-${arrived}`) : null;
    if (anchor) { anchor.scrollIntoView({ block: 'start' }); anchor.focus({ preventScroll: true }); return; }
    // A return positions itself, once its message is loaded; everything else opens on the latest, or on what is new.
    if (returned.pending || returned.restore || waitingForUnread) return;
    const el = feedRef.current;
    if (!el) return;
    if (unreadLoaded && !unreadPlaced.current) {
      unreadPlaced.current = true;
      stopUnread.current = openAtUnread(el, columnRef.current);
      if (stopUnread.current) return;
    }
    if (!stopUnread.current) el.scrollTop = el.scrollHeight;
  }, [arrived, arrivedLoaded, returned.pending, returned.restore, unreadLoaded, waitingForUnread]);
  useEffect(() => () => stopUnread.current?.(), []);

  const autosize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };
  // The field follows its text, including when Send empties it at once.
  useLayoutEffect(autosize, [draft]);

  function change(value: string) {
    setAskFailure('');
    typing.input(Boolean(value.trim()) && !/^\/ai(\s|$)/.test(value));
    composer.setBody(value);
  }

  /** `/ai …` asks the person's agent; the words are not a message (#842). */
  async function askAgent() {
    const prompt = draft.replace(/^\/ai\s*/, '').trim();
    const state = askState(assistant.status, false, workspace?.role === 'guest');
    if (!prompt) { setAskFailure('Say what to ask after /ai, for example /ai summarise this conversation.'); return; }
    if (state.kind !== 'ready') { setAskFailure(state.note); return; }
    const active = captureScope();
    setAskFailure('');
    noteAssistantUse(me.user.id);
    try {
      await assistant.ask(prompt);
      if (!active()) return;
      composer.setBody('');
      toBottom();
      void refresh();
    } catch (cause) { if (active()) setAskFailure(askError(cause)); }
  }

  async function send() {
    typing.stop();
    if (recipientGone) return;
    if (asking) { await askAgent(); return; }
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

  // Stored messages, then the ones being sent, grouped by day and author as one list.
  const lines = [...shown.map((message) => ({ message, item: null, authorId: message.notice ? `~${message.id}` : message.authorId, via: message.via ?? null, at: message.createdAt })),
    ...outbox.pending.map((item) => ({ message: null, item, authorId: me.user.id, at: item.at }))];
  const rows = groupRows(lines, (line) => !!line.message && line.message.id === unreadFrom);
  // A short conversation sits against its composer instead of at the top of a tall screen (ui/spareHeight.ts).
  const liftRef = useRef<HTMLDivElement>(null);
  useSpareHeight(feedRef, columnRef, liftRef, rows.length, feedNode);
  // What arrives while the person reads above the end is counted in "↓ N new" (#1246); nothing moves under them.
  const newBelow = useNewBelow(feedNode);
  const entryIds = [...shown.map((message) => `message-${message.id}`), ...outbox.pending.map((item) => `pending-${item.id}`)];
  useArrivals(feedRef, entryIds, (id) => document.getElementById(id), (arrivedIds, following) => {
    if (!following) newBelow.add(countBelow(feedRef.current, arrivedIds, (id) => document.getElementById(id)));
  }, { animate: false });
  // #534: what this person observed, and who observed every message of their own whole runs.
  const feedBox = feedRef;
  // Nothing is seen while the feed is hidden for its read-back to the first new message.
  useObservation({ scope: dm.id, observe: (ids) => observeDmMessages(dm.id, ids), enabled: !gone && !returned.pending && !waitingForUnread, feed: feedBox,
    ids: shown.filter((m) => m.authorId !== me.user.id && !m.notice).map((m) => m.id), depend: shown.length });
  const runs = ownRuns(lines.map((line) => ({ id: line.message?.id ?? null, authorId: line.authorId, createdAt: line.at })), me.user.id, olderCursor !== null);
  const seen = useReceipts({ scope: dm.id, fetchReceipts: (list, signal) => dmReceipts(dm.id, list, signal), fetchReaders: (list, run, after, signal) => dmReaders(dm.id, list, run, after, signal), runs, tick: receiptTick + refreshTick });

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
  const typing = useTyping(me.user.id, !gone ? { kind: 'dm', id: dm.id } : null, !recipientGone);
  const threadOpen = !!threadId && !!messages.length && !gone;
  const originBack = useOriginPanelBack();
  const slot = useOwnedPanel(threadOpen ? { key: `dm-thread:${threadId}`, chip: 'Thread', label: 'Replies', ...(originBack ? { origin: originBack } : {}), onClose: closeThread } : null);
  if (gone) return <DmUnavailable />;
  const canSend = composer.canSend && !recipientGone;
  return (
    <div className="convo-split dm-split">
    <div className="convo-split__stream">
    <div ref={root} className="dm" data-dm-id={dm.id}>
      <div className="convo-stream">
      <div className={`dm__feed${returned.pending || waitingForUnread ? ' is-returning' : ''}`} ref={attachFeed}>
        <div className="dm__lift" aria-hidden="true" ref={liftRef} />
        <div className="dm__in" ref={columnRef}>
          {olderCursor ? null : (
            // The start of the conversation: who is in it. The top bar keeps the name and audience in view.
            <header className="dm__head">
              <span className="dm__faces" aria-hidden="true">
                {(others.length ? others : dm.counterpart ? [dm.counterpart] : [{ id: me.user.id, name: me.user.name }]).slice(0, 3).map((person) => <Avatar key={person.id} name={person.name} id={person.id} size="lg" />)}
              </span>
              <div className="dm__who">
                <h2>{title}</h2>
                <p><Icon name="lock" size={12} /> {audience} can read this conversation. It stays outside every space.</p>
              </div>
            </header>
          )}
          {olderCursor ? <div className="dm__older"><Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Show earlier messages</Button></div> : null}
          {rows.length ? (
            <ol className="dm__list" aria-label="Messages">
              {rows.flatMap(({ line, label, newDay, continued, groupLast }) => {
                if (!line.message) {
                  const item = line.item!;
                  return <DmBubble dmId={dm.id} key={`pending-${item.id}`} message={null} pending={item} mine name={me.user.name} continued={continued} groupLast={groupLast} day={newDay ? label : null}
                    writable={!recipientGone} arrived={false} observed={false} nav="stream"
                    onCreateTask={startCopy} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} />;
                }
                const message = line.message;
                const mine = message.authorId === me.user.id;
                // A message confirmed from its queued one keeps that list item: nothing moves (#264).
                const bubble = <DmBubble dmId={dm.id} key={outbox.keyOf(message.id)} message={message} mine={mine} name={mine ? me.user.name : nameOf(message.authorId)} continued={continued} groupLast={groupLast}
                  day={newDay && message.id !== unreadFrom ? label : null} writable={!recipientGone} arrived={arrived === message.id}
                  observed={!mine} receipt={seen.get(message.id)} nav="stream"
                  onReply={() => openThread(message.id, true)} onOpenThread={(root) => openThread(root.id, false)} onCreateTask={startCopy} />;
                // Where what is new begins (#1246): its day line first, then the divider, then the message.
                return message.id === unreadFrom ? [newDay ? <MessageDay key={`day-${message.id}`} label={label} /> : null, <UnreadDivider key="unread" />, bubble] : bubble;
              })}
            </ol>
          ) : (
            <p className="dm__first">No messages yet. Say hello{others.length === 1 ? ` to ${others[0]!.name.split(/\s+/)[0]}` : ''}.</p>
          )}
          {/* The person's own agent at work and what it answered them: theirs alone, at the end like a message about to be sent (#842). */}
          <PrivateAiLines own assistant={assistant} meId={me.user.id} meName={me.user.name} others={firstNames(others.map((person) => person.name))} composerId="dm-composer"
            lookups={{ projectId: '', messages: [], work: new Map(), author: nameOf, people: [...others, { name: me.user.name }].map((person) => ({ kind: 'human' as const, name: person.name })) }} />
        </div>
      </div>
      <NewBelow count={newBelow.count} onClick={newBelow.toEnd} />
      </div>
      <div className="composer dm__composer">
        <div className="composer__in">
          {goneNotice ? <p className="dm__notice" role="status"><Icon name="lock" size={13} />{goneNotice}</p> : null}
          <ConnectionLine />
          {composer.draft.cites.map((cite) => <CiteTile key={`${cite.kind}:${cite.id}`} cite={cite} disabled={composer.sending} onRemove={() => composer.removeCite(cite.kind, cite.id)} />)}
          <ComposerBox id="dm-composer" label={`Message ${title}`} fieldRef={textareaRef} value={draft} onChange={(value) => change(value)} onBlur={typing.stop} onKeyDown={onKey}
            disabled={recipientGone} boxDisabled={recipientGone} placeholder={recipientGone ? 'Nobody else is in this conversation' : `Message ${others.length === 1 ? others[0]!.name.split(/\s+/)[0] : title}…`}
            fieldProps={{ 'aria-describedby': asking ? audienceId : undefined }} sendLabel={asking ? 'Ask your agent' : 'Send message'} sendDisabled={!canSend} onSend={() => void send()} />
          {asking ? <p className="composer__audience" data-asking="true"><Icon name="lock" size={13} /><span id={audienceId}>Only you see the answer · {firstNames(others.map((person) => person.name)).join(', ') || 'The others'} {others.length === 1 ? 'sees' : 'see'} only a line that AI was used here</span></p>
            : null}
          <TypingNotice {...typing} />
          <SendAnnouncer pending={composer.pending} />
          {askFailure ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{askFailure}</p> : null}
          {composer.error && composer.error !== goneNotice ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{composer.error}</p> : null}
          <p hidden className="composer__hint" ><span className="composer__keys">Enter sends · Shift+Enter adds a line · </span>Unsent text stays in this tab</p>
        </div>
      </div>
    </div>
    </div>
    {threadOpen && slot ? (
      <OwnedPanelContent slot={slot} className="thread" id="thread">
      <DmThreadPanel key={threadId} dmId={dm.id} rootId={threadId!} meId={me.user.id} meName={me.user.name} nameOf={nameOf}
        others={firstNames(others.map((person) => person.name))} writable={!recipientGone} refreshTick={refreshTick} receiptTick={receiptTick} focusComposer={replyFocus} canObserve
        onDenied={threadDenied} onCreateTask={startCopy} onCount={threadCount} />
      </OwnedPanelContent>) : null}
    {copy ? <DmTaskCopy dmId={dm.id} message={copy.message} excerpt={copy.excerpt} participants={dm.participants} onClose={() => stopCopy()}
      onCreated={copied} onUnavailable={(cause) => { setLeftNotice(cause instanceof ApiError && cause.code?.startsWith('DM_RECIPIENT') ? cause.message : leftNotice); void refresh(); denied(cause); }} /> : null}
    </div>
  );
}
