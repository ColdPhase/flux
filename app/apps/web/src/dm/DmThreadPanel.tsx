import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { DmMessage, DmPerson, DmThread } from '@flux/contracts';
import { ApiError } from '../api/client';
import { dmReceipts, getDmThread, observeDmMessages, olderDmReplies } from '../api/direct-messages';
import { ComposerBox } from '../composer/ComposerBox';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { SendAnnouncer } from '../composer/Outbox';
import { Button, Icon, MEDIA, PanelMeta, sendsOnEnter, useMediaQuery } from '../ui';
import '../app/one-conversation.css';
import { DmBubble } from './DmBubble';
import { groupRows } from './rows';
import { ownRuns, useObservation, useReceipts } from '../app/receipts';

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
  const [older, setOlder] = useState<number | null>(null);
  const [olderBusy, setOlderBusy] = useState(false);
  const feed = useRef<HTMLDivElement>(null);
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
      setOlder((current) => (current === null ? next.messagePage.nextBeforeSequence : current));
      onCount(rootId, next.root.replyCount);
    } catch (cause) { onDenied(cause); }
    finally { loading.current = false; }
  }, [dmId, rootId, learn, onCount, onDenied]);
  // Reading the thread from the server is what this effect is for.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load, refreshTick]);

  const opening = thread === null;
  useLayoutEffect(() => { const el = feed.current; if (el) el.scrollTop = el.scrollHeight; }, [opening, shown.length]);
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
    try {
      const page = await olderDmReplies(dmId, rootId, older);
      learn(page.people);
      setReplies((current) => merge(current, page.replies));
      setOlder(page.messagePage.nextBeforeSequence);
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
  const runs = ownRuns(shown.map((m) => ({ id: m.id, authorId: m.authorId, createdAt: m.createdAt })).concat(outbox.pending.map((item) => ({ id: null as unknown as string, authorId: meId, createdAt: item.at }))), meId, older !== null);
  const seen = useReceipts({ scope: `${dmId}/${rootId}`, fetchReceipts: (list, signal) => dmReceipts(dmId, list, signal), runs, tick: receiptTick });
  useObservation({ scope: dmId, observe: (list) => observeDmMessages(dmId, list), enabled: canObserve && !!root, feed,
    ids: (root ? [root, ...shown] : shown).filter((m) => m.authorId !== meId).map((m) => m.id), depend: shown.length });
  const count = root?.replyCount ?? shown.length;

  return (
    <>
      <PanelMeta>{count} {count === 1 ? 'reply' : 'replies'}</PanelMeta>
      <div className="thread__pane dm-thread" data-dm-thread={rootId}>
        <div className="thread__feed" ref={feed}>
          <div className="thread__in dm__in">
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

export function isMissing(cause: unknown) {
  return cause instanceof ApiError && (cause.status === 404 || cause.status === 401);
}
