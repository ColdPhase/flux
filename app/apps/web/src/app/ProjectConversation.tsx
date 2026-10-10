import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLoaderData, useLocation, useNavigate, useRevalidator, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from 'react-router';
import type { AssistantAnswer, ConversationMessage, Conversation, ConversationRootWindow, Draft, Material, Page, Project, ProjectPerson, TaskCreationNotice, WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { outboxView, useComposerDraft, useComposerScope, type PendingSend } from '../composer/draft';
import { AttachButton, ComposerFiles, MessageFiles } from '../composer/Files';
import { ConnectionLine, SendAnnouncer } from '../composer/Outbox';
import { fluxAnswers, onFluxAnswered } from '../composer/connection';
import { Button, Icon, Input, MEDIA, sendsOnEnter, useArrivals, useMediaQuery } from '../ui';
import { getConversation, getMaterialVersion, getProject, listConversationRoots, listDrafts, listMaterials, listTaskNotices, listWorkspaceMembers, olderMessages, publishMaterial } from './conversation-api';
import { pageBackTo } from './seekMessage';
import { useShellData } from './data';
import { MessageObjects, useCreateWorkFromMessage } from '../work/inline';
import { MessageActions, useTouchActions } from '../work/messageActions';
import { useMessageWork } from '../work/useMessageWork';
import type { MessageWorkPreview } from '../work/message-associations';
import { useProjectWorkSummary } from '../work/WorkReadContext';
import { useReferenceWork } from '../work/useReferenceWork';
import { MessageWorkPages } from '../work/MessageWorkPages';
import { audienceLine, replyTo, useProjectShell } from '../project/data';
import { useShellActions } from './shellContext';
import { useConversationAssistant } from '../assistant/useConversationAssistant';
import { AnswerItem, AskBar, ProposalCard, WorkingLine } from '../assistant/ConversationParts';
import { askError as askErrorText, askState } from '../assistant/format';
import { grantAgentProject } from '../agent-connection/api';
import { agentAuthorLabel } from '../docs/format';
import { AgentAuthor, AuthorFace, ContributionMark, OPENING_REVEAL_MS, SourceCitation, clock, day, openOnWholeMessages, pendingMessageRow, when } from './messageParts';
import { agentAuthorOwner, useAgentOwners, type AgentOwners } from '../agents/owners';
import { OneConversation, type PaneProps } from './OneConversation';
import { ComposerHint, ComposerMenu, composerOptions, composerTrigger, mentionNodes, type ComposerOption } from './ComposerMenu';
import { cite as citeMessage, onCite, quoteOf } from './citeBus';
import { useTyping } from '../typing/useTyping';
import { TypingNotice } from '../typing/TypingNotice';
import './project-conversation.css';

/** The project's one conversation (UI116-1): the newest roots and task announcements (UI116-3), and the thread a URL opens. */
export interface ProjectData { project: Project; roots: ConversationRootWindow; notices: Page<TaskCreationNotice>; materials: Material[]; materialTotal: number; members: WorkspaceMember[]; conversation: Conversation | null }
export async function projectConversationLoader({ params, request }: LoaderFunctionArgs): Promise<ProjectData> {
  const projectId = params.projectId!;
  const project = await getProject(projectId, request.signal);
  // Work, decisions and results come with the project (#117 parent route).
  const [roots, notices, materials, members] = await Promise.all([
    listConversationRoots(projectId, {}, request.signal),
    // Announcements add to the stream; a failure that is not about access leaves the stream readable without them.
    listTaskNotices(projectId, {}, request.signal).catch((error: unknown) => {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) throw error;
      return { items: [], total: 0, limit: 100, offset: 0 };
    }),
    listMaterials(projectId, request.signal),
    listWorkspaceMembers(project.workspaceId, request.signal).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 403) return [];
      throw error;
    }),
  ]);
  const conversation = params.conversationId ? await getConversation(params.conversationId, request.signal) : null;
  if (conversation && conversation.projectId !== projectId) throw new Response('Not found', { status: 404 });
  return { project, roots, notices, materials: materials.items, materialTotal: materials.total, members, conversation };
}
/** The stream stays mounted while a thread opens or closes; its loader refreshes the open thread then. */
export function shouldRevalidateProjectConversation({ currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  return defaultShouldRevalidate || currentParams.projectId !== nextParams.projectId || currentParams.conversationId !== nextParams.conversationId;
}

function readableError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return 'This project or conversation is no longer available to you.';
  if (error instanceof ApiError && error.status === 403) return 'You can read this project, but cannot post here.';
  return error instanceof Error ? error.message : 'Could not save. Try again.';
}
interface MaterialFormSnapshot { open: boolean; title: string; body: string; url: string; sourceDraft: Draft | null; mutationId: string }
function savedMaterialForm(key: string): MaterialFormSnapshot {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Partial<MaterialFormSnapshot>;
    return { open: value.open === true, title: value.title ?? '', body: value.body ?? '', url: value.url ?? '', sourceDraft: value.sourceDraft ?? null, mutationId: value.mutationId ?? crypto.randomUUID() };
  } catch { return { open: false, title: '', body: '', url: '', sourceDraft: null, mutationId: crypto.randomUUID() }; }
}
function mergeMessages(current: Conversation['messages'], incoming: Conversation['messages']) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

export function ProjectConversation() {
  const data = useLoaderData() as ProjectData;
  const { me } = useShellData();
  return <div className="project-page">
    <OneConversation key={`${me.user.id}:${data.project.id}`} data={data} Pane={ProjectConversationContent} />
  </div>;
}

/**
 * One conversation's pane: in the stream it is the composer that starts a root (UI116-1); in the thread
 * beside it, the replies with their own composer, assistant and sources.
 */
function ProjectConversationContent({ data, variant, feed, rootHeader, rootMessageId = null, onPosted, onSending, newestRootAt, onThreadSize, focusComposer = false }: PaneProps) {
  // Touch devices add a line with Enter and send with the button (#189).
  const touch = useMediaQuery(MEDIA.touch);
  const { project, materials, members } = data;
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
  const materialFormKey = `flux.project-material.${me.user.id}.${project.id}${conversation ? '.thread' : ''}`;
  const composerId = conversation ? 'thread-composer' : 'project-composer';
  const [asking, setAsking] = useState(false);
  const publicComposer = useComposerDraft(me.user.id, project.id, conversation?.task ? `task:${conversation.task.workId}` : conversation ? `conversation:${conversation.id}` : 'new');
  const helperComposer = useComposerDraft(me.user.id, project.id, `helper:${conversation?.id ?? 'new'}`);
  const composer = asking ? helperComposer : publicComposer;
  const draft = composer.draft.body;
  // "@" and "/" in the composer (F-026 S5): the caret decides which menu shows, if any.
  const [caret, setCaret] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuClosedAt, setMenuClosedAt] = useState<string | null>(null);
  const [commandHint, setCommandHint] = useState('');
  const canWrite = project.access !== 'viewer';
  const trigger = canWrite && !asking ? composerTrigger(draft, caret) : null;
  const options = trigger ? composerOptions(trigger, { people, meId: me.user.id, inThread: !!conversation }) : [];
  const menuOpen = !!trigger && options.length > 0 && menuClosedAt !== draft;
  const activeIndex = Math.min(menuIndex, Math.max(0, options.length - 1));
  const phone = useMediaQuery(MEDIA.phone);
  const captureScope = useComposerScope(publicComposer.key);
  const captureHelperScope = useComposerScope(helperComposer.key);
  const savedMaterial = useMemo(() => savedMaterialForm(materialFormKey), [materialFormKey]);
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
  const [olderCursor, setOlderCursor] = useState(conversation?.messagePage.nextBeforeSequence ?? null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [materialItems, setMaterialItems] = useState(materials);
  const [materialOffset, setMaterialOffset] = useState(materials.length);
  const [materialTotal, setMaterialTotal] = useState(data.materialTotal);
  const [moreMaterialsBusy, setMoreMaterialsBusy] = useState(false);
  const [showMaterialForm, setShowMaterialForm] = useState(savedMaterial.open);
  const [sourcesOpen, setSourcesOpen] = useState(savedMaterial.open);
  const [materialTitle, setMaterialTitle] = useState(savedMaterial.title);
  const [materialBody, setMaterialBody] = useState(savedMaterial.body);
  const [materialUrl, setMaterialUrl] = useState(savedMaterial.url);
  const [materialBusy, setMaterialBusy] = useState(false);
  const [materialError, setMaterialError] = useState('');
  const [materialMutationId, setMaterialMutationId] = useState(savedMaterial.mutationId);
  const [privateDrafts, setPrivateDrafts] = useState<Draft[]>([]);
  const [sourceDraft, setSourceDraft] = useState<Draft | null>(savedMaterial.sourceDraft);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [feedNode, setFeedNode] = useState<HTMLDivElement | null>(null);
  const attachFeed = useCallback((node: HTMLDivElement | null) => { scrollRef.current = node; setFeedNode(node); }, []);
  // The thread shows its root whole at the top (with what was made from it), then the replies: one bounded
  // association read covers the root and the replies around the viewport (#155).
  const sourceIds = useMemo(() => [...(rootMessageId ? [rootMessageId] : []), ...messages.filter((message) => message.sequence > 1 && message.id !== rootMessageId).map((message) => message.id)], [messages, rootMessageId]);
  const writable = project.access !== 'viewer';
  const makeWork = useCreateWorkFromMessage(project);
  const conversationId = conversation?.id;
  const author = (id: string) => id === me.user.id ? me.user.name : members.find((member) => member.userId === id)?.name ?? 'Member';
  const messageAuthor = (item: ConversationMessage) => item.authorId !== null ? author(item.authorId) : agentAuthorLabel(item.author);
  const owners = useAgentOwners(project);
  // Replies reach the whole project audience. Name a reply target only while every voice in the thread is human;
  // with a genuine agent author the named people would not match the visible thread.
  const replyHint = messages.some((message) => message.authorId === null) ? 'Reply in this conversation…' : replyTo(people, me.user.id);
  // The signed-in person's own assistant (#68): ask mode, their working line, shared answers.
  const assistant = useConversationAssistant({ meId: me.user.id, projectId: project.id, conversationId: conversation?.id ?? null });
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
  const messageWork = useMessageWork(me.user.id, project.id, accessLost ? null : conversation?.id ?? null, sourceIds, scrollRef, feedNode, referenceWork.readingRevision);
  // Opening (#155): the replies, their task chips, referenced rows and the header's state line come from
  // separate bounded reads. The thread shows once the first of each has settled (at most OPENING_REVEAL_MS),
  // so nothing shifts under the reader's eyes or pointer as they arrive.
  const workSummary = useProjectWorkSummary();
  const openingSettled = messageWork.state.phase !== 'loading' && referenceWork.state.phase !== 'loading' && workSummary.phase !== 'loading';
  const [openingTimedOut, setOpeningTimedOut] = useState(false);
  useEffect(() => { const timer = window.setTimeout(() => setOpeningTimedOut(true), OPENING_REVEAL_MS); return () => window.clearTimeout(timer); }, []);
  const [revealed, setRevealed] = useState(false);
  if (!revealed && (openingSettled || openingTimedOut)) setRevealed(true);
  const { openDetails } = useShellActions();
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
  useEffect(() => {
    try { sessionStorage.setItem(materialFormKey, JSON.stringify({ open: showMaterialForm, title: materialTitle, body: materialBody, url: materialUrl, sourceDraft, mutationId: materialMutationId } satisfies MaterialFormSnapshot)); }
    catch { /* private mode: the form remains usable during this visit */ }
  }, [materialFormKey, showMaterialForm, materialTitle, materialBody, materialUrl, sourceDraft, materialMutationId]);
  const refresh = useCallback(async () => {
    // Offline, a read fails and a failed route reload would replace the stream with an error page:
    // the quiet line says why (#264), and the stream reads again when the connection is back.
    if (refreshingRef.current || !fluxAnswers()) return;
    refreshingRef.current = true;
    // The stream's refresh reloads the route (newest roots, the project); a thread reads only its own replies.
    if (!conversationId) revalidateRef.current();
    try {
      const [latestMaterials, latestConversation] = await Promise.all([
        listMaterials(project.id),
        conversationId ? getConversation(conversationId) : Promise.resolve(null),
      ]);
      setMaterialItems((current) => [...latestMaterials.items, ...current.filter((item) => !latestMaterials.items.some((latest) => latest.materialId === item.materialId))]);
      setMaterialTotal(latestMaterials.total);
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
    finally { refreshingRef.current = false; }
  }, [conversationId, hideIfDenied, project.id]);
  useEffect(() => {
    if (!showMaterialForm || !writable) return;
    const controller = new AbortController();
    listDrafts(project.workspaceId, controller.signal).then((page) => setPrivateDrafts(page.items.filter((item) => item.visibility === 'private' && item.owner.kind === 'human' && item.owner.id === me.user.id))).catch(() => { /* publication remains available without a draft */ });
    return () => controller.abort();
  }, [showMaterialForm, writable, project.workspaceId, me.user.id]);

  // Flux answers again (not merely a Retry or the browser's `online` event): read what arrived meanwhile.
  useEffect(() => onFluxAnswered(() => { void refresh(); }), [refresh]);
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
  // A search result or source older than the loaded window (#114): page back until it is loaded.
  useEffect(() => {
    if (!conversation || !arrived || arrivedLoaded || !olderCursor) return;
    let cancelled = false;
    void pageBackTo(arrived, olderCursor, (before, limit) => olderMessages(conversation.id, before, undefined, limit)).then(({ pages, cursor }) => {
      if (cancelled) return;
      setMessages((current) => pages.reduce((all, page) => mergeMessages(all, page.messages), current));
      setOlderCursor(cursor);
    }).catch((cause: unknown) => { hideIfDenied(cause); });
    return () => { cancelled = true; };
    // Seek once per conversation and target; later pages come from "Load earlier replies".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation?.id, arrived]);
  useEffect(() => {
    // A source link from "Since you left" or search opens on that whole message; otherwise on the latest.
    // It runs again when the thread is first shown: a hidden message cannot take focus.
    const feed = scrollRef.current;
    const anchor = arrived ? document.getElementById(`message-${arrived}`) : null;
    if (anchor && feed?.contains(anchor)) { anchor.scrollIntoView({ block: 'start' }); if (revealed) anchor.focus({ preventScroll: true }); return; }
    const column = feed?.firstElementChild as HTMLElement | null;
    if (!feed || !column) return;
    return openOnWholeMessages(feed, column, '.project-convo__message');
  }, [conversation?.id, arrived, arrivedLoaded, feedNode, revealed]);
  // Genuine replies and answers arriving in an open thread rise in gently when the reader sees them (#155,
  // UI116-5); the history the thread opens with and earlier pages never move. The thread's position owner
  // (useMessageWork) decides whether the reader follows the end.
  // A confirmed reply keeps its queued message's place and id here, so it is not a second arrival (#264).
  const messageDomKey = (id: string) => { const key = outbox.keyOf(id); return key === id ? `message-${id}` : key; };
  const threadIds = conversation ? [...feedEntries(messages.filter((message) => message.sequence > 1), assistant.answers, !!olderCursor)
    .map((entry) => entry.type === 'message' ? messageDomKey(entry.message.id) : `answer-${entry.answer.runId}`), ...outbox.pending.map((item) => `pending-${item.id}`)] : [];
  useArrivals(scrollRef, threadIds, (id) => document.getElementById(id));

  // The stream has no assistant: `/ai …` there would post the prompt for the whole project.
  const assistantInStream = !conversation && /^\/ai(\s|$)/.test(draft.trimStart());
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
    if (!asking && conversation && writable && /^\/ai(\s|$)/.test(input)) {
      helperComposer.setBody(input.replace(/^\/ai\s?/, '')); setAsking(true); setAskFailure(''); return;
    }
    setAskFailure(''); composer.setBody(input);
  }
  function exitAsk() { setAsking(false); setAskFailure(''); document.getElementById(composerId)?.focus(); }
  async function sendToAssistant() {
    if (!conversation || !writable || askBusy || askState(assistant.status, audience).kind !== 'ready') return;
    const command = helperComposer.begin();
    if (!command) return;
    const active = captureHelperScope();
    setAskFailure('');
    try {
      await assistant.ask(command.body, { clientRunId: command.clientMessageId });
      helperComposer.finish(command.clientMessageId);
      if (active()) setAsking(false);
    } catch (cause) {
      helperComposer.finish(command.clientMessageId, cause);
      if (!active()) return;
      setAskFailure(askErrorText(cause));
      setAskFailureCode(cause instanceof ApiError ? cause.code : null);
      assistant.refreshStatus();
    }
  }
  // A quoted message lands at the start of this pane's composer (Cite in the message menu).
  const quoteRef = useRef((quote: string) => { void quote; });
  useEffect(() => { quoteRef.current = (quote: string) => {
    if (!canWrite) return;
    const field = document.getElementById(composerId);
    publicComposer.setBody(`${quote}${publicComposer.draft.body}`);
    setAsking(false);
    requestAnimationFrame(() => { if (field instanceof HTMLTextAreaElement) { field.focus(); field.setSelectionRange(field.value.length, field.value.length); } });
  }; });
  useEffect(() => onCite(conversation ? 'thread' : 'stream', (quote) => quoteRef.current(quote)), [conversation]);

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
    // /file and /source open what the old buttons opened, and leave the draft as it was.
    if (option.slash === 'file') {
      changeDraft(before + after, before.length);
      document.getElementById(composerId)?.closest('.composer')?.querySelector<HTMLButtonElement>('.composer__attach')?.click();
      return;
    }
    if (option.slash === 'source') { changeDraft(before + after, before.length); setSourcesOpen(true); placeCaret(before.length, before + after); return; }
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
    if (name === 'decide') { openDetails({ kind: 'propose-decision', projectId: project.id, title: text }); consume(); return; }
    // A hand-off is a task for an agent; its owner is chosen in Details, where it opens (there is no hand-off command yet).
    if (await makeWork.createText(text)) consume();
  }
  async function send() {
    typing.stop();
    if (asking) { await sendToAssistant(); return; }
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
    else requestAnimationFrame(() => { const feed = scrollRef.current; if (feed && active()) feed.scrollTop = feed.scrollHeight; });
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
  async function loadMoreMaterials() {
    if (moreMaterialsBusy || materialOffset >= materialTotal) return;
    setMoreMaterialsBusy(true);
    try {
      const page = await listMaterials(project.id, undefined, materialOffset);
      setMaterialItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.materialId === item.materialId))]);
      setMaterialOffset((current) => current + page.items.length);
      setMaterialTotal(page.total);
    } catch (cause) { hideIfDenied(cause); setMaterialError(readableError(cause)); }
    finally { setMoreMaterialsBusy(false); }
  }
  async function submitMaterial(event: FormEvent) {
    event.preventDefault(); if (!writable || !materialTitle.trim() || materialBusy) return;
    setMaterialBusy(true); setMaterialError('');
    try {
      await publishMaterial(project.id, { title: materialTitle.trim(), body: materialBody, ...(materialUrl.trim() ? { url: materialUrl.trim() } : {}), ...(sourceDraft ? { sourceDraftId: sourceDraft.id, sourceDraftVersion: sourceDraft.version } : {}), clientMutationId: materialMutationId });
      setMaterialTitle(''); setMaterialBody(''); setMaterialUrl(''); setSourceDraft(null); setMaterialMutationId(crypto.randomUUID()); setShowMaterialForm(false); void refresh();
    } catch (cause) { hideIfDenied(cause); setMaterialError(readableError(cause)); }
    finally { setMaterialBusy(false); }
  }
  async function cite(material: Material) {
    setReadFailure(null);
    try {
      const snapshot = await getMaterialVersion(material.materialId, material.version);
      const selected = { title: snapshot.title, materialId: material.materialId, version: snapshot.version };
      publicComposer.setReference(selected); setSourcesOpen(false);
      document.getElementById(composerId)?.focus();
    } catch (cause) { hideIfDenied(cause); setReadFailure({ message: readableError(cause), retry: () => void cite(material) }); }
  }

  if (accessLost) return <div className="pane-scroll"><div className="pane-in project-setup" role="alert"><h2>Project unavailable</h2><p>Your access to this project may have changed. Reload to check current access.</p></div></div>;
  const ask = askState(assistant.status, audienceShort);
  // The root sits at the thread's top (and in the stream); the list holds its replies and answers.
  const entries = feedEntries(messages.filter((message) => message.sequence > 1), assistant.answers, !!olderCursor);
  const lookups = { projectId: project.id, messages, work: referenceWork.rows, author };
  // A manager can let their own assistant read this project in one step; anyone else asks a manager.
  const ownAgent = assistant.status?.enablement?.agents.find((item) => item.workspaceId === project.workspaceId)?.agentId ?? null;
  const grantAction = askFailureCode === 'PERSONAL_RUN_NO_PROJECT_ACCESS' && project.access === 'manager' && ownAgent ? {
    label: 'Let your assistant read this project',
    run: () => { void grantAgentProject(project.id, ownAgent, 'viewer').then(() => { setAskFailure(''); setAskFailureCode(null); }).catch(() => setAskFailure('Couldn’t give it access. Try again.')); },
  } : null;
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
  const trayOpen = sourcesOpen || (writable && showMaterialForm);
  const title = conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : project.name;
  let lastDay = '';
  const discussedRow = discussedTask ? referenceWork.rows.get(`work:${discussedTask}`) ?? null : null;
  return <div className={conversation ? 'thread__pane' : 'project-convo'} data-project-id={conversation ? undefined : project.id}
    data-associations-observed-at={conversation ? messageWork.page?.observedAt : undefined} data-associations-phase={conversation ? messageWork.state.phase : undefined}
    data-references-observed-at={conversation ? referenceWork.observation?.observedAt : undefined} data-references-phase={conversation ? referenceWork.state.phase : undefined}>
    {!conversation ? feed : <div className={`thread__feed${revealed ? '' : ' is-opening'}`} ref={attachFeed} aria-busy={revealed ? undefined : true}>
      <div className="thread__in">
        {rootHeader?.({ preview: rootMessageId ? messageWork.previews?.get(rootMessageId) ?? null : null, taskRow: discussedRow })}
        <section aria-label="Replies to this message" className="project-convo__messages">
          {conversation ? <>
            {olderCursor ? <Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Load earlier replies</Button> : null}
            <ol className="thread__list">{[...entries.flatMap((entry) => {
              const label = day(entry.at);
              const divider = label !== lastDay ? <li className="project-convo__day" key={`day-${entry.type === 'message' ? outbox.keyOf(entry.message.id) : entry.key}`}><span>{label}</span></li> : null;
              lastDay = label;
              if (entry.type === 'answer') {
                const answer = entry.answer;
                const proposal = answer.proposalId ? assistant.proposals.get(answer.proposalId) ?? null : null;
                const workTitle = proposal?.change.finishes ? referenceWork.rows.get(`work:${proposal.change.finishes.workId}`)?.title ?? 'a work item' : null;
                return [divider, <AnswerItem key={entry.key} answer={answer} mine={answer.assistant.ownerUserId === me.user.id} lookups={lookups} when={when} clock={clock}
                  proposal={proposal}
                  proposalControls={proposal ? <ProposalCard proposal={proposal} workTitle={workTitle} {...proposalAuthority(proposal.change.finishes)} onRefreshTarget={referenceWork.refresh} meId={me.user.id}
                    onDecide={async (decision) => {
                      try { await assistant.decide(proposal, decision); } finally { revalidator.revalidate(); }
                    }} /> : null}
                  onRetry={() => assistant.retry(answer.runId)}
                  onContinue={async () => { await assistant.ask('Continue', { continuesRunId: answer.runId }); }}
                  onAskAbout={writable ? () => { setAsking(true); document.getElementById(composerId)?.focus(); } : null} />];
              }
              const message = entry.message;
              // A reply confirmed from its queued message keeps that list item: it does not move or arrive twice (#264).
              return [divider, <ThreadReply key={outbox.keyOf(message.id)} message={message} mine={message.authorId === me.user.id} arrived={arrived === message.id} name={messageAuthor(message)}
                project={project} owners={owners} people={people} preview={messageWork.previews?.get(message.id) ?? null} makeWork={makeWork} writable={writable}
                onOpenResult={(resultId) => openDetails({ kind: 'result', id: resultId })} onDenied={hideIfDenied} />];
            }), ...outbox.pending.flatMap((item) => {
              const label = day(item.at);
              const divider = label !== lastDay ? <li className="project-convo__day" key={`day-pending-${item.id}`}><span>{label}</span></li> : null;
              lastDay = label;
              return [divider, <ThreadReply key={`pending-${item.id}`} pending={item} name={me.user.name} onRetry={() => publicComposer.retry(item.id)} onRemove={() => publicComposer.remove(item.id)} />];
            })]}
            {assistant.run ? <WorkingLine key={assistant.run.id} run={assistant.run} onStop={assistant.stop} onRetry={() => assistant.retry(assistant.run!.id)} onDismiss={assistant.dismissRun} /> : null}
            </ol>
          </> : null}
        </section>
      </div>
    </div>}
    {conversation ? <MessageWorkPages read={messageWork} /> : null}
    {conversation && referenceWork.state.phase === 'unavailable' ? <div className="ws-message-pages" role="alert">Referenced tasks could not be checked. Your reply is kept. <button type="button" className="ws-none__b" onClick={referenceWork.refresh}>Refresh task references</button></div> : null}
    <div className="composer project-convo__composer"><div className="composer__in" data-shift={conversation ? undefined : true}>
      {trayOpen ? <section id={`${conversation ? 'thread' : 'project'}-sources`} aria-label="Project materials" className="project-convo__materials">
        <div className="project-convo__section-head"><h3>Sources · saved for {project.name}</h3><span>{materialTotal}</span><button type="button" className="project-convo__tray-close" aria-label="Close sources" onClick={() => { setSourcesOpen(false); setShowMaterialForm(false); }}><Icon name="x" size={14} /></button></div>
        <div className="project-convo__tray">
          {materialItems.map((material) => <article className="project-convo__material" key={material.materialId}><div><strong>{writable ? material.title : <Link className="project-convo__material-read" to={`/materials/${material.materialId}/versions/${material.version}`}>{material.title}</Link>}</strong><small>v{material.version} · {author(material.authorId)} · {day(material.updatedAt)}{material.url ? <> · <a href={material.url} target="_blank" rel="noreferrer">Open link</a></> : null}</small></div>{writable ? <Button variant="link" onClick={() => void cite(material)}>Discuss this version</Button> : null}</article>)}
          {!materialItems.length ? <p className="project-convo__muted">{writable ? "Text and links you save here can be cited in any reply." : "No sources have been saved to this project yet."}</p> : null}
          {materialOffset < materialTotal ? <Button variant="quiet" busy={moreMaterialsBusy} onClick={() => void loadMoreMaterials()}>Load more materials</Button> : null}
          {writable && !showMaterialForm ? <Button variant="secondary" icon="plus" disabled={materialBusy} onClick={() => setShowMaterialForm(true)}>Add material</Button> : null}
          {writable && showMaterialForm ? <form className="project-convo__material-form" onSubmit={(event) => void submitMaterial(event)}><fieldset className="project-convo__material-fields" disabled={materialBusy}>{privateDrafts.length ? <label>Start from a private draft<select value={sourceDraft?.id ?? ''} onChange={(event) => { const chosen = privateDrafts.find((item) => item.id === event.target.value) ?? null; setSourceDraft(chosen); if (chosen) { setMaterialTitle(chosen.title); setMaterialBody(chosen.body); } setMaterialMutationId(crypto.randomUUID()); }}><option value="">No private draft</option>{privateDrafts.map((item) => <option key={item.id} value={item.id}>{item.title} · v{item.version}</option>)}</select></label> : null}<Input label="Title" value={materialTitle} onChange={(event) => { setMaterialTitle(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} required maxLength={200} /><label htmlFor={`${composerId}-material-body`}>Text</label><textarea id={`${composerId}-material-body`} value={materialBody} onChange={(event) => { setMaterialBody(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} maxLength={100000} /><Input label="Link (optional)" type="url" value={materialUrl} onChange={(event) => { setMaterialUrl(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} />{sourceDraft ? <p className="project-convo__publication">Publishing selected content from private draft v{sourceDraft.version}. Review the exact text and link above. Your original draft remains private.</p> : null}{materialError ? <p role="alert">{materialError}</p> : null}<div className="project-convo__form-actions"><Button type="submit" variant="primary" busy={materialBusy}>Save for this project</Button><Button variant="quiet" disabled={materialBusy} onClick={() => setShowMaterialForm(false)}>Cancel</Button></div></fieldset></form> : null}
          {materialError && !showMaterialForm ? <p role="alert">{materialError}</p> : null}
        </div>
      </section> : null}
      {writable ? <ConnectionLine /> : null}
      {/* On the phone "Replying to" and the audience share one line, keeping the composer compact. */}
      {asking && writable ? <AskBar id="project-ask" state={ask} error={askFailure} errorAction={grantAction} onExit={exitAsk} onAction={(action) => {
        if (action === 'connect') openDetails('connect-ai');
        else if (action === 'resume') void assistant.resume().catch(() => setAskFailure('Couldn’t resume. Try again.'));
        else navigate('/settings/assistant');
      }} /> : <div className="project-convo__to">
        {conversation ? <p className="project-convo__current-thread" title={title}>{writable ? 'Replying to' : 'Conversation'} · {title}</p> : null}
        <p className="composer__audience"><Icon name="lock" size={13} /><span>{audience}</span><span className="composer__where"> · saved to {project.name}</span></p>
      </div>}
      {writable && !asking ? <ComposerFiles state={publicComposer} attach="none" /> : null}
      {/* A tap on the card's empty space goes to the field, as in a messenger (#266 PF-3). */}
      <div className="composer__box" onClick={(event) => { if (event.target === event.currentTarget) document.getElementById(composerId)?.focus(); }}>{writable && !asking ? <AttachButton state={publicComposer} /> : null}{writable ? (asking ? null : <ComposerHint />) : <button type="button" className="composer__ask project-convo__sources-btn" aria-expanded={trayOpen} aria-controls={trayOpen ? `${conversation ? 'thread' : 'project'}-sources` : undefined} aria-label={`Sources${materialTotal ? `, ${materialTotal} saved` : ''}`} data-tip="Saved sources to read" data-tip-align="start" onClick={() => { if (trayOpen) setSourcesOpen(false); else setSourcesOpen(true); }}><Icon name="doc" /><span className="project-convo__sources-t" aria-hidden="true">Sources</span>{materialTotal ? <span className="project-convo__sources-n" aria-hidden="true">{materialTotal > 99 ? '99+' : materialTotal}</span> : null}</button>}{writable ? <><label className="ui-vh" htmlFor={composerId}>{asking ? 'Ask your assistant' : conversation ? 'Reply' : 'Write a message'}</label><textarea id={composerId} value={draft} onChange={(event) => changeDraft(event.target.value, event.target.selectionStart)} onSelect={(event) => setCaret(event.currentTarget.selectionStart)} onBlur={typing.stop} onKeyDown={onComposerKey} disabled={!writable || busy || askBusy} aria-describedby={asking ? 'project-ask' : assistantInStream ? `${composerId}-ai-hint` : undefined} aria-controls={menuOpen ? `${composerId}-menu` : undefined} aria-activedescendant={menuOpen ? `${composerId}-menu-${options[activeIndex]!.id}` : undefined} placeholder={asking ? 'Ask your assistant…' : conversation ? replyHint : phone ? 'Message · @ · /' : 'Write a message…'} rows={1} /><button className="composer__send" aria-label={asking ? 'Send to your assistant' : conversation ? 'Send reply' : 'Send message'} aria-disabled={!composer.canSend || !writable || busy || askBusy || assistantInStream || (asking && ask.kind !== 'ready')} type="button" onClick={() => void send()}><Icon name="send" /></button>{menuOpen ? <ComposerMenu id={`${composerId}-menu`} options={options} active={activeIndex} trigger={trigger!.char} onPick={pick} onHover={setMenuIndex} /> : null}</> : <p className="project-convo__read-only">Read-only · <span>You have read access to this project.</span></p>}</div>
      {conversation && !accessLost ? <TypingNotice {...typing} /> : null}
      {writable ? <SendAnnouncer pending={publicComposer.pending} /> : null}
      {writable && assistantInStream ? <p id={`${composerId}-ai-hint`} className="project-convo__hint" role="status">Your assistant answers inside a conversation. Open one and type /ai there. This text is not posted.</p> : null}
      {commandHint ? <p className="project-convo__hint" role="status">{commandHint}</p> : null}
      {makeWork.failed?.messageId.startsWith('text:') ? <p className="project-convo__error" role="alert">{makeWork.failed.text}</p> : null}
      {readFailure ? <p className="project-convo__error" role="alert">{readFailure.message} <button type="button" onClick={readFailure.retry}>Retry read</button></p> : null}
    </div></div>
  </div>;
}

/** One reply of the open thread: the message with its actions (hover, swipe, long press) and what was made from it. */
type ThreadReplyProps = {
  message: ConversationMessage; mine: boolean; arrived: boolean; name: string; project: Project; owners: AgentOwners; people: ProjectPerson[] | null;
  preview: MessageWorkPreview | null; makeWork: ReturnType<typeof useCreateWorkFromMessage>; writable: boolean;
  onOpenResult: (resultId: string) => void; onDenied: (cause: unknown) => void;
};
type QueuedReplyProps = { pending: PendingSend; name: string; onRetry: () => void; onRemove: () => void };

/**
 * One reply of the open thread, or the person's queued reply that becomes it: one component and one list
 * item for both, so the stored reply reuses the queued one's item (#264). The reply has its actions (hover,
 * swipe, long press) and what was made from it.
 */
function ThreadReply(props: ThreadReplyProps | QueuedReplyProps) {
  const stored = 'pending' in props ? null : props;
  const message = stored?.message;
  const actions = stored && message ? {
    projectId: stored.project.id, message, writable: stored.writable, busy: stored.makeWork.busy === message.id, onCreateWork: () => void stored.makeWork.create(message),
    onReply: () => document.getElementById('thread-composer')?.focus(),
    onCite: () => citeMessage('thread', quoteOf(message.body, stored.name)),
  } : null;
  const touch = useTouchActions(actions);
  if (!stored || !message || !actions) {
    const queued = props as QueuedReplyProps;
    return pendingMessageRow({ place: 'thread', keyed: false, item: queued.pending, name: queued.name, onRetry: queued.onRetry, onRemove: queued.onRemove });
  }
  const { mine, arrived, name, project, owners, people, preview, makeWork, onOpenResult, onDenied } = stored;
  return (
    <li {...touch.props} id={`message-${message.id}`} data-message-id={message.id} tabIndex={-1} className={`project-convo__message${mine ? ' is-mine' : ''}${arrived ? ' is-arrived' : ''} ${touch.props.className}`}>
      <AuthorFace kind={message.authorId === null ? 'agent' : 'human'} name={name} mine={mine} />
      <div className="project-convo__message-meta"><strong>{mine ? `${name} · you` : message.authorId === null ? <AgentAuthor message={message} owner={agentAuthorOwner(message.author, owners)} /> : <Link className="project-convo__person" to={`/dm/new?workspace=${project.workspaceId}&with=${message.authorId}`} title={`Message ${name} directly`}>{name}</Link>}</strong><time dateTime={message.createdAt} title={when(message.createdAt)}>{clock(message.createdAt)}</time><span>#{message.sequence}</span></div>
      {message.body ? <p>{mentionNodes(message.body, people)}</p> : null}
      <MessageFiles files={message.files} />
      {message.contribution ? <ContributionMark contribution={message.contribution} onOpenResult={onOpenResult} /> : null}
      {message.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} onDenied={onDenied} /> : null}
      <MessageObjects message={message} projectId={project.id} preview={preview} />
      <MessageActions {...actions} />
      {touch.node}
      {makeWork.failed?.messageId === message.id ? <p className="ws-act-error" role="alert">{makeWork.failed.text} <button type="button" onClick={() => void makeWork.create(message)}>Retry</button></p> : null}
    </li>
  );
}

type FeedEntry =
  | { type: 'message'; key: string; at: string; message: Conversation['messages'][number] }
  | { type: 'answer'; key: string; at: string; answer: AssistantAnswer };

/**
 * Messages and committed assistant answers in one chronological feed. While earlier messages
 * are not loaded, answers from before the first loaded message wait with them.
 */
function feedEntries(messages: Conversation['messages'], answers: AssistantAnswer[], hasOlder: boolean): FeedEntry[] {
  const first = messages[0]?.createdAt ?? null;
  const entries: FeedEntry[] = [
    ...messages.map((message) => ({ type: 'message' as const, key: message.id, at: message.createdAt, message })),
    ...answers.filter((answer) => !hasOlder || !first || answer.committedAt >= first)
      .map((answer) => ({ type: 'answer' as const, key: `answer-${answer.runId}`, at: answer.committedAt, answer })),
  ];
  return entries.sort((a, b) => a.at.localeCompare(b.at) || (a.type === b.type ? 0 : a.type === 'message' ? -1 : 1));
}
