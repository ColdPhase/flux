import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type RefObject } from 'react';
import type { ConversationMessage, DecisionDiscussion as Discussion, Project, WorkspaceMember } from '@flux/contracts';
import { AgentIdentity, Avatar, Kreska, MEDIA, sendsOnEnter, useMediaQuery, type AgentHue } from '../ui';
import { useComposerDraft, useComposerScope } from '../composer/draft';
import { ComposerFiles, MessageContent, hasPhotos } from '../composer/Files';
import { ComposerBox } from '../composer/ComposerBox';
import { LinkPreviews, MessageText } from '../app/MessageText';
import { ConnectionLine, OutboxStatus, PendingFiles, SendAnnouncer } from '../composer/Outbox';
import { clock, day, when } from '../app/messageParts';
import { getDecisionDiscussion } from '../composer/api';
import { agentDisplayName, personName, youLabel } from '../docs/format';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import { useAgentHue } from '../agents/hues';
import { useProjectShell } from '../project/data';
import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import { useObservation } from '../app/receipts';
import { observeProjectMessages } from '../conversations/api';
import { DECISION_COMPOSER } from './discuss';
import { opensAtTop } from './panelOpening';


const MESSAGES = 50;

/**
 * A decision's one discussion (founder decision, Hubert, 2026-11-15, #1424): the thread on its card in the space's conversation, shown
 * in its panel too, oldest first with the newest at the bottom above the field. Read again when the decision's discussion changes for
 * anyone (`revision`, from `project.decision_discussed.v1`) and when this person's own message is stored.
 */
export function useDecisionDiscussion(decisionId: string, revision: number | string) {
  const [discussion, setDiscussion] = useState<Discussion | null>(null);
  // The earlier pages read with "Show earlier", kept across the reads of the newest page (personas-33 P2 3): every message stays reachable.
  const [earlier, setEarlier] = useState<{ decisionId: string; messages: ConversationMessage[]; page: Discussion['messagePage'] } | null>(null);
  const [busyEarlier, setBusyEarlier] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getDecisionDiscussion(decisionId, { limit: MESSAGES, signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) { setDiscussion(value); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [decisionId, revision, attempt]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const current = discussion?.decisionId === decisionId ? discussion : null;
  const kept = earlier?.decisionId === decisionId ? earlier : null;
  const messages = useMemo(() => {
    const bySequence = new Map<number, ConversationMessage>();
    for (const message of [...(kept?.messages ?? []), ...(current?.messages ?? [])]) bySequence.set(message.sequence, message);
    return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
  }, [kept, current]);
  const oldest = messages[0];
  const hasEarlier = !!oldest && oldest.sequence > 1 && (kept ? kept.page.hasMoreBefore : !!current?.messagePage.hasMoreBefore);
  const loadEarlier = useCallback(async () => {
    if (!oldest) return;
    setBusyEarlier(true);
    try {
      const page = await getDecisionDiscussion(decisionId, { limit: MESSAGES, beforeSequence: oldest.sequence });
      setEarlier((was) => ({ decisionId, messages: [...page.messages, ...(was?.decisionId === decisionId ? was.messages : [])], page: page.messagePage }));
    } catch { setFailed(true); }
    finally { setBusyEarlier(false); }
  }, [decisionId, oldest]);
  return { discussion: current, messages, hasEarlier, loadEarlier, busyEarlier, failed, reload };
}
export type DecisionDiscussionState = ReturnType<typeof useDecisionDiscussion>;

/**
 * "Show earlier" at the top of a panel's discussion. Focus stays in the panel (persona round 10): the button keeps it while the page is read,
 * and when nothing earlier is left and the button goes, the oldest line shown takes it, never the page or the conversation behind the panel.
 */
export function ShowEarlier({ shown, busy, load, list }: { shown: boolean; busy: boolean; load: () => Promise<void>; list: RefObject<HTMLElement | null> }) {
  const handOn = useRef(false);
  useLayoutEffect(() => {
    if (!handOn.current) return;
    if (shown) { if (!busy) handOn.current = false; return; }
    handOn.current = false;
    const first = list.current?.querySelector<HTMLElement>(':scope > li');
    if (first) { first.tabIndex = -1; first.focus({ preventScroll: true }); }
  }, [shown, busy, list]);
  if (!shown) return null;
  return <button type="button" className="wd-inline wd-act__earlier" aria-disabled={busy || undefined}
    onClick={(event) => { if (busy) return; handOn.current = document.activeElement === event.currentTarget; void load(); }}>{busy ? 'Loading…' : 'Show earlier'}</button>;
}

function Face({ message, name, mine, hue }: { message: ConversationMessage; name: string; mine: boolean; hue?: AgentHue | undefined }) {
  return message.authorId === null ? <Kreska size={20} className="wd-act__face" {...(hue ? { hue } : {})} /> : <Avatar name={name} id={message.authorId} size="sm" tone={mine ? 'me' : 'neutral'} />;
}

/** What was written about the decision, oldest first, then what this person is sending. */
export function DecisionMessages({ state, composer, project, members, me }: {
  state: DecisionDiscussionState; composer: ReturnType<typeof useComposerDraft>; project: Project; members: WorkspaceMember[]; me: { id: string; name: string };
}) {
  const people = useProjectShell()?.people ?? null;
  const owners = useAgentOwners(project);
  const hueOf = useAgentHue();
  const { discussion } = state;
  // What this person sent stays in its place until the read that has it comes back, so nothing blinks out (#1424). Oldest first, with
  // "Show earlier" at the top while older messages are still to read (personas-33 P2 3).
  const stored = state.messages;
  const messages = [...stored, ...composer.sent.map((item) => item.message)
    .filter((message) => !stored.some((other) => other.id === message.id) && (!discussion?.conversationId || message.conversationId === discussion.conversationId))]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const author = (message: ConversationMessage) => message.authorId === null ? agentDisplayName(message.author) : personName(message.authorId, me, members, people, message.removedAuthorName);
  const list = useRef<HTMLOListElement>(null);
  // The newest stays in view at the bottom, above the field, as a message arrives or is sent.
  const last = `${messages.at(-1)?.id ?? ''}:${composer.pending.length}`;
  // The phone's sheet opens at its top, the decision first (`usePanelOpening`, round 14 new P2-3); what arrives or is sent later shows there too.
  const drawn = useRef(false);
  useLayoutEffect(() => {
    const first = !drawn.current && messages.length > 0;
    if (messages.length) drawn.current = true;
    if (first && opensAtTop(list.current)) return;
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [last]);
  // What is read here is read in the thread too (persona round 8): the panel records what it shows as viewed, by the thread's own rule
  // (60 % of a message in view for 700 ms), so the thread draws no New divider above a message already read in the panel.
  const scroller = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { scroller.current = list.current?.closest<HTMLElement>('.wd__scroll') ?? null; });
  const others = stored.filter((message) => message.authorId !== me.id).map((message) => message.id);
  useObservation({ scope: project.id, observe: (ids) => observeProjectMessages(project.id, ids), enabled: others.length > 0, feed: scroller, ids: others, depend: stored.length });
  if (!messages.length && !composer.pending.length && !state.failed) return null;
  return (
    <section className="details__sec wd-discussion" aria-labelledby="wd-discussion-head" data-decision-discussion={discussion?.conversationId ?? ''}>
      <h4 id="wd-discussion-head">Discussion</h4>
      {state.failed ? <p className="wd-error" role="alert">The discussion could not be loaded. <button type="button" className="wd-inline" onClick={state.reload}>Retry</button></p> : null}
      <ShowEarlier shown={state.hasEarlier} busy={state.busyEarlier} load={state.loadEarlier} list={list} />
      <ol className="wd-act wd-discussion__list" aria-label="Messages about this decision" ref={list}>
        {messages.map((message) => {
          const name = author(message);
          const mine = message.authorId === me.id;
          const hue = message.author?.kind === 'agent' ? hueOf(message.author) : undefined;
          return (
            <li key={message.id} className="wd-act__item wd-act__item--message" data-message-id={message.id} {...(mine ? {} : { 'data-observe-id': message.id })}>
              <Face message={message} name={name} mine={mine} hue={hue} />
              <div className="wd-act__body">
                <p className="wd-act__who">
                  {message.authorId === null ? <AgentIdentity name={name} owner={message.author.kind === 'agent' ? agentAuthorOwner(message.author, owners) : undefined} icon={false} hue={hue} />
                    : <b>{youLabel(name, mine)}</b>}
                  <time dateTime={message.createdAt} title={when(message.createdAt)}>{day(message.createdAt)}, {clock(message.createdAt)}</time>
                  {message.editedAt ? <span className="message-edited" title={`Edited ${when(message.editedAt)}`}> · edited</span> : null}
                </p>
                <div className={`wd-act__bubble${hasPhotos(message.files) ? ' has-photos' : ''}`}>
                  <MessageContent files={message.files} context={{ author: name, at: message.createdAt, caption: message.body, place: project.name }}
                    body={message.body ? <div className={`message-body${message.removedAt ? ' message-body--removed' : ''}`}><MessageText body={message.body} /></div> : null}>
                    <LinkPreviews body={message.body} projectId={project.id} messageId={message.id} />
                  </MessageContent>
                </div>
              </div>
            </li>
          );
        })}
        {composer.pending.map((pending) => (
          <li key={`pending-${pending.id}`} id={`pending-${pending.id}`} data-client-message-id={pending.id} data-send-state={pending.state}
            className={`wd-pending__item is-pending${pending.state === 'failed' ? ' is-failed-send' : ''}`}>
            <PendingFiles body={pending.body ? <div className="wd-pending__body"><MessageText body={pending.body} linked={false} /></div> : null} files={pending.files}
              send={{ state: pending.state, onRetry: () => composer.retry(pending.id) }} />
            <OutboxStatus item={pending} onRetry={() => composer.retry(pending.id)} onRemove={() => composer.remove(pending.id)} />
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * The field at the decision panel's foot, "Write about this decision…" (#1424). It writes in the decision's one discussion through the
 * same draft (`decision:<id>`) as the thread on the decision's card, so the words are never the space's own composer's.
 */
export function DecisionComposer({ state, composer, meId }: { state: DecisionDiscussionState; composer: ReturnType<typeof useComposerDraft>; meId: string }) {
  const touch = useMediaQuery(MEDIA.touch);
  const captureScope = useComposerScope(composer.key);
  const conversationId = state.discussion?.conversationId ?? null;
  // Typing is the thread's (#155): the same as in the thread on the card. Before the first message there is no thread to type in.
  const typing = useTyping(meId, conversationId ? { kind: 'conversation', id: conversationId } : null, true);
  async function send(event?: FormEvent) {
    event?.preventDefault();
    typing.stop();
    const outcome = composer.submit();
    if (!outcome) return;
    const active = captureScope();
    const result = await outcome;
    if (result.status === 'delivered' && active()) state.reload();
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (sendsOnEnter(event, touch) || (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing)) { event.preventDefault(); void send(); }
  };
  return (
    <form className="wd-composer" onSubmit={(event) => void send(event)}>
      <ConnectionLine />
      <ComposerFiles state={composer} attach="none" />
      <ComposerBox id={DECISION_COMPOSER} label="Write about this decision" value={composer.draft.body} maxLength={20000}
        placeholder={['Write about this decision…', 'Write']} onChange={(value) => { composer.setBody(value); typing.input(Boolean(value.trim())); }} onBlur={typing.stop} onKeyDown={onKeyDown}
        attach={composer} sendLabel="Send" sendDisabled={!composer.canSend} onSend={() => void send()} />
      <div className="wd-foot__line">{conversationId ? <TypingNotice {...typing} /> : <p className="typing-notice" aria-hidden="true">{' '}</p>}</div>
      <SendAnnouncer pending={composer.pending} />
    </form>
  );
}
