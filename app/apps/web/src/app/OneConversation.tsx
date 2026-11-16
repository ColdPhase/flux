import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType, useRevalidator } from 'react-router';
import type { Conversation, ConversationMessage, ConversationRoot, NativeWorkRow, ObjectNotice } from '@flux/contracts';
import type { MessageWorkPreview } from '../work/message-associations';
import { ApiError } from '../api/client';
import { MEDIA, PanelMeta, useMediaQuery } from '../ui';
import { awaitField, focusComposerOnArrival, focusField, isTyping, stopAwaitingField } from '../ui/keys';
import { ThreadFollow } from '../notifications/ThreadFollow';
import { agentAuthorOwner, useAgentOwners } from '../agents/owners';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { useCallLines } from '../live/callLines';
import { audienceLine, useProjectShell } from '../project/data';
import { useShellData } from './data';
import { agentAuthorLabel, personName } from '../docs/format';
import { ConversationStream, streamPlace, useConversationRoots, useObjectNotices, useTaskNotices } from './ConversationStream';
import { WORK_EVENT, useStreamEvents } from '../api/stream';
import { useWithHeldProposals } from '../work/heldProposals';
import { ThreadRoot } from './ThreadRoot';
import { DiscussedDecision } from './DiscussedDecision';
import { DECISION_COMPOSER } from '../work/discuss';
import { SourceOfContext } from './messageParts';
import { OwnedPanelContent, useOwnedPanel } from './ownedPanel';
import { useShellActions } from './shellContext';
import { recall, useArrival } from '../place/memory';
import { useOriginLabel, useOriginPanelBack } from '../place/origin';
import type { ProjectData } from '../conversations/loader';
import './one-conversation.css';
import { useCreateWorkFromMessage } from '../work/inline';

/** What the conversation pane needs in each place: the stream's composer, or one open thread. */
export interface PaneProps {
  data: ProjectData;
  variant: 'stream' | 'thread';
  /** stream: the stream of roots, in place of one conversation's feed. It is given what ends it: the person's own agent at work and its private answers (#842). */
  feed?: (end: ReactNode) => ReactNode;
  /**
   * thread: the message the replies answer, at the top of the thread. The pane gives it what was made from
   * the root and the discussed task's row, from its own bounded reads (#155), never a project collection.
   */
  /** `firstDay`: the day of the first reply, which the root's reply count line names instead of a day line of its own. */
  rootHeader?: (objects: { preview: MessageWorkPreview | null; taskRow: NativeWorkRow | null; firstDay: string | null }) => ReactNode;
  /** thread: the root's message id, which the stream shows and arrives at. */
  rootMessageId?: string | null;
  /** thread: the decisions the project's conversation announces (#694); the thread shows the ones made from it. */
  objects?: ObjectNotice[];
  /** stream: a root the person just started. */
  onPosted?: (conversation: Conversation) => void;
  /** stream: the person sent a root; it shows at once at the end of the stream (#264). */
  onSending?: () => void;
  /** stream: when the newest root shown was written; a refreshed root newer than that may be the one being sent. */
  newestRootAt?: string;
  /** thread: its latest size, so the stream's reply count matches it. */
  onThreadSize?: (conversationId: string, replyCount: number, lastReplyAt: string | null) => void;
  /** thread: a decision's card in it opens that decision's own discussion (#1424). */
  onOpenDiscussion?: (conversationId: string) => void;
}

/** `found`: a search result brought the person to this message (#1424). */
/** `writeDecision`: Discuss on a decision (#1424), the cursor goes to the decision panel's field, never to this conversation's composer. */
interface NavState { writeDecision?: boolean; fromStream?: boolean; backToStream?: boolean; focusComposer?: boolean; keepPanel?: boolean; sourceOf?: string; found?: boolean; origin?: unknown; opened?: boolean; openPushed?: boolean; openThread?: boolean }

/**
 * One project conversation (UI116-1, 2026-10-02): the stream of roots with its composer, and the open
 * root's thread beside it. A conversation URL (`/projects/:id/conversations/:conversationId`, with an
 * optional `#message-…`) opens the stream at that root with its thread open; choosing a root's replies
 * here opens the same URL without moving the stream, and closing returns to the same place.
 */
export function OneConversation({ data, Pane }: { data: ProjectData; Pane: ComponentType<PaneProps> }) {
  const { project, conversation, members } = data;
  const { me } = useShellData();
  const shell = useProjectShell();
  const people = shell?.people ?? null;
  const location = useLocation();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const state = location.state as NavState | null;
  const arrived = location.hash.startsWith('#message-') ? location.hash.slice('#message-'.length) : null;
  // Closing hides the thread at once while the route settles; a later thread starts open.
  const [closing, setClosing] = useState<string | null>(null);
  const [shownId, setShownId] = useState(conversation?.id ?? null);
  if ((conversation?.id ?? null) !== shownId) { setShownId(conversation?.id ?? null); setClosing(null); }
  // A search result that names a root nobody has replied to shows it in the conversation, marked: a thread of one message has nothing to show, so no
  // empty panel opens (#1424). Decided once per arrival, so a reply that comes later never opens a panel beside the reader.
  // The same for any link to such a message (Copy link, a message link, Search, the Inbox; F-026 §4, persona round 27 P2 6): it is marked in
  // the conversation, and no empty "0 replies" thread opens beside it.
  // A link that asks to write (Reply) still opens the thread, to reply in it, and so does one followed from inside an open panel that asks to
  // keep it (a task's "From: Message"): the panel stays with its way back to the task (F-026 §4). An Inbox item opens its thread however it is
  // opened (Enter, R, Reply, a tap; `openThread`), also before anyone replied, so it opens and closes the same way every time (personas-34 P2 1).
  const alone = !state?.focusComposer && !state?.keepPanel && !state?.openThread && !!conversation && !conversation.task && !conversation.decision && !!arrived && conversation.messages.length === 1 && conversation.messages[0]!.id === arrived;
  const [lone, setLone] = useState({ key: location.key, alone });
  if (lone.key !== location.key) setLone({ key: location.key, alone });
  const withheld = lone.key === location.key ? lone.alone : alone;
  const thread = conversation && conversation.id !== closing && !withheld ? conversation : null;
  const makeWork = useCreateWorkFromMessage(project);
  const owners = useAgentOwners(project);
  const { reopenPanel, shownObject } = useShellActions();

  const onDenied = useCallback((cause: unknown) => {
    // A lost project or session reloads the route, which shows why instead of stale content.
    if (cause instanceof ApiError && [401, 403, 404].includes(cause.status)) revalidator.revalidate();
  }, [revalidator]);
  // Coming back to this entry (Back, Forward, the way back from a reference): the stream returns to where it was left (#592).
  const arrival = useArrival();
  const [restore] = useState(() => arrival ? streamPlace(recall('stream', arrival)) : null);
  // A link names a root (or a reply in it): the stream reads back to it and shows it. A return to an entry keeps its own place instead.
  // A task's discussion is no root of the stream (#868): its thread opens by itself and the stream reads nothing back looking for it.
  // Opening or closing a task or decision here (its `?open=` entry, F-026 §4) is no new arrival at the link: the stream never goes back to it.
  const navigationKind = useNavigationType();
  const sameLink = `${location.pathname}${location.hash}`;
  const [linkAt, setLinkAt] = useState({ at: sameLink, key: location.key });
  const objectStep = navigationKind === 'POP' || !!state?.openPushed || !!state?.opened || new URLSearchParams(location.search).has('open');
  if (linkAt.key !== location.key && (linkAt.at !== sameLink || !objectStep)) setLinkAt({ at: sameLink, key: location.key });
  const reveal = conversation && !conversation.task && !conversation.decision && !state?.fromStream && !restore ? { conversationId: conversation.id, key: `${conversation.id}:${linkAt.key}` } : null;
  const roots = useConversationRoots(project.id, data.roots, reveal?.conversationId ?? restore?.conv ?? null, onDenied);
  const notices = useTaskNotices(project.id, data.notices, roots.roots, roots.hasOlder, onDenied);
  // A decision this person just proposed is among them at once, as its card "Proposed", while it waits out its Undo (#1424).
  const objects = useWithHeldProposals(project.id, useObjectNotices(project.id, data.objectNotices, roots.roots, roots.hasOlder, onDenied));
  // A change to the space's work, decisions or results, or a link between a message and a task (#694, #862): the stream's task lines and
  // announcements, its chips and an open thread read it now (no timer reads them while the live stream is open). The events carry ids only;
  // what is shown is read through the API.
  useStreamEvents(me.user.id, (event) => {
    if (event.objectType === 'project' && event.objectId === project.id && (WORK_EVENT.test(event.kind) || event.kind === 'project.link_created.v1')) revalidator.revalidate();
  });
  const root = thread ? roots.roots.find((item) => item.conversationId === thread.id) ?? null : null;
  const [endToken, setEndToken] = useState(0);
  // The control on a page opened from here names this place: a task's thread is "#12 Order sensors" (#592).
  useOriginLabel(thread ? 'Thread' : 'Conversation');

  const author = useCallback((message: ConversationMessage) => {
    if (message.authorId === null) return agentAuthorLabel(message.author);
    return personName(message.authorId, { id: me.user.id, name: me.user.name }, members, people);
  }, [me.user.id, me.user.name, members, people]);

  // Call from the conversation, its stream or an open thread, is the space's call: "Call in Gesture lamp" (F-041). It never takes a message's
  // text, and a message posted after it started does not move it (#1223, #1230).
  useRegisterLiveHere({ projectId: project.id, context: { type: 'space', id: project.id }, label: project.name }, null);

  const opener = useRef<string | null>(null);
  // A thread opened from the stream is opened to reply: on a computer its reply field takes focus, so what is typed next is the reply and never
  // a shortcut (C-1). On a touch screen only Reply does, as a focused field would raise the keyboard over the thread being read.
  const touch = useMediaQuery(MEDIA.touch);
  const open = useCallback((item: ConversationRoot, reply: boolean) => {
    opener.current = item.message.id;
    const write = reply || !touch;
    if (thread && item.conversationId === thread.id) {
      // The thread is already this one: bring its panel back if something closed or covered it, then go to it.
      reopenPanel(`thread:${thread.id}`);
      document.getElementById(write ? 'thread-composer' : 'details')?.focus();
      return;
    }
    if (write) awaitField();
    // Switching threads replaces the open one, so closing still returns to the stream in one step.
    const backToStream = thread ? state?.backToStream === true : true;
    navigate(`/projects/${project.id}/conversations/${item.conversationId}`,
      { state: { fromStream: true, backToStream, focusComposer: write } satisfies NavState, replace: !!thread && backToStream });
  }, [navigate, project.id, reopenPanel, state?.backToStream, thread, touch]);
  // A decision's card's "N replies" (#1424): its one discussion opens as a thread beside the stream, as a root's replies open theirs.
  const openDiscussion = useCallback((conversationId: string) => {
    if (thread && conversationId === thread.id) { reopenPanel(`thread:${thread.id}`); document.getElementById(touch ? 'details' : 'thread-composer')?.focus(); return; }
    if (!touch) awaitField();
    const backToStream = thread ? state?.backToStream === true : true;
    navigate(`/projects/${project.id}/conversations/${conversationId}`,
      { state: { fromStream: true, backToStream, focusComposer: !touch } satisfies NavState, replace: !!thread && backToStream });
  }, [navigate, project.id, reopenPanel, state?.backToStream, thread, touch]);
  // Closing never adds an entry (A-1): a thread opened from the stream or from an Inbox item is one step back; one a link opened (a search
  // result, a notice) gives its entry to the conversation, with the origin it was followed from. Back, and the header's "‹", then leave the
  // conversation for that origin instead of opening the thread again.
  const backToStream = state?.backToStream === true;
  // A thread an Inbox item opened has its own entry (`openPushed`, F-026 §4): closing it is Back to the Inbox, with its open item (personas-33).
  const closesBack = backToStream || state?.openPushed === true;
  const origin = state?.origin;
  const close = useCallback((options?: { keepPanel?: boolean }) => {
    if (!thread) return;
    if (!opener.current) opener.current = root?.message.id ?? null;
    setClosing(thread.id);
    if (closesBack && !options?.keepPanel) navigate(-1);
    else navigate(`/projects/${project.id}`, { replace: true, state: { fromStream: true, ...(options?.keepPanel ? { keepPanel: true } : {}), ...(origin ? { origin } : {}) } satisfies NavState });
  }, [navigate, project.id, root?.message.id, closesBack, origin, thread]);
  // Closing gives focus back to the root's replies, where the person opened the thread. Not when the panel showed something else by then
  // (a task opened from its card): the panel has given focus back to that card, and the root may be far from where the reader is (P2 #5).
  useEffect(() => {
    if (thread || !opener.current) return;
    const target = document.getElementById(`message-${opener.current}`);
    opener.current = null;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body && active.isConnected && !active.closest('#details') && active.closest('.convo-notice, .convo-object')) return;
    // Nor when the person is in the composer, or arriving there (Esc in it, the space's own sidebar row): the cursor stays where they write,
    // never on the "2 replies" chip that the next space would press (F-026 §4, persona round 28 P2 2).
    if ((active instanceof HTMLElement && !active.closest('#details') && isTyping(active)) || isTyping(null)) return;
    (target?.querySelector<HTMLElement>('.convo-replies button') ?? target)?.focus({ preventScroll: true });
  }, [thread]);

  const audience = audienceLine(people, me.user.id);
  // The space's calls as lines of its conversation (F-041 point 6), with the names of who was in them.
  const calls = useCallLines(project.id);
  const nameOf = useCallback((userId: string) => personName(userId, { id: me.user.id, name: me.user.name }, members, people), [me.user.id, me.user.name, members, people]);
  const stream = (end: ReactNode) => (
    <ConversationStream project={project} meId={me.user.id} meName={me.user.name} roots={roots} notices={notices} objects={objects} calls={calls} personName={nameOf} author={author}
      audience={audience} openId={thread?.id ?? null} reveal={reveal} arrived={arrived} endToken={endToken} restore={restore} onOpen={open} onOpenDiscussion={openDiscussion} onDenied={onDenied} end={end} />
  );
  // Until the stream has the root (a link to an old one), the thread's newest sequence gives its size. A decision's discussion has no root
  // message: it is the thread on the decision's card, so every message in it is a reply, as the card counts them (#1424).
  const discussed = thread?.decision ?? null;
  const replies = discussed ? thread?.messages.at(-1)?.sequence ?? 0 : root?.replyCount ?? Math.max(0, (thread?.messages.at(-1)?.sequence ?? 1) - 1);
  const rootMessage = root?.message ?? thread?.messages.find((message) => message.sequence === 1) ?? null;
  // A thread a reference led to, in a sheet or an overlay over the header, carries the way back to where it was followed from (#592).
  const originBack = useOriginPanelBack();
  const slot = useOwnedPanel(thread ? { key: `thread:${thread.id}`, chip: 'Thread', label: 'Replies', ...(originBack ? { origin: originBack } : {}), onClose: close } : null);
  // A link to a reply, or one that asks to keep the panel, shows the thread even when another object (a task) covers it.
  const toReply = !!arrived && arrived !== rootMessage?.id;
  useEffect(() => {
    if (thread && (toReply || state?.keepPanel)) reopenPanel(`thread:${thread.id}`);
    // Only a new arrival (a navigation) asks for it, never a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
  // A link that asks to write (Reply, in the stream or the Inbox; Discuss on a decision, #763 D3) focuses the field it lands on, also when that
  // pane was already open, and keeps it: the message the link names is marked, but it does not take the focus from the field (`focusArrival`).
  useLayoutEffect(() => {
    // A thread being closed is not an arrival: its entry still asks to write, but the cursor goes where closing gives it back.
    // Discuss on a decision (#1424): while the address opens that decision, the cursor goes to its panel's field.
    const writing = !!state?.writeDecision && !!new URLSearchParams(location.search).get('open')?.startsWith('decision:');
    if (writing) return focusField(DECISION_COMPOSER);
    if (!state?.focusComposer || (closing !== null && closing === conversation?.id)) return;
    return focusField(thread ? 'thread-composer' : 'project-composer');
    // Only a new arrival (a navigation) asks for it, never a re-render; the thread is the one the address names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key, thread?.id]);
  // Arriving here from anywhere else on a computer (the sidebar, Home, a search result for the space, Create space) puts the cursor in the
  // composer (`focusComposerOnArrival`), never on the page body where a typed sentence would be shortcuts. Not what happens inside the
  // conversation (a thread opened or closed here, Back to the stream: focus goes back to what opened it), a link that names a message (it is
  // marked and takes the focus) or opens an object in the panel, and not on a touch screen, where a focused field raises the keyboard.
  const navigationType = useNavigationType();
  const openedAt = useRef({ key: location.key, project: project.id, moved: false });
  useLayoutEffect(() => {
    // Back or Forward within this space (closing a thread is one) is a move inside it; one that comes from another space, or opens this
    // screen, is an arrival.
    const seen = openedAt.current;
    if (location.key !== seen.key) seen.moved = true;
    const inside = seen.moved && project.id === seen.project;
    seen.project = project.id;
    // Arriving to open something (`?open=task:…/decision:…`, which leaves the address as `opened`; a message link; a task or decision its
    // panel shows again on a return) puts focus on that object, never in the composer, so Esc closes it.
    if (touch || (state?.writeDecision && new URLSearchParams(location.search).has('open')) || state?.focusComposer || state?.fromStream || state?.keepPanel || (inside && navigationType === 'POP')) return undefined;
    if (state?.opened || (shownObject && navigationType === 'POP') || arrived || location.search) {
      // A press on a link that expected the composer (`watchConversationLinks`) gives the keys back: the object has the focus.
      stopAwaitingField();
      return undefined;
    }
    return focusComposerOnArrival(thread ? 'thread-composer' : 'project-composer');
    // Once per arrival (a navigation), never a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);
  // A link from a task's "Came from" names the task: the message it arrived at is tagged "Source of #1" for two seconds.
  const sourceOf = arrived && state?.sourceOf ? { messageId: arrived, label: `Source of ${state.sourceOf}` } : null;
  return (
    <SourceOfContext.Provider value={sourceOf}>
    <div className="convo-split">
      <div className="convo-split__stream">
        <Pane key="stream" data={data} variant="stream" feed={stream}
          onPosted={(started) => { roots.posted(started); setEndToken((value) => value + 1); }} onSending={() => setEndToken((value) => value + 1)} newestRootAt={roots.roots.at(-1)?.message.createdAt ?? ''} />
      </div>
      {thread && slot ? (
        <OwnedPanelContent slot={slot} className="thread" id="thread">
          <PanelMeta>{replies} {replies === 1 ? 'reply' : 'replies'}</PanelMeta>
          <ThreadFollow conversationId={thread.id} projectId={project.id} />
          <Pane key={thread.id} data={data} variant="thread" rootMessageId={discussed ? null : rootMessage?.id ?? null} objects={objects}
            onThreadSize={roots.threadSize} onOpenDiscussion={openDiscussion}
            rootHeader={({ preview, firstDay }) => discussed ? <DiscussedDecision decision={discussed} notice={objects.find((item) => item.decisionId === discussed.decisionId) ?? null} replies={replies} firstDay={firstDay} /> : <ThreadRoot firstDay={firstDay} message={rootMessage} projectId={project.id} body={rootMessage?.body ?? thread.firstMessageBody} author={rootMessage ? author(rootMessage) : null}
              agentOwner={rootMessage?.authorId === null ? agentAuthorOwner(rootMessage.author, owners) ?? null : null} meId={me.user.id} writable replies={replies} preview={preview} onDenied={onDenied}
              photo={{ place: project.name, onReply: () => document.getElementById('thread-composer')?.focus(), onCreateTask: rootMessage ? () => void makeWork.create(rootMessage) : undefined }} />} />
        </OwnedPanelContent>) : null}
    </div>
    </SourceOfContext.Provider>
  );
}
