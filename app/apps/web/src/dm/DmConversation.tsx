import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLoaderData, useLocation, useNavigate, useRevalidator, type LoaderFunctionArgs } from 'react-router';
import type { HumanConversationMessage, Dm, DmPerson } from '@flux/contracts';
import { ApiError } from '../api/client';
import { getDm, olderDmMessages } from '../api/direct-messages';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { ConnectionLine, OutboxStatus, SendAnnouncer } from '../composer/Outbox';
import { createDmSketch } from '../api/sketches';
import { sketchHref } from '../sketch/format';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { Avatar, Button, Icon, MEDIA, sendsOnEnter, useMediaQuery, useToast } from '../ui';
import { audienceLine, dmTitle, othersIn } from './names';
import { pageBackTo } from '../app/seekMessage';
import './dm.css';

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
  if (!dm) return <DmUnavailable />;
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

function merge(current: HumanConversationMessage[], incoming: HumanConversationMessage[]) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return day.format(date);
}

function DmContent({ initial }: { initial: Dm }) {
  // Touch devices add a line with Enter and send with the button (#189).
  const touch = useMediaQuery(MEDIA.touch);
  const { me } = useShellData();
  const revalidator = useRevalidator();
  const audienceId = useId();
  const hintId = useId();
  const [dm, setDm] = useState(initial);
  const [messages, setMessages] = useState(initial.messages);
  const [people, setPeople] = useState(() => new Map(initial.people.map((p) => [p.id, p])));
  const [olderCursor, setOlderCursor] = useState(initial.messagePage.nextBeforeSequence);
  const [olderBusy, setOlderBusy] = useState(false);
  // The shared composer record, kept in this tab: the draft and the messages being sent (#264).
  const composer = useComposerDraft(me.user.id, 'dm', `dm:${initial.id}`);
  const captureScope = useComposerScope(composer.key);
  const draft = composer.draft.body;
  const [gone, setGone] = useState(false);
  const [leftNotice, setLeftNotice] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef(messages);
  // A message confirmed here shows at once, in its queued place, until the DM's own read includes it.
  const shown = useMemo(() => merge(messages, composer.sent.map((item) => item.message as HumanConversationMessage)), [messages, composer.sent]);
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
  const { actionSlot } = useShellActions();

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
    if (event.objectType === 'dm' && event.objectId === initial.id) void refresh();
  }, () => { void refresh(); });
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => { document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible); };
  }, [refresh]);
  // A search result opens on that whole message when it is in the loaded window (#114); otherwise on the latest.
  const hash = useLocation().hash;
  const arrived = hash.startsWith('#message-') ? hash.slice('#message-'.length) : null;
  const arrivedLoaded = !!arrived && messages.some((message) => message.id === arrived);
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
    const el = feedRef.current; if (el) el.scrollTop = el.scrollHeight;
  }, [arrived, arrivedLoaded]);

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
      setMessages((current) => merge(current, [result.message as HumanConversationMessage]));
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
    setSelecting(on);
    setPicked([]);
    requestAnimationFrame(() => {
      if (on) feedRef.current?.querySelector<HTMLElement>('.dm-msel')?.focus({ preventScroll: true });
      else selectButtonRef.current?.focus({ preventScroll: true });
    });
  }
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

  // A 1:1 whose other person left (or was removed) has nobody to send to: say so, disable sending.
  const counterpart = dm.kind === 'pair' ? dm.counterpart : null;
  const recipientGone = Boolean(counterpart && !dm.participants.some((p) => p.id === counterpart.id));
  const goneNotice = recipientGone
    ? leftNotice || `${counterpart!.name.split(/\s+/)[0]} left this conversation. They can reopen it by messaging you.`
    : '';
  const typing = useTyping(me.user.id, !gone && !selecting ? { kind: 'dm', id: dm.id } : null, !recipientGone);
  if (gone) return <DmUnavailable />;
  const canSend = composer.canSend && !recipientGone;
  const selectButton = actionSlot && messages.length && !recipientGone ? createPortal(
    <Button ref={selectButtonRef} variant="quiet" icon="check" aria-pressed={selecting} className="dm-select-btn" onClick={() => toggleSelecting(!selecting)}>Select</Button>,
    actionSlot,
  ) : null;
  // Stored messages, then the ones being sent, grouped by day and author as one list.
  const lines = [...shown.map((message) => ({ kind: 'message' as const, message, authorId: message.authorId, at: message.createdAt })),
    ...outbox.pending.map((item) => ({ kind: 'pending' as const, item, authorId: me.user.id, at: item.at }))];
  const rows = lines.map((line, index) => {
    const previous = lines[index - 1];
    const label = dayLabel(line.at);
    const newDay = !previous || dayLabel(previous.at) !== label;
    return { line, label, newDay, continued: !newDay && previous?.authorId === line.authorId };
  });
  return (
    <div className={`dm${selecting ? ' dm--selecting' : ''}`} data-dm-id={dm.id}
      onKeyDown={(event) => { if (selecting && event.key === 'Escape') { event.preventDefault(); toggleSelecting(false); } }}>
      {selectButton}
      <div className="dm__feed" ref={feedRef}>
        <div className="dm__in">
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
              {rows.map(({ line, label, newDay, continued }) => {
                if (line.kind === 'pending') {
                  const { item } = line;
                  return (
                    <li key={`pending-${item.id}`} id={`pending-${item.id}`} data-client-message-id={item.id} data-send-state={item.state}
                      className={`dm-msg is-mine is-pending${continued ? ' dm-msg--cont' : ''}${item.state === 'failed' ? ' is-failed-send' : ''}`}>
                      {newDay ? <p className="dm__day"><span>{label}</span></p> : null}
                      <div className="dm-msg__row">
                        <span className="dm-msg__face">{continued ? null : <Avatar name={me.user.name} size="md" tone="me" />}</span>
                        <div className="dm-msg__main">
                          {continued ? null : <p className="dm-msg__meta"><b>You</b></p>}
                          <p className="dm-msg__body">{item.body}</p>
                          <OutboxStatus item={item} onRetry={() => composer.retry(item.id)} onRemove={() => composer.remove(item.id)} />
                        </div>
                      </div>
                    </li>
                  );
                }
                const { message } = line;
                const mine = message.authorId === me.user.id;
                const isPicked = selecting && picked.includes(message.id);
                return (
                  // A message confirmed from its queued one keeps that list item: nothing moves (#264).
                  <li key={outbox.keyOf(message.id)} id={`message-${message.id}`} tabIndex={-1} className={`dm-msg${mine ? ' is-mine' : ''}${continued ? ' dm-msg--cont' : ''}${arrived === message.id ? ' is-arrived' : ''}${isPicked ? ' is-picked' : ''}`} data-sequence={message.sequence} data-message-id={message.id}>
                    {newDay ? <p className="dm__day"><span>{label}</span></p> : null}
                    {/* While selecting, the whole row toggles; the check is the keyboard and screen reader control. */}
                    <div className="dm-msg__row" onClick={selecting ? (event) => { if (!(event.target as HTMLElement).closest('.dm-msel')) pick(message.id); } : undefined}>
                      {selecting ? (
                        <button type="button" className="dm-msel" aria-pressed={isPicked} onClick={() => pick(message.id)}
                          aria-label={`Select ${mine ? 'your' : `${nameOf(message.authorId)}’s`} message, ${time.format(new Date(message.createdAt))}`}>
                          <i><Icon name="check" size={12} /></i>
                        </button>
                      ) : null}
                      <span className="dm-msg__face">{continued ? null : <Avatar name={mine ? me.user.name : nameOf(message.authorId)} size="md" tone={mine ? 'me' : 'neutral'} />}</span>
                      <div className="dm-msg__main">
                        {continued ? null : <p className="dm-msg__meta"><b>{nameOf(message.authorId)}</b><time dateTime={message.createdAt}>{time.format(new Date(message.createdAt))}</time></p>}
                        <p className="dm-msg__body">{message.body}</p>
                      </div>
                    </div>
                  </li>
                );
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
      <div className="composer dm__composer" hidden={selecting}>
        <div className="composer__in">
          <p className="composer__audience" id={audienceId}><Icon name="lock" size={13} />{audience}<span aria-hidden="true"> · </span><span className="composer__where">direct message</span></p>
          {goneNotice ? <p className="dm__notice" role="status"><Icon name="lock" size={13} />{goneNotice}</p> : null}
          <ConnectionLine />
          <div className="composer__box" aria-disabled={recipientGone || undefined}>
            <label className="ui-vh" htmlFor="dm-composer">Message {title}</label>
            <textarea id="dm-composer" ref={textareaRef} rows={1} value={draft} onChange={(event) => change(event.target.value)} onBlur={typing.stop} onKeyDown={onKey}
              disabled={recipientGone} placeholder={recipientGone ? 'Nobody else is in this conversation' : `Message ${others.length === 1 ? others[0]!.name.split(/\s+/)[0] : title}…`} aria-describedby={`${audienceId} ${hintId}`} />
            <button type="button" className="composer__send" aria-label="Send message" aria-disabled={!canSend} onClick={() => void send()}><Icon name="send" /></button>
          </div>
          <TypingNotice {...typing} />
          <SendAnnouncer pending={composer.pending} />
          {composer.error && composer.error !== goneNotice ? <p className="dm__error" role="alert"><Icon name="alert" size={13} />{composer.error}</p> : null}
          <p className="composer__hint" id={hintId}><span className="composer__keys">Enter sends · Shift+Enter adds a line · </span>Unsent text stays in this tab</p>
        </div>
      </div>
    </div>
  );
}
