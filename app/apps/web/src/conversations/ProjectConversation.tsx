import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLoaderData, useLocation, useNavigate, useRevalidator } from 'react-router';
import type { ConversationMessage, Conversation, Material } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { outboxView, useComposerDraft, useComposerScope } from '../composer/draft';
import { takeHandedFiles } from '../composer/handoff';
import { ComposerFiles, useFileDrop } from '../composer/Files';
import { ConnectionLine, SendAnnouncer } from '../composer/Outbox';
import { fluxAnswers, onFluxAnswered } from '../composer/connection';
import { Button, Icon, MEDIA, sendsOnEnter, useArrivals, useMediaQuery } from '../ui';
import { getConversation, observeProjectMessages, olderMessages, projectReceipts } from './api';
import { getMaterialVersion, listMaterials } from '../materials/api';
import { getProject } from '../project/api';
import { pageBackTo } from '../app/seekMessage';
import { useShellData } from '../app/data';
import { useCreateWorkFromMessage } from '../work/inline';
import { firstLine } from '../work/format';
import { useMessageWork } from '../work/useMessageWork';
import { useProjectWorkSummary } from '../work/WorkReadContext';
import { useReferenceWork } from '../work/useReferenceWork';
import { MessageWorkPages } from '../work/MessageWorkPages';
import { audienceLine, useProjectShell } from '../project/data';
import { useShellActions } from '../app/shellContext';
import { useWorkspaceAi } from '../ai/workspaceAi';
import { useStreamEvents } from '../api/stream';
import { assistantUses, AssistantSuggestions, meetAssistantDismissed, noteAssistantUse } from '../assistant/MeetAssistant';
import { useConversationAssistant } from '../assistant/useConversationAssistant';
import { useAssistantChanges, WaitingChanges } from '../assistant/WaitingChanges';
import { AnswerItem, AskBar, BehindLine, OthersWorkingLine, ProposalCard, WorkingLine } from '../assistant/ConversationParts';
import { ScheduleFold } from '../assistant/ScheduleFold';
import { askError as askErrorText, askState } from '../assistant/format';
import { grantAgentProject } from '../agent-connection/api';
import { requestAssistantJoin } from '../agents/api';
import { tellOperator } from '../assistant/api';
import { agentAuthorLabel } from '../docs/format';
import { ownRuns, useObservation, useReceiptTick, useReceipts } from '../app/receipts';
import { OPENING_REVEAL_MS, MessageDay, sameMessageAuthor, clock, day, when } from '../app/messageParts';
import { useAgentOwners } from '../agents/owners';
import { OneConversation, type PaneProps } from '../app/OneConversation';
import { currentEntry, isBooted, recall, useArrival } from '../place/memory';
import { threadPlace } from '../work/useMessageWork';
import { ComposerBox } from '../composer/ComposerBox';
import { ComposerMenu, composerOptions, composerTrigger, type ComposerOption } from '../app/ComposerMenu';
import { onCite, takeHeldCite } from '../app/citeBus';
import type { DraftCite } from '../composer/draft';
import { useProjectQuestions } from '../agents/questions';
import { useSpareHeight } from '../ui/spareHeight';
import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import '../app/project-conversation.css';
import { ObjectNoticeItem } from '../app/ObjectNotices';
import { threadObjects } from '../app/objectNotices';
import type { ProjectData } from './loader';
import { readableError } from './errors';
import { feedEntries, mergeMessages, type FeedEntry } from './feed';
import { ThreadReply } from './ThreadReply';
import { useProjectMaterials } from '../materials/useProjectMaterials';
import { MaterialTray } from '../materials/MaterialTray';

/** Project events that change what a conversation pane shows; the assistant's Undo (#68) can take a message back. */
const LIVE_KINDS = new Set(['project.conversation_created.v1', 'project.message_sent.v1', 'project.assistant_change_undone.v1']);

/** A request made offline, held under its own id until it can go out (AST-10.15). */
interface WaitingAsk { conversationId: string; prompt: string; clientRunId: string }
export function ProjectConversation() {
  const data = useLoaderData() as ProjectData;
  const { me } = useShellData();
  // Agents' questions with ready answers (S14): one read of the project's questions for every card below.
  const aiOn = !useWorkspaceAi(data.project.workspaceId).blocked;
  useProjectQuestions(data.project.id, me.user.id, aiOn);
  return <div className="project-page">
    <OneConversation key={`${me.user.id}:${data.project.id}`} data={data} Pane={ProjectConversationContent} />
  </div>;
}

/**
 * One conversation's pane: in the stream it is the composer that starts a root (UI116-1); in the thread
 * beside it, the replies with their own composer, assistant and sources.
 */
function ProjectConversationContent({ data, variant, feed, rootHeader, rootMessageId = null, objects = [], onPosted, onSending, newestRootAt, onThreadSize, focusComposer = false }: PaneProps) {
  // Touch devices add a line with Enter and send with the button (#189).
  const touch = useMediaQuery(MEDIA.touch);
  const { project, members } = data;
  const conversation = variant === 'thread' ? data.conversation : null;
  const shell = useProjectShell();
  const people = shell?.people ?? null;
  const { me } = useShellData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  // The stream and the thread are two panes on one route: the stream's revalidation changes the router's
  // state every 15 s. Read the latest revalidate through a ref, so this pane's own refresh (and its 15 s
  // fallback timer) keeps its identity and is not restarted, and so never starved, by the other pane.
  const revalidateRef = useRef(revalidator.revalidate);
  useEffect(() => { revalidateRef.current = revalidator.revalidate; });
  const audience = audienceLine(people, me.user.id, project.visibility === 'workspace');
  const audienceShort = audience.replace(/ · only you two$/, '');
  // The stream's composer keeps the former new-conversation draft; each thread keeps its own reply draft.
  const composerId = conversation ? 'thread-composer' : 'project-composer';
  const [asking, setAsking] = useState(false);
  const publicComposer = useComposerDraft(me.user.id, project.id, conversation?.task ? `task:${conversation.task.workId}` : conversation ? `conversation:${conversation.id}` : 'new');
  const helperComposer = useComposerDraft(me.user.id, project.id, `helper:${conversation?.id ?? 'new'}`);
  const composer = asking ? helperComposer : publicComposer;
  const draft = composer.draft.body;
  const replyLocation = useLocation();
  const preparedReply = (replyLocation.state as { assistantReplyDraft?: { id: string; ownerId: string; body: string; conversationId: string } } | null)?.assistantReplyDraft;
  const assistantDraftLabel = !!preparedReply && preparedReply.ownerId === me.user.id && preparedReply.conversationId === conversation?.id && publicComposer.draft.body === preparedReply.body;
  const loadedReply = useRef<string | null>(null);
  useEffect(() => {
    if (!preparedReply || preparedReply.ownerId !== me.user.id || preparedReply.conversationId !== conversation?.id || loadedReply.current === preparedReply.id) return;
    loadedReply.current = preparedReply.id;
    // Keep an existing human draft. The assistant's words are offered alongside it, never silently overwrite it.
    if (!publicComposer.draft.body.trim()) publicComposer.setBody(preparedReply.body);
    document.getElementById(composerId)?.focus();
  }, [preparedReply, conversation?.id, publicComposer, composerId, me.user.id]);
  // "@" and "/" in the composer (F-026 S5): the caret decides which menu shows, if any.
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosedAt, setMenuClosedAt] = useState<string | null>(null);
  const [commandHint, setCommandHint] = useState('');
  // F-029 (#614): while the workspace's AI is off this conversation is human-only: no assistant, no AI commands, no suggestions.
  const aiOff = useWorkspaceAi(project.workspaceId).blocked;
  if (aiOff && asking) setAsking(false);
  // The signed-in person's own assistant (#68): ask mode, their working line, shared answers.
  const assistant = useConversationAssistant({ meId: me.user.id, meName: me.user.name, projectId: project.id, conversationId: conversation?.id ?? null, enabled: !aiOff,
    onPosted: (message) => setMessages((current) => mergeMessages(current, [message])) });
  const canWrite = project.access !== 'viewer';
  const trigger = canWrite && !asking ? composerTrigger(draft, caret) : null;
  // "My assistant" in the @ list: first once it is ready; while it is not set up, first until the Home card is dismissed, then last.
  const assistantEntry = aiOff ? null : assistant.status ? (assistant.status.state === 'ready' ? { mode: 'ask' as const, last: false }
    : assistant.status.state === 'not_enabled' ? { mode: 'setup' as const, last: meetAssistantDismissed(me.user.id) } : null) : null;
  const options = trigger ? composerOptions(trigger, { people, meId: me.user.id, inThread: !!conversation, assistant: assistantEntry, aiOff }) : [];
  const menuOpen = !!trigger && options.length > 0 && menuClosedAt !== draft;
  const activeIndex = Math.min(menuIndex, Math.max(0, options.length - 1));
  const captureScope = useComposerScope(publicComposer.key);
  const captureHelperScope = useComposerScope(helperComposer.key);
  const busy = publicComposer.sending;
  const [readFailure, setReadFailure] = useState<{ message: string; retry: () => void } | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [stored, setMessages] = useState<Conversation['messages']>(conversation?.messages ?? []);
  const messagesRef = useRef(stored);
  // A reply confirmed here is shown at once, in place of its queued message, until a read includes it (#264).
  const messages = useMemo(() => conversation ? mergeMessages(stored, publicComposer.sent.filter((item) => item.message.conversationId === conversation.id).map((item) => item.message)) : stored,
    [conversation, stored, publicComposer.sent]);
  const outbox = outboxView(messages, conversation ? publicComposer.pending : [], publicComposer.sent, me.user.id);
  const refreshingRef = useRef(false);
  /** A refresh was asked for while one was reading: read once more after it, so a message posted meanwhile is not left to the poll (#733). */
  const refreshAgainRef = useRef(false);
  const [olderCursor, setOlderCursor] = useState(conversation?.messagePage.nextBeforeSequence ?? null);
  const [olderBusy, setOlderBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((node: HTMLDivElement | null) => { scrollRef.current = node; setFeedNode(node); }, []);
  // A short thread sits against its reply field instead of at the top of a tall panel (ui/spareHeight.ts).
  const columnRef = useRef<HTMLDivElement>(null);
  const liftRef = useRef<HTMLDivElement>(null);
  useSpareHeight(scrollRef, columnRef, liftRef, conversation ? messages.length + outbox.pending.length : 0, feedNode);
  // The thread shows its root whole at the top (with what was made from it), then the replies: one bounded
  // association read covers the root and the replies around the viewport (#155).
  const sourceIds = useMemo(() => [...(rootMessageId ? [rootMessageId] : []), ...messages.filter((message) => message.sequence > 1 && message.id !== rootMessageId).map((message) => message.id)], [messages, rootMessageId]);
  const writable = project.access !== 'viewer';
  // The phone's "+" Create → File or link (F-026 S2) arrives as ?compose=files|link: the picked files
  // join this project's message draft and the field takes focus, ready for a link or a line. Once.
  const location = useLocation();
  const addDraftFiles = publicComposer.addFiles;
  useEffect(() => {
    if (conversation) return;
    const params = new URLSearchParams(location.search);
    if (!params.has('compose')) return;
    params.delete('compose');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, defaultShouldRevalidate: false, state: location.state });
    const files = takeHandedFiles(me.user.id, project.id);
    if (!writable) return;
    if (files?.length) addDraftFiles(files);
    requestAnimationFrame(() => document.getElementById(composerId)?.focus());
  }, [conversation, location.search, location.pathname, location.hash, location.state, navigate, me.user.id, project.id, writable, addDraftFiles, composerId]);
  // ⌘K "Ask my assistant…" and the assistant panel's Message arrive as ?ask=1 in a thread: ask mode opens once.
  const askParam = !aiOff && !!conversation && writable && new URLSearchParams(location.search).get('ask') === '1';
  const [askHandled, setAskHandled] = useState(false);
  if (askParam !== askHandled) { setAskHandled(askParam); if (askParam) setAsking(true); }
  useEffect(() => {
    if (!askParam) return;
    const params = new URLSearchParams(location.search);
    params.delete('ask');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true, defaultShouldRevalidate: false, state: location.state });
    requestAnimationFrame(() => document.getElementById(composerId)?.focus());
  }, [askParam, location.search, location.pathname, location.hash, location.state, navigate, composerId]);
  // Files dropped anywhere on the conversation join its draft (#348).
  const drop = useFileDrop(publicComposer, writable && !asking);
  const makeWork = useCreateWorkFromMessage(project);
  const conversationId = conversation?.id;
  const author = (id: string) => id === me.user.id ? me.user.name : members.find((member) => member.userId === id)?.name ?? 'Member';
  const messageAuthor = (item: ConversationMessage) => item.authorId !== null ? author(item.authorId) : agentAuthorLabel(item.author);
  const owners = useAgentOwners(project);
  // The owner's waiting changes (F-027 A3): refreshed when their run moves or an answer arrives.
  const assistantChanges = useAssistantChanges(conversation?.id ?? null, `${assistant.run?.id ?? ''}:${assistant.run?.status ?? ''}:${assistant.answers.length}:${assistant.tick}`, !aiOff);
  // Bounded native reads (#155): the visible replies' chips, and the tasks that answers, proposals and the
  // discussed task refer to. Neither is the project's work collection.
  const discussedTask = conversation?.task?.workId ?? null;
  const referenceIds = useMemo(() => [...new Set([...(discussedTask ? [`work:${discussedTask}`] : []), ...assistant.answers.flatMap((answer) => {
    const refs = answer.sources.filter((source) => source.type === 'work').map((source) => `work:${source.id}`);
    const proposal = answer.proposalId ? assistant.proposals.get(answer.proposalId) : null;
    if (proposal?.change.finishes) refs.push(`work:${proposal.change.finishes.workId}`);
    return refs;
  })])].sort(), [assistant.answers, assistant.proposals, discussedTask]);
  const referenceWork = useReferenceWork(me.user.id, project.id, referenceIds, feedNode, !accessLost);
  // Coming back to an entry with this thread open, or back to the thread from an object that covered it in the panel (it was
  // unmounted meanwhile): its replies return to where they were left (#592). A reload opens the thread as it always opens.
  const arrival = useArrival();
  const [threadRestore] = useState(() => {
    const from = arrival ?? (isBooted() ? currentEntry() : null);
    return conversation && from ? threadPlace(recall('thread', from)) : null;
  });
  const messageWork = useMessageWork(me.user.id, project.id, accessLost ? null : conversation?.id ?? null, sourceIds, scrollRef, feedNode, referenceWork.readingRevision, threadRestore);
  // Opening (#155): the replies, their task chips, referenced rows and the header's state line come from
  // separate bounded reads. The thread shows once the first of each has settled (at most OPENING_REVEAL_MS),
  // so nothing shifts under the reader's eyes or pointer as they arrive.
  const workSummary = useProjectWorkSummary();
  const openingSettled = messageWork.state.phase !== 'loading' && referenceWork.state.phase !== 'loading' && workSummary.phase !== 'loading';
  const [openingTimedOut, setOpeningTimedOut] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setOpeningTimedOut(true), OPENING_REVEAL_MS); return () => window.clearTimeout(timer); }, []);
  const [revealed, setRevealed] = useState(false);
  if (!revealed && (openingSettled || openingTimedOut)) setRevealed(true);
  const { openDetails, openCreate } = useShellActions();
  const askBusy = helperComposer.sending;
  // Typing (#155) is the thread's: an ephemeral signal to the people who can read this conversation. The
  // stream's composer has no conversation yet, so it has no typing scope.
  const typing = useTyping(me.user.id, conversation && !accessLost ? { kind: 'conversation', id: conversation.id } : null, writable && !asking && !busy);
  const [askFailure, setAskFailure] = useState('');
  const [askFailureCode, setAskFailureCode] = useState<string | null>(null);
  const hideIfDenied = useCallback((cause: unknown) => {
    if (!(cause instanceof ApiError)) return;
    if (cause.status === 403) { revalidateRef.current(); return; }
    if (cause.status !== 401 && cause.status !== 404) return;
    setAccessLost(true);
    revalidateRef.current();
    void getProject(project.id).then(() => setAccessLost(false)).catch(() => { /* denial keeps previous content hidden */ });
  }, [project.id]);
  const materials = useProjectMaterials({ userId: me.user.id, project, inThread: !!conversation, writable, initial: data.materials, initialTotal: data.materialTotal,
    onDenied: hideIfDenied, onSaved: () => { void refresh(); } });
  useEffect(() => {
    if (referenceWork.state.phase !== 'unavailable') return;
    const cause = referenceWork.state.error;
    let current = true;
    // A settled current read may retire the view through router authorization.
    // Do not carry a queued denial into a newer observation or unmounted owner.
    queueMicrotask(() => { if (current) hideIfDenied(cause); });
    return () => { current = false; };
  }, [referenceWork.state, hideIfDenied]);
  useEffect(() => { messagesRef.current = stored; }, [stored]);
  const mergeMaterials = materials.merge;
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
  }, [conversationId, hideIfDenied, project.id, mergeMaterials]);
  const refreshLatest = useRef(refresh);
  useEffect(() => { refreshLatest.current = refresh; }, [refresh]);

  // Flux answers again (not merely a Retry or the browser's `online` event): read what arrived meanwhile.
  useEffect(() => onFluxAnswered(() => { void refresh(); }), [refresh]);
  // The assistant's Undo took something back (#68): a message it posted reads as removed now, not at the next poll. Ids only; the read is the API's.
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
  useEffect(() => {
    if (focusComposer) document.getElementById(composerId)?.focus();
    // When the thread opens for a reply.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const hash = useLocation().hash;
  // The root is the stream's message; the thread arrives only at its replies.
  const arrived = conversation && hash.startsWith('#message-') && hash.slice('#message-'.length) !== rootMessageId ? hash.slice('#message-'.length) : null;
  const arrivedLoaded = !!arrived && messages.some((message) => message.id === arrived);
  // A search result or source older than the loaded window (#114), or the message a return brings back (#592): page back until it is loaded.
  const seek = arrived ?? (threadRestore?.id.startsWith('message-') ? threadRestore.id.slice('message-'.length) : null);
  const seekLoaded = !!seek && messages.some((message) => message.id === seek);
  useEffect(() => {
    if (!conversation || !seek || seekLoaded || !olderCursor) return;
    let cancelled = false;
    void pageBackTo(seek, olderCursor, (before, limit) => olderMessages(conversation.id, before, undefined, limit)).then(({ pages, cursor }) => {
      if (cancelled) return;
      setMessages((current) => pages.reduce((all, page) => mergeMessages(all, page.messages), current));
      setOlderCursor(cursor);
    }).catch((cause: unknown) => { hideIfDenied(cause); });
    return () => { cancelled = true; };
    // Seek once per conversation and target; later pages come from "Load earlier replies".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, seek]);
  useEffect(() => {
    // A source link from "Since you left" or search opens on that whole message. Otherwise an open thread starts at
    // its root, whole (#436): its feed (the only one this ref holds) is scrolled to the top, so a long thread shows
    // its oldest replies first and the reader scrolls down. It runs again when the thread is first shown: a hidden
    // message cannot take focus. A return to this entry keeps the place the reader left (useMessageWork).
    if (threadRestore) return;
    const feed = scrollRef.current;
    const anchor = arrived ? document.getElementById(`message-${arrived}`) : null;
    if (anchor && feed?.contains(anchor)) { anchor.scrollIntoView({ block: 'start' }); if (revealed) anchor.focus({ preventScroll: true }); return; }
    if (feed) feed.scrollTop = 0;
  }, [conversation?.id, arrived, arrivedLoaded, feedNode, revealed, threadRestore]);
  // Genuine replies and answers arriving in an open thread rise in gently when the reader sees them (#155,
  // UI116-5); the history the thread opens with and earlier pages never move. The thread's position owner
  // (useMessageWork) decides whether the reader follows the end.
  // A confirmed reply keeps its queued message's place and id here, so it is not a second arrival (#264).
  const messageDomKey = (id: string) => { const key = outbox.keyOf(id); return key === id ? `message-${id}` : key; };
  const threadIds = conversation ? [...feedEntries(messages.filter((message) => message.sequence > 1), assistant.answers, !!olderCursor)
    .map((entry) => entry.type === 'message' ? messageDomKey(entry.message.id) : entry.type === 'answer' ? `answer-${entry.answer.runId}` : entry.key), ...outbox.pending.map((item) => `pending-${item.id}`)] : [];
  useArrivals(scrollRef, threadIds, (id) => document.getElementById(id));

  // The stream has no assistant: `/ai …` there would post the prompt for the whole project.
  const assistantInStream = !aiOff && !conversation && /^\/ai(\s|$)/.test(draft.trimStart());
  // The field grows with what is written, up to its CSS cap, then scrolls (#266 PF-3).
  useLayoutEffect(() => {
    const field = document.getElementById(composerId);
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.style.height = 'auto';
    field.style.height = `${field.scrollHeight}px`;
  }, [draft, composerId]);

  function changeDraft(input: string, position = input.length) {
    setCaret(position); setMenuIndex(0); setMenuClosedAt(null); setCommandHint('');
    typing.input(Boolean(input.trim()) && !asking && !/^\/(ai|task|decide|handoff)(\s|$)/.test(input));
    // Private prompts keep their own draft; invoking /ai never overwrites a public task draft.
    if (!aiOff && !asking && conversation && writable && /^\/ai(\s|$)/.test(input)) {
      // Typed key by key, "/" and "/a" were the reply's draft a moment ago; they were the command, not words to keep.
      if (/^\/[a-z]{0,1}$/i.test(publicComposer.draft.body)) publicComposer.setBody('');
      helperComposer.setBody(input.replace(/^\/ai\s?/, '')); setAsking(true); setAskFailure(''); return;
    }
    setAskFailure(''); composer.setBody(input);
  }
  function exitAsk() { setAsking(false); setAskFailure(''); document.getElementById(composerId)?.focus(); }
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
        setAskFailure(askErrorText(cause)); setAskFailureCode(cause instanceof ApiError ? cause.code : null); setAsking(true);
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
  const scrollToEnd = () => {
    const feed = scrollRef.current;
    if (!feed) return;
    feed.scrollTop = feed.scrollHeight;
    feed.dispatchEvent(new Event('scroll'));
  };
  async function sendToAssistant() {
    if (!conversation || !writable || askBusy || askState(assistant.status, audience).kind !== 'ready') return;
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
      setAskFailure(askErrorText(cause));
      setAskFailureCode(cause instanceof ApiError ? cause.code : null);
      assistant.refreshStatus();
    }
  }
  // A cited message or map thought joins this pane's composer as a tile (Cite in the message menu, Cite on the map, #469).
  const citeRef = useRef((citation: DraftCite) => { void citation; });
  useEffect(() => { citeRef.current = (citation: DraftCite) => {
    if (!canWrite) return;
    const field = document.getElementById(composerId);
    publicComposer.addCite(citation);
    setAsking(false);
    requestAnimationFrame(() => { if (field instanceof HTMLTextAreaElement) field.focus(); });
  }; });
  useEffect(() => onCite(conversation ? 'thread' : 'stream', (citation) => citeRef.current(citation)), [conversation]);
  // A thought cited on the map waits for this project's own composer to open.
  useEffect(() => {
    if (conversation || !canWrite) return;
    const held = takeHeldCite(project.id);
    if (held) citeRef.current(held);
  }, [conversation, canWrite, project.id]);

  // The caret goes after what was inserted, unless the person has already typed on (fast typing).
  const placeCaret = (position: number, value: string) => requestAnimationFrame(() => {
    const field = document.getElementById(composerId);
    if (!(field instanceof HTMLTextAreaElement)) return;
    field.focus();
    if (field.value !== value) return;
    field.setSelectionRange(position, position); setCaret(position);
  });
  function pick(option: ComposerOption) {
    if (!trigger) return;
    const before = draft.slice(0, trigger.start);
    const after = draft.slice(caret);
    if (option.assistant) {
      changeDraft(before + after, before.length);
      if (option.assistant === 'setup') navigate('/settings/assistant');
      else { setAsking(true); setAskFailure(''); requestAnimationFrame(() => document.getElementById(composerId)?.focus()); }
      return;
    }
    // /file and /source open what the old buttons opened, and leave the draft as it was.
    if (option.slash === 'file') {
      changeDraft(before + after, before.length);
      document.getElementById(composerId)?.closest('.composer')?.querySelector<HTMLButtonElement>('.composer__attach')?.click();
      return;
    }
    if (option.slash === 'source') { changeDraft(before + after, before.length); materials.setSourcesOpen(true); placeCaret(before.length, before + after); return; }
    changeDraft(before + option.insert + after, before.length + option.insert.length);
    placeCaret(before.length + option.insert.length, before + option.insert + after);
  }
  // `/task …`, `/decide …` and `/handoff …` act when sent; the words after the command are the title.
  const COMMAND_EXAMPLE = { task: 'Order the probes', decide: 'Use the second supplier', handoff: 'Calibrate the probes' } as const;
  async function runCommand(name: keyof typeof COMMAND_EXAMPLE, text: string) {
    if (!text) { setCommandHint(`Say what it is after the command, for example /${name} ${COMMAND_EXAMPLE[name]}.`); document.getElementById(composerId)?.focus(); return; }
    // Consume that exact stored revision under its original key. Changing panes does not leave a
    // successful command ready to send again; words typed later or in another conversation stay.
    const submitted = publicComposer.draft;
    const consume = () => publicComposer.consumeBody(submitted);
    // Typed in a thread, the words are about that thread (#694): its opening message is the source, so the thread shows what came of it.
    const fromThread = conversation && rootMessageId ? { messageId: rootMessageId, text: conversation.firstMessageBody } : null;
    if (name === 'decide') { openDetails({ kind: 'propose-decision', projectId: project.id, title: text, ...(fromThread ? { source: fromThread } : {}) }); consume(); return; }
    // A task, or a hand-off (a task for an agent whose owner the window asks for), opens the one Create window with the words as its title.
    // The composer keeps its words until the task exists: closing the window loses nothing (and a newer draft is never consumed).
    openCreate({ kind: 'task', projectId: project.id, title: firstLine(text), onCreated: consume,
      ...(fromThread ? { sources: [{ ref: { type: 'message' as const, id: fromThread.messageId }, label: firstLine(fromThread.text) }] } : {}) });
  }
  async function send() {
    typing.stop();
    if (asking) { await sendToAssistant(); return; }
    // F-029 (#614): `/ai` and `/handoff` in a workspace whose AI is off are not messages for the people here: the words stay in the field.
    if (aiOff && writable && /^\/(ai|handoff)(\s|$)/.test(draft.trim())) { setCommandHint('AI is off in this workspace. Remove the command to send these words as a message.'); return; }
    const command = writable ? /^\/(task|decide|handoff)(?:\s+([\s\S]*))?$/.exec(draft.trim()) : null;
    if (command) { await runCommand(command[1] as keyof typeof COMMAND_EXAMPLE, (command[2] ?? '').trim()); return; }
    // A private helper prompt is never published as a root (UI116-3); it stays in the private draft.
    if (!writable || assistantInStream) return;
    // The message joins the end of the stream or thread at once and the field empties (#264); the
    // queue sends it with its command, and a second tap finds nothing to send.
    const outcome = publicComposer.submit(conversation ? messages.at(-1)?.sequence ?? 0 : newestRootAt);
    if (!outcome) return;
    const active = captureScope();
    if (!conversation) onSending?.();
    else requestAnimationFrame(() => { if (active()) scrollToEnd(); });
    const result = await outcome;
    if (!active()) return;
    if (result.status === 'delivered') {
      if (!conversation && result.conversation) onPosted?.(result.conversation);
      void refresh();
    } else if (result.status === 'failed' && result.cause instanceof ApiError && [401, 403, 404].includes(result.cause.status)) {
      // A send's 404 also protects an unavailable file/source. Confirm scope loss through
      // the ordinary project read before hiding the composer needed to recover that draft.
      void getProject(project.id).catch((accessCause: unknown) => { if (active()) hideIfDenied(accessCause); });
    }
  }
  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && !event.nativeEvent.isComposing) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setMenuIndex((activeIndex + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length);
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') { event.preventDefault(); pick(options[activeIndex]!); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenuClosedAt(draft); return; }
    }
    if (asking && (event.key === 'Escape' || (event.key === 'Backspace' && !draft))) { event.preventDefault(); event.stopPropagation(); exitAsk(); return; }
    if (sendsOnEnter(event, touch)) { event.preventDefault(); void send(); }
  }
  async function loadOlder() {
    if (!conversation || !olderCursor || olderBusy) return;
    setOlderBusy(true); setReadFailure(null);
    try {
      const page = await olderMessages(conversation.id, olderCursor);
      setMessages((current) => mergeMessages(current, page.messages)); setOlderCursor(page.messagePage.nextBeforeSequence);
    } catch (cause) { hideIfDenied(cause); setReadFailure({ message: readableError(cause), retry: () => void loadOlder() }); }
    finally { setOlderBusy(false); }
  }
  async function cite(material: Material) {
    setReadFailure(null);
    try {
      const snapshot = await getMaterialVersion(material.materialId, material.version);
      const selected = { title: snapshot.title, materialId: material.materialId, version: snapshot.version };
      publicComposer.setReference(selected); materials.setSourcesOpen(false);
      document.getElementById(composerId)?.focus();
    } catch (cause) { hideIfDenied(cause); setReadFailure({ message: readableError(cause), retry: () => void cite(material) }); }
  }

  // #534: a thread's replies are watched like the stream's roots, and "Seen by" needs every reply of the person's own run.
  const replyEntries = conversation ? feedEntries(messages.filter((message) => message.sequence > 1), assistant.answers, !!olderCursor) : [];
  const receiptLines = [...replyEntries.map((entry) => entry.type === 'message'
    ? { id: entry.message.id as string | null, authorId: entry.message.authorId === null ? entry.message.author.id : entry.message.authorId, createdAt: entry.message.createdAt }
    : { id: null, authorId: `~${entry.key}`, createdAt: entry.at }),
    ...outbox.pending.map((item) => ({ id: null, authorId: me.user.id, createdAt: item.at }))];
  const receiptRuns = ownRuns(receiptLines, me.user.id, !!olderCursor);
  const receiptTick = useReceiptTick(receiptRuns.length > 0);
  const seen = useReceipts({ scope: `${project.id}/${conversation?.id ?? ''}`, fetchReceipts: (list, signal) => projectReceipts(project.id, list, signal), runs: receiptRuns, tick: receiptTick });
  useObservation({ scope: project.id, observe: (ids) => observeProjectMessages(project.id, ids), enabled: !!conversation && revealed, feed: scrollRef,
    ids: replyEntries.flatMap((entry) => entry.type === 'message' && entry.message.authorId !== me.user.id ? [entry.message.id] : []), depend: replyEntries.length });

  if (accessLost) return <div className="pane-scroll"><div className="pane-in project-setup" role="alert"><h2>Project unavailable</h2><p>Your access to this project may have changed. Reload to check current access.</p></div></div>;
  const ask = askState(assistant.status, audienceShort);
  // The root sits at the thread's top (and in the stream); the list holds its replies and answers.
  // What came of this thread (#694): the decisions and results made from it stand among its replies, in time order.
  const made = conversation ? threadObjects(conversation.id, new Set(messages.map((message) => message.id)), objects) : [];
  const entries = feedEntries(messages.filter((message) => message.sequence > 1), assistant.answers, !!olderCursor, made);
  const lookups = { projectId: project.id, messages, work: referenceWork.rows, author };
  // A manager can let their own assistant read this project in one step; anyone else asks a manager.
  const ownAgent = assistant.status?.enablement?.agents.find((item) => item.workspaceId === project.workspaceId)?.agentId ?? null;
  // Not in the project (Journey 6): known up front from the project's Agents view, or learned from a refused ask.
  const notIn = askFailureCode === 'PERSONAL_RUN_NO_PROJECT_ACCESS' || assistant.member === false;
  const managers = people?.filter((person) => person.kind === 'human' && person.access === 'manager' && person.id !== me.user.id) ?? [];
  const managerName = managers.length === 1 ? managers[0]!.name.trim().split(/\s+/)[0]! : 'a manager';
  const grantAction = notIn && project.access !== 'manager' && !assistant.requested ? {
    label: `Ask ${managerName} to add me`,
    run: () => { void requestAssistantJoin(project.id).then(() => { assistant.refreshMembership(); setAskFailure(''); setAskFailureCode(null); }).catch(() => setAskFailure('Couldn\'t ask. Try again.')); },
  } : notIn && project.access === 'manager' && ownAgent ? {
    label: 'Add my assistant here',
    run: () => { void grantAgentProject(project.id, ownAgent, 'viewer').then(() => { assistant.refreshMembership(); setAskFailure(''); setAskFailureCode(null); }).catch(() => setAskFailure('Couldn’t give it access. Try again.')); },
  } : null;
  const notInText = assistant.requested ? `Asked ${managerName} to add me. I'll do this when they do.`
    : project.access === 'manager' ? 'I\'m not in this project yet.' : 'I\'m not in this project yet. A manager can add me.';
  const proposalAuthority = (finishes: { workId: string } | null) => {
    if (!finishes) return { canAccept: writable && referenceWork.identityReady, canDismiss: writable && referenceWork.identityReady, targetState: 'ready' as const };
    const key = `work:${finishes.workId}`;
    const row = referenceWork.rows.get(key);
    const observed = referenceWork.actionable;
    const unavailable = observed && referenceWork.unavailable.has(key);
    const access = referenceWork.observation?.access;
    const canWrite = observed && access !== undefined && access !== 'viewer';
    const ownerAllows = row?.kind === 'work' && (access === 'manager' || !row.owner || row.owner.kind !== 'human' || row.owner.id === me.user.id);
    return {
      canAccept: canWrite && !!ownerAllows,
      // A genuinely unavailable target can be dismissed under the native server's
      // final authority. Transport failure/unknown ownership cannot act as unowned.
      canDismiss: canWrite && (!!ownerAllows || unavailable),
      targetState: unavailable ? 'unavailable' as const : observed && row ? 'ready' as const
        : referenceWork.state.phase === 'unavailable' ? 'failed' as const : 'checking' as const,
    };
  };
  const trayOpen = materials.trayOpen;
  const title = conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : project.name;
  let lastDay = '';
  const discussedRow = discussedTask ? referenceWork.rows.get(`work:${discussedTask}`) ?? null : null;
  return <div className={`${conversation ? 'thread__pane' : 'project-convo'}${drop.dropping ? ' is-dropping' : ''}`} {...drop.handlers} data-project-id={conversation ? undefined : project.id}
    data-associations-observed-at={conversation ? messageWork.page?.observedAt : undefined} data-associations-phase={conversation ? messageWork.state.phase : undefined}
    data-references-observed-at={conversation ? referenceWork.observation?.observedAt : undefined} data-references-phase={conversation ? referenceWork.state.phase : undefined}>
    {!conversation ? feed : <div className={`thread__feed${revealed ? '' : ' is-opening'}`} ref={attachFeed} aria-busy={revealed ? undefined : true}>
      <div className="thread__lift" aria-hidden="true" ref={liftRef} />
      <div className="thread__in" ref={columnRef}>
        {rootHeader?.({ preview: rootMessageId ? messageWork.previews?.get(rootMessageId) ?? null : null, taskRow: discussedRow })}
        <section aria-label="Replies to this message" className="project-convo__messages">
          {conversation ? <>
            {olderCursor ? <Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Load earlier replies</Button> : null}
            <ol className="thread__list">{[...entries.flatMap((entry, index) => {
              const label = day(entry.at);
              const divider = label !== lastDay ? <MessageDay key={`day-${entry.type === 'message' ? outbox.keyOf(entry.message.id) : entry.key}`} label={label} /> : null;
              lastDay = label;
              if (entry.type === 'object') return [divider, <ObjectNoticeItem key={entry.key} notice={entry.notice} meId={me.user.id} owners={owners} authorOf={() => null} inThread
                hasMessage={() => false} onOpen={(target) => openDetails(target)} />];
              if (entry.type === 'answer') {
                // Runs of one schedule in a row, with no person's message between them, fold into one line (AST-7, S8).
                const scheduleOf = (candidate: FeedEntry | undefined) => candidate?.type === 'answer' ? candidate.answer.schedule?.id ?? null : null;
                const folded = scheduleOf(entry);
                if (folded && scheduleOf(entries[index - 1]) === folded) return [];
                let last = index;
                while (folded && scheduleOf(entries[last + 1]) === folded) last++;
                const group = last > index ? entries.slice(index, last + 1).filter((item): item is typeof entry => item.type === 'answer') : [];
                const answerItem = (item: typeof entry) => {
                const answer = item.answer;
                const proposal = answer.proposalId ? assistant.proposals.get(answer.proposalId) ?? null : null;
                const workTitle = proposal?.change.finishes ? referenceWork.rows.get(`work:${proposal.change.finishes.workId}`)?.title ?? 'a work item' : null;
                const runChanges = assistantChanges.byRun.get(answer.runId);
                return <AnswerItem key={item.key} answer={answer} mine={answer.assistant.ownerUserId === me.user.id} lookups={lookups} when={when} clock={clock}
                  proposal={proposal} resultInMessage={!!runChanges?.some((change) => change.state === 'applied' || change.state === 'applied_after_wait')} changes={runChanges ? <WaitingChanges changes={runChanges} onChanged={assistantChanges.refresh} meId={me.user.id} /> : null}
                  proposalControls={proposal ? <ProposalCard proposal={proposal} workTitle={workTitle} {...proposalAuthority(proposal.change.finishes)} onRefreshTarget={referenceWork.refresh} meId={me.user.id}
                    onDecide={async (decision) => {
                      try { await assistant.decide(proposal, decision); } finally { revalidator.revalidate(); }
                    }} /> : null}
                  onRetry={() => assistant.retry(answer.runId)}
                  onContinue={async () => { await assistant.ask('Continue', { continuesRunId: answer.runId }); }}
                  onAskAbout={writable && !aiOff ? () => { setAsking(true); document.getElementById(composerId)?.focus(); } : null} />;
                };
                if (!group.length) return [divider, answerItem(entry)];
                const applied = group.reduce((total, item) => total + (assistantChanges.byRun.get(item.answer.runId)?.filter((change) => change.state === 'applied' || change.state === 'applied_after_wait').length ?? 0), 0);
                const todayKey = new Date().toDateString();
                return [divider, <ScheduleFold key={`fold-${entry.key}`} id={`fold-${entry.key}`} assistant={entry.answer.assistant.label} title={entry.answer.schedule!.title} changes={applied} runs={group.length}
                  today={group.every((item) => new Date(item.answer.committedAt).toDateString() === todayKey)}>{group.map(answerItem)}</ScheduleFold>];
              }
              const message = entry.message;
              const previous = entries[index - 1], next = entries[index + 1];
              const continued = previous?.type === 'message' && sameMessageAuthor(previous.message, message);
              const nextMessage = next?.type === 'message' ? next.message : !next && outbox.pending[0] ? { authorId: me.user.id, createdAt: outbox.pending[0].at } : undefined;
              const groupLast = !sameMessageAuthor(message, nextMessage);
              // A reply confirmed from its queued message keeps that list item: it does not move or arrive twice (#264).
              return [divider, <ThreadReply key={outbox.keyOf(message.id)} continued={continued} groupLast={groupLast} message={message} mine={message.authorId === me.user.id} meId={me.user.id} arrived={arrived === message.id} name={messageAuthor(message)}
                project={project} owners={owners} people={people} preview={messageWork.previews?.get(message.id) ?? null} makeWork={makeWork} writable={writable}
                onOpenResult={(resultId) => openDetails({ kind: 'result', id: resultId })} onDenied={hideIfDenied}
                observed={message.authorId !== me.user.id} seenBy={(seen.get(message.id) ?? []).map((person) => person.name)} />];
            }), ...outbox.pending.flatMap((item, index) => {
              const label = day(item.at);
              const divider = label !== lastDay ? <MessageDay key={`day-pending-${item.id}`} label={label} /> : null;
              lastDay = label;
              const previous = index ? { authorId: me.user.id, createdAt: outbox.pending[index - 1]!.at } : entries.at(-1)?.type === 'message' ? messages.at(-1) : undefined;
              const continued = sameMessageAuthor(previous, { authorId: me.user.id, createdAt: item.at });
              return [divider, <ThreadReply key={`pending-${item.id}`} continued={continued} pending={item} name={me.user.name} onRetry={() => publicComposer.retry(item.id)} onRemove={() => publicComposer.remove(item.id)} />];
            })]}
            {[...assistantChanges.byRun].filter(([runId]) => !assistant.answers.some((answer) => answer.runId === runId)).map(([runId, runChanges]) => (
              <li key={`changes-${runId}`} className="project-convo__message assistant-waiting-item"><WaitingChanges changes={runChanges} onChanged={assistantChanges.refresh} meId={me.user.id} standalone /></li>
            ))}
            {assistant.run ? <WorkingLine key="assistant-working" run={assistant.run} onStop={assistant.stop} onRetry={() => assistant.retry(assistant.run!.id)} onDismiss={assistant.dismissRun} composerId={composerId}
              changed={(assistantChanges.byRun.get(assistant.run.id) ?? []).filter((change) => change.state === 'applied' || change.state === 'applied_after_wait' || change.state === 'undone').length} /> : null}
            {assistant.others.map((other) => <OthersWorkingLine key={`working-${other.ownerId}`} name={other.ownerName} />)}
            {waitingHere.map((item) => <li key={item.clientRunId} className="assistant-queued" aria-live="polite">Sends when you&apos;re back</li>)}
            {assistant.queued?.behind && assistant.queued.behind.authority !== 'owner_request' ? <BehindLine label={assistant.queued.behind.label} onStop={assistant.stopBehind} />
              : assistant.queued ? <li className="assistant-queued" aria-live="polite">Next: “{assistant.queued.prompt.length > 60 ? `${assistant.queued.prompt.slice(0, 60)}…` : assistant.queued.prompt}”. It starts when this one ends ·
              <Button variant="link" onClick={() => void assistant.cancelQueued().catch(() => undefined)}>Cancel</Button></li> : null}
            </ol>
          </> : null}
        </section>
      </div>
    </div>}
    {conversation ? <MessageWorkPages read={messageWork} /> : null}
    {conversation && referenceWork.state.phase === 'unavailable' ? <div className="ws-message-pages" role="alert">Referenced tasks could not be checked. Your reply is kept. <button type="button" className="ws-none__b" onClick={referenceWork.refresh}>Refresh task references</button></div> : null}
    <div className="composer project-convo__composer"><div className="composer__in" data-shift={conversation ? undefined : true}>
      {trayOpen ? <MaterialTray materials={materials} projectName={project.name} writable={writable} inThread={!!conversation} composerId={composerId} author={author} onCite={(material) => void cite(material)} /> : null}
      {writable ? <ConnectionLine /> : null}
      {/* On the phone "Replying to" and the audience share one line, keeping the composer compact. */}
      {conversation && writable && !asking && assistantEntry?.mode === 'ask' && assistant.member === true && assistantUses(me.user.id) < 3 ? <AssistantSuggestions onPick={(text) => {
        noteAssistantUse(me.user.id);
        const clientRunId = crypto.randomUUID();
        void assistant.ask(text, { clientRunId }).then(() => requestAnimationFrame(() => { const feed = scrollRef.current; if (feed) feed.scrollTop = feed.scrollHeight; }))
          .catch((cause) => { if (cause instanceof NetworkError && conversation) holdAsk({ conversationId: conversation.id, prompt: text, clientRunId }); else { setAskFailure(askErrorText(cause)); setAskFailureCode(cause instanceof ApiError ? cause.code : null); setAsking(true); } });
      }} /> : null}
      {asking && writable ? <AskBar id="project-ask" state={ask} error={notIn ? notInText : askFailure} errorAction={grantAction} onExit={exitAsk} onAction={(action) => {
        if (action === 'connect') openDetails('connect-ai');
        else if (action === 'resume') void assistant.resume().catch(() => setAskFailure('Couldn’t resume. Try again.'));
        else if (action === 'tell') void tellOperator(project.workspaceId, assistant.status?.setup.runtime.client).then(() => setAskFailure('Told whoever runs Flux.'), () => setAskFailure('Couldn’t tell them. Try again.'));
        else if (action === 'key') navigate('/settings/ai-connections');
        else navigate('/settings/assistant');
      }} /> : <div className="project-convo__to">
        {conversation ? <p className="project-convo__current-thread" title={title}>{writable ? 'Replying to' : 'Conversation'} · {title}</p> : null}
        <p className="composer__audience"><Icon name="lock" size={13} /><span>{audience}</span><span className="composer__where"> · saved to {project.name}</span></p>
      </div>}
      {writable && !asking ? <ComposerFiles state={publicComposer} attach="none" /> : null}
      {/* A tap on the card's empty space goes to the field, as in a messenger (#266 PF-3). */}
      {writable && assistantDraftLabel ? <p className="assistant-answer__asked">Drafted by your assistant</p> : null}
      {writable && !aiOff && preparedReply && preparedReply.ownerId === me.user.id && preparedReply.conversationId === conversation?.id && !assistantDraftLabel ? <details className="project-convo__hint"><summary>Review the reply drafted by your assistant</summary><p style={{ whiteSpace: 'pre-wrap' }}>{preparedReply.body}</p><Button variant="secondary" onClick={() => publicComposer.setBody(preparedReply.body)}>Use this draft</Button></details> : null}
      {writable ? <ComposerBox id={composerId} label={asking ? 'Ask your assistant' : conversation ? 'Reply' : 'Write a message'} value={draft}
        placeholder={asking ? 'Ask your assistant…' : conversation ? 'Reply in thread…' : 'Message · @ mention · / actions'}
        onChange={(value, position) => changeDraft(value, position)} onSelect={setCaret} onBlur={typing.stop} onKeyDown={onComposerKey} disabled={busy || askBusy}
        fieldProps={{ 'aria-describedby': asking ? 'project-ask' : assistantInStream ? `${composerId}-ai-hint` : undefined, 'aria-controls': menuOpen ? `${composerId}-menu` : undefined,
          'aria-activedescendant': menuOpen ? `${composerId}-menu-${options[activeIndex]!.id}` : undefined }}
        attach={asking ? null : publicComposer}
        sendLabel={asking ? 'Send to your assistant' : conversation ? 'Send reply' : 'Send message'}
        sendDisabled={!composer.canSend || busy || askBusy || assistantInStream || (asking && ask.kind !== 'ready')} onSend={() => void send()}
        menu={<ComposerMenu open={menuOpen} id={`${composerId}-menu`} options={options} active={activeIndex} trigger={trigger?.char ?? '@'} aiOff={aiOff} onPick={pick} onHover={setMenuIndex} />} />
        : <div className="composer__box"><button type="button" className="composer__ask project-convo__sources-btn" aria-expanded={trayOpen} aria-controls={trayOpen ? `${conversation ? 'thread' : 'project'}-sources` : undefined} aria-label={`Sources${materials.total ? `, ${materials.total} saved` : ''}`} data-tip="Saved sources to read" data-tip-align="start" onClick={() => { if (trayOpen) materials.setSourcesOpen(false); else materials.setSourcesOpen(true); }}><Icon name="doc" /><span className="project-convo__sources-t" aria-hidden="true">Sources</span>{materials.total ? <span className="project-convo__sources-n" aria-hidden="true">{materials.total > 99 ? '99+' : materials.total}</span> : null}</button><p className="project-convo__read-only">Read-only · <span>You have read access to this project.</span></p></div>}
      {conversation && !accessLost ? <TypingNotice {...typing} /> : null}
      {writable ? <SendAnnouncer pending={publicComposer.pending} /> : null}
      {writable && assistantInStream ? <p id={`${composerId}-ai-hint`} className="project-convo__hint" role="status">Your assistant answers inside a conversation. Open one and type /ai there. This text is not posted.</p> : null}
      {commandHint ? <p className="project-convo__hint" role="status">{commandHint}</p> : null}
      {readFailure ? <p className="project-convo__error" role="alert">{readFailure.message} <button type="button" onClick={readFailure.retry}>Retry read</button></p> : null}
    </div></div>
  </div>;
}
