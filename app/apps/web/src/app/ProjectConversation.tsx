import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLoaderData, useLocation, useNavigate, useRevalidator, type LoaderFunctionArgs, type ShouldRevalidateFunctionArgs } from 'react-router';
import type { AssistantAnswer, ConversationMessage, Conversation, ConversationRootWindow, Draft, Material, Page, Project, SendMessageCommand, TaskCreationNotice, WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Avatar, Button, Icon, Input } from '../ui';
import { getConversation, getMaterialVersion, getProject, listConversationRoots, listDrafts, listMaterials, listTaskNotices, listWorkspaceMembers, olderMessages, publishMaterial, reply, startConversation } from './conversation-api';
import { pageBackTo } from './seekMessage';
import { useShellData } from './data';
import { MessageActions, MessageObjects, useCreateWorkFromMessage } from '../work/inline';
import { audienceLine, replyTo, useProjectShell } from '../project/data';
import { useShellActions } from './shellContext';
import { useConversationAssistant } from '../assistant/useConversationAssistant';
import { AnswerItem, AskBar, ProposalCard, WorkingLine } from '../assistant/ConversationParts';
import { askError as askErrorText, askState } from '../assistant/format';
import { grantAgentProject } from '../agent-connection/api';
import { ContributionMark, SourceCitation, clock, day, openOnWholeMessages, when } from './messageParts';
import { OneConversation, type PaneProps } from './OneConversation';
import { ThreadMessageActions } from './ThreadDrawer';
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
function savedDraft(key: string) { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } }
function putDraft(key: string, value: string) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* private mode */ } }
interface PendingSend { command: SendMessageCommand; citation: { title: string; materialId: string; version: number } | null }
function savedPending(key: string, draft: string): PendingSend | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as PendingSend | null;
    if (!saved?.command || saved.command.body !== draft.trim() || typeof saved.command.clientMessageId !== 'string') return null;
    if (saved.command.source && (!saved.citation || saved.command.source.materialId !== saved.citation.materialId || saved.command.source.version !== saved.citation.version)) return null;
    return saved;
  } catch { return null; }
}
function putPending(key: string, value: PendingSend | null) {
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); }
  catch { /* private mode: same-page retry still works */ }
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
  return <div className="project-page">
    <OneConversation key={data.project.id} data={data} Pane={ProjectConversationContent} />
  </div>;
}

/**
 * One conversation's pane: in the stream it is the composer that starts a root (UI116-1); in the thread
 * beside it, the replies with their own composer, assistant and sources.
 */
function ProjectConversationContent({ data, variant, feed, rootHeader, rootMessageId = null, onPosted, onThreadSize, focusComposer = false }: PaneProps) {
  const { project, materials, members } = data;
  const conversation = variant === 'thread' ? data.conversation : null;
  const shell = useProjectShell();
  const work = shell?.work ?? { work: [], decisions: [], results: [] };
  const people = shell?.people ?? null;
  const { me } = useShellData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const audience = audienceLine(people, me.user.id);
  const audienceShort = audience.replace(/ · only you two$/, '');
  // The stream's composer keeps the former new-conversation draft; each thread keeps its own reply draft.
  const materialFormKey = `flux.project-material.${me.user.id}.${project.id}${conversation ? '.thread' : ''}`;
  const composerId = conversation ? 'thread-composer' : 'project-composer';
  const draftKey = `flux.project-composer.${me.user.id}.${project.id}.${conversation?.id ?? 'new'}`;
  const pendingKey = `${draftKey}.pending`;
  const savedMaterial = useMemo(() => savedMaterialForm(materialFormKey), [materialFormKey]);
  const [draft, setDraft] = useState(() => savedDraft(draftKey));
  const restoredPending = useMemo(() => savedPending(pendingKey, savedDraft(draftKey)), [pendingKey, draftKey]);
  const [pending, setPending] = useState<SendMessageCommand | null>(restoredPending?.command ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readFailure, setReadFailure] = useState<{ message: string; retry: () => void } | null>(null);
  const [accessLost, setAccessLost] = useState(false);
  const [messages, setMessages] = useState<Conversation['messages']>(conversation?.messages ?? []);
  const messagesRef = useRef(messages);
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
  const [citation, setCitation] = useState<{ title: string; materialId: string; version: number } | null>(restoredPending?.citation ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const writable = project.access !== 'viewer';
  const makeWork = useCreateWorkFromMessage(project);
  const conversationId = conversation?.id;
  const author = (id: string) => id === me.user.id ? me.user.name : members.find((member) => member.userId === id)?.name ?? 'Member';
  const messageAuthor = (item: ConversationMessage) => item.authorId !== null ? author(item.authorId) : `${item.author.name ?? 'Agent'} · agent`;
  // Replies reach the whole project audience. Name a reply target only while every voice in the thread is human;
  // with a genuine agent author the named people would not match the visible thread.
  const replyHint = messages.some((message) => message.authorId === null) ? 'Reply in this conversation…' : replyTo(people, me.user.id);
  // The signed-in person's own assistant (#68): ask mode, their working line, shared answers.
  const assistant = useConversationAssistant({ meId: me.user.id, projectId: project.id, conversationId: conversation?.id ?? null });
  const { openDetails } = useShellActions();
  const [asking, setAsking] = useState(false);
  const [askBusy, setAskBusy] = useState(false);
  const [askFailure, setAskFailure] = useState('');
  const [askFailureCode, setAskFailureCode] = useState<string | null>(null);
  const askPending = useRef<{ prompt: string; clientRunId: string } | null>(null);
  const hideIfDenied = useCallback((cause: unknown) => {
    if (!(cause instanceof ApiError)) return;
    if (cause.status === 403) { revalidator.revalidate(); return; }
    if (cause.status !== 401 && cause.status !== 404) return;
    setAccessLost(true);
    revalidator.revalidate();
    void getProject(project.id).then(() => setAccessLost(false)).catch(() => { /* denial keeps previous content hidden */ });
  }, [project.id, revalidator]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  useEffect(() => {
    try { sessionStorage.setItem(materialFormKey, JSON.stringify({ open: showMaterialForm, title: materialTitle, body: materialBody, url: materialUrl, sourceDraft, mutationId: materialMutationId } satisfies MaterialFormSnapshot)); }
    catch { /* private mode: the form remains usable during this visit */ }
  }, [materialFormKey, showMaterialForm, materialTitle, materialBody, materialUrl, sourceDraft, materialMutationId]);
  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    // The stream's refresh reloads the route (newest roots, the project); a thread reads only its own replies.
    if (!conversationId) revalidator.revalidate();
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
  }, [conversationId, hideIfDenied, project.id, revalidator]);
  useEffect(() => {
    if (!showMaterialForm || !writable) return;
    const controller = new AbortController();
    listDrafts(project.workspaceId, controller.signal).then((page) => setPrivateDrafts(page.items.filter((item) => item.visibility === 'private' && item.owner.kind === 'human' && item.owner.id === me.user.id))).catch(() => { /* publication remains available without a draft */ });
    return () => controller.abort();
  }, [showMaterialForm, writable, project.workspaceId, me.user.id]);

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
    const feed = scrollRef.current;
    const anchor = arrived ? document.getElementById(`message-${arrived}`) : null;
    if (anchor && feed?.contains(anchor)) { anchor.scrollIntoView({ block: 'start' }); anchor.focus({ preventScroll: true }); return; }
    const column = feed?.firstElementChild as HTMLElement | null;
    if (!feed || !column) return;
    return openOnWholeMessages(feed, column, '.project-convo__message');
  }, [conversation?.id, arrived, arrivedLoaded]);

  function changeDraft(input: string) {
    let value = input;
    // `/ai <prompt>` at the start of the box turns on ask mode (#57 design).
    if (!asking && conversation && writable && /^\/ai(\s|$)/.test(value)) { setAsking(true); value = value.replace(/^\/ai\s?/, ''); }
    setAskFailure('');
    setDraft(value); putDraft(draftKey, value);
    if (pending && pending.body !== value.trim()) { setPending(null); putPending(pendingKey, null); }
    setError('');
  }
  function exitAsk() { setAsking(false); setAskFailure(''); document.getElementById(composerId)?.focus(); }
  async function sendToAssistant() {
    const prompt = draft.trim();
    if (!conversation || !writable || askBusy || !prompt || askState(assistant.status, audience).kind !== 'ready') return;
    // The same request retried after a lost response reuses its key: it never charges twice.
    if (askPending.current?.prompt !== prompt) askPending.current = { prompt, clientRunId: crypto.randomUUID() };
    setAskBusy(true); setAskFailure('');
    try {
      await assistant.ask(prompt, { clientRunId: askPending.current.clientRunId });
      askPending.current = null;
      // One request, then the composer is a plain reply again.
      setDraft(''); putDraft(draftKey, ''); setAsking(false);
    } catch (cause) {
      setAskFailure(askErrorText(cause));
      setAskFailureCode(cause instanceof ApiError ? cause.code : null);
      assistant.refreshStatus();
    } finally { setAskBusy(false); }
  }
  async function send() {
    if (asking) { await sendToAssistant(); return; }
    if (!writable || busy || !draft.trim()) return;
    const command = pending ?? { body: draft.trim(), clientMessageId: crypto.randomUUID(), ...(citation ? { source: { materialId: citation.materialId, version: citation.version } } : {}) };
    setPending(command); putPending(pendingKey, { command, citation }); setBusy(true); setError('');
    try {
      const result = conversation ? await reply(conversation.id, command) : await startConversation(project.id, command);
      setPending(null); putPending(pendingKey, null); setDraft(''); putDraft(draftKey, ''); setCitation(null);
      // A new root joins the stream where it was written; the thread stays closed (UI116-1).
      if (!conversation) onPosted?.(result as Conversation);
      void refresh();
    } catch (cause) {
      setError(readableError(cause));
      hideIfDenied(cause);
    } finally { setBusy(false); }
  }
  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (asking && (event.key === 'Escape' || (event.key === 'Backspace' && !draft))) { event.preventDefault(); event.stopPropagation(); exitAsk(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
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
      if (!pending?.source || pending.source.materialId !== selected.materialId || pending.source.version !== selected.version) {
        setPending(null); putPending(pendingKey, null);
      }
      setCitation(selected); setError(''); setSourcesOpen(false);
      document.getElementById(composerId)?.focus();
    } catch (cause) { hideIfDenied(cause); setReadFailure({ message: readableError(cause), retry: () => void cite(material) }); }
  }

  if (accessLost) return <div className="pane-scroll"><div className="pane-in project-setup" role="alert"><h2>Project unavailable</h2><p>Your access to this project may have changed. Reload to check current access.</p></div></div>;
  const ask = askState(assistant.status, audienceShort);
  // The root sits at the thread's top (and in the stream); the list holds its replies and answers.
  const entries = feedEntries(messages.filter((message) => message.sequence > 1), assistant.answers, !!olderCursor);
  const lookups = { projectId: project.id, messages, work: work.work, author };
  // A manager can let their own assistant read this project in one step; anyone else asks a manager.
  const ownAgent = assistant.status?.enablement?.agents.find((item) => item.workspaceId === project.workspaceId)?.agentId ?? null;
  const grantAction = askFailureCode === 'PERSONAL_RUN_NO_PROJECT_ACCESS' && project.access === 'manager' && ownAgent ? {
    label: 'Let your assistant read this project',
    run: () => { void grantAgentProject(project.id, ownAgent, 'viewer').then(() => { setAskFailure(''); setAskFailureCode(null); }).catch(() => setAskFailure('Couldn’t give it access. Try again.')); },
  } : null;
  const workOwner = (workId: string) => work.work.find((item) => item.id === workId)?.owner ?? null;
  const canDecide = (finishes: { workId: string } | null) => {
    if (!writable) return false;
    if (!finishes || project.access === 'manager') return true;
    const owner = workOwner(finishes.workId);
    return !owner || owner.kind !== 'human' || owner.id === me.user.id;
  };
  const trayOpen = sourcesOpen || (writable && showMaterialForm);
  const title = conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : project.name;
  let lastDay = '';
  return <div className={conversation ? 'thread__pane' : 'project-convo'} data-project-id={conversation ? undefined : project.id}>
    {!conversation ? feed : <div className="thread__feed" ref={scrollRef}>
      <div className="thread__in">
        {rootHeader}
        <section aria-label="Replies to this message" className="project-convo__messages">
          {conversation ? <>
            {olderCursor ? <Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Load earlier replies</Button> : null}
            <ol className="thread__list">{entries.map((entry) => {
              const label = day(entry.at);
              const divider = label !== lastDay ? <li className="project-convo__day" key={`day-${entry.key}`}><span>{label}</span></li> : null;
              lastDay = label;
              if (entry.type === 'answer') {
                const answer = entry.answer;
                const proposal = answer.proposalId ? assistant.proposals.get(answer.proposalId) ?? null : null;
                const workTitle = proposal?.change.finishes ? work.work.find((item) => item.id === proposal.change.finishes!.workId)?.title ?? 'a work item' : null;
                return [divider, <AnswerItem key={entry.key} answer={answer} mine={answer.assistant.ownerUserId === me.user.id} lookups={lookups} when={when} clock={clock}
                  proposal={proposal}
                  proposalControls={proposal ? <ProposalCard proposal={proposal} workTitle={workTitle} canDecide={canDecide(proposal.change.finishes)} meId={me.user.id}
                    onDecide={async (decision) => {
                      try { await assistant.decide(proposal, decision); } finally { revalidator.revalidate(); }
                    }} /> : null}
                  onRetry={() => assistant.retry(answer.runId)}
                  onContinue={async () => { await assistant.ask('Continue', { continuesRunId: answer.runId }); }}
                  onAskAbout={writable ? () => { setAsking(true); document.getElementById(composerId)?.focus(); } : null} />];
              }
              const message = entry.message;
              const mine = message.authorId === me.user.id;
              return [divider, <li key={message.id} id={`message-${message.id}`} tabIndex={-1} className={`project-convo__message${mine ? ' is-mine' : ''}${arrived === message.id ? ' is-arrived' : ''}`}>
                <Avatar name={messageAuthor(message)} size="md" tone={mine ? 'me' : 'neutral'} />
                <div className="project-convo__message-meta"><strong>{mine ? `${messageAuthor(message)} · you` : message.authorId === null ? messageAuthor(message) : <Link className="project-convo__person" to={`/dm/new?workspace=${project.workspaceId}&with=${message.authorId}`} title={`Message ${messageAuthor(message)} directly`}>{messageAuthor(message)}</Link>}</strong><time dateTime={message.createdAt} title={when(message.createdAt)}>{clock(message.createdAt)}</time><span>#{message.sequence}</span></div>
                <p>{message.body}</p>
                {message.contribution ? <ContributionMark contribution={message.contribution} onOpenResult={(resultId) => openDetails({ kind: 'result', id: resultId })} /> : null}
                {message.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} onDenied={hideIfDenied} /> : null}
                <MessageObjects messageId={message.id} lists={work} />
                <ThreadMessageActions writable={writable}><MessageActions projectId={project.id} message={message} writable={writable} busy={makeWork.busy === message.id} onCreateWork={() => void makeWork.create(message)} /></ThreadMessageActions>
                {makeWork.failed?.messageId === message.id ? <p className="ws-act-error" role="alert">{makeWork.failed.text} <button type="button" onClick={() => void makeWork.create(message)}>Retry</button></p> : null}
              </li>];
            })}
            {assistant.run ? <WorkingLine key={assistant.run.id} run={assistant.run} onStop={assistant.stop} onRetry={() => assistant.retry(assistant.run!.id)} onDismiss={assistant.dismissRun} /> : null}
            </ol>
          </> : null}
        </section>
      </div>
    </div>}
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
      {/* On the phone "Replying to" and the audience share one line, keeping the composer compact. */}
      {asking && writable ? <AskBar id="project-ask" state={ask} error={askFailure} errorAction={grantAction} onExit={exitAsk} onAction={(action) => {
        if (action === 'connect') openDetails('connect-ai');
        else if (action === 'resume') void assistant.resume().catch(() => setAskFailure('Couldn’t resume. Try again.'));
        else navigate('/settings/assistant');
      }} /> : <div className="project-convo__to">
        {conversation ? <p className="project-convo__current-thread" title={title}>{writable ? 'Replying to' : 'Conversation'} · {title}</p> : null}
        <p className="composer__audience"><Icon name="lock" size={13} /><span>{audience}</span><span className="composer__where"> · saved to {project.name}</span></p>
      </div>}
      {citation && writable ? <div className="project-convo__citation">Discussing “{citation.title}” v{citation.version}<button type="button" disabled={busy} onClick={() => { setCitation(null); setPending(null); putPending(pendingKey, null); setError(''); }} aria-label="Remove material citation">×</button></div> : null}
      <div className="composer__box"><button type="button" className="composer__ask project-convo__sources-btn" aria-expanded={trayOpen} aria-controls={trayOpen ? `${conversation ? 'thread' : 'project'}-sources` : undefined} aria-label={`Sources${materialTotal ? `, ${materialTotal} saved` : ''}`} data-tip={writable ? 'Sources to cite' : 'Saved sources to read'} data-tip-align="start" onClick={() => { if (trayOpen) { setSourcesOpen(false); if (writable) setShowMaterialForm(false); } else setSourcesOpen(true); }}><Icon name="doc" /><span className="project-convo__sources-t" aria-hidden="true">Sources</span>{materialTotal ? <span className="project-convo__sources-n" aria-hidden="true">{materialTotal > 99 ? '99+' : materialTotal}</span> : null}</button>{conversation && writable ? <button type="button" className="composer__ask" aria-pressed={asking} aria-label="Ask my assistant" aria-controls={asking ? 'project-ask' : undefined} data-tip="Ask my assistant · /ai" data-tip-align="start"
        onClick={() => { if (asking) exitAsk(); else { setAsking(true); document.getElementById(composerId)?.focus(); } }}><Icon name="spark" /></button> : null}{writable ? <><label className="ui-vh" htmlFor={composerId}>{asking ? 'Ask your assistant' : conversation ? 'Reply' : 'Write a message'}</label><textarea id={composerId} value={draft} onChange={(event) => changeDraft(event.target.value)} onKeyDown={onComposerKey} disabled={!writable || busy || askBusy} aria-describedby={asking ? 'project-ask' : undefined} placeholder={asking ? 'Ask your assistant…' : conversation ? replyHint : 'Write a message…'} rows={1} /><button className="composer__send" aria-label={asking ? 'Send to your assistant' : conversation ? 'Send reply' : 'Send message'} aria-disabled={!draft.trim() || !writable || busy || askBusy || (asking && ask.kind !== 'ready')} type="button" onClick={() => void send()}><Icon name="send" /></button></> : <p className="project-convo__read-only">Read-only · <span>You have read access to this project.</span></p>}</div>
      {readFailure ? <p className="project-convo__error" role="alert">{readFailure.message} <button type="button" onClick={readFailure.retry}>Retry read</button></p> : null}
      {writable && error ? <p className="project-convo__error" role="alert">{error} <button type="button" onClick={() => void send()}>Retry send</button></p> : null}
    </div></div>
  </div>;
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
