import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from 'react-router';
import type { Conversation, ConversationSummary, Draft, Material, Project, SendMessageCommand, WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, EmptyState, Icon, Input } from '../ui';
import { getConversation, getMaterialVersion, getProject, listConversations, listDrafts, listMaterials, listWorkspaceMembers, olderMessages, publishMaterial, reply, startConversation } from './conversation-api';
import { useShellData } from './data';
import './project-conversation.css';

interface ProjectData { project: Project; conversations: ConversationSummary[]; conversationTotal: number; materials: Material[]; materialTotal: number; members: WorkspaceMember[]; conversation: Conversation | null }
export async function projectConversationLoader({ params, request }: LoaderFunctionArgs): Promise<ProjectData> {
  const projectId = params.projectId!;
  const project = await getProject(projectId, request.signal);
  const [threads, materials, members] = await Promise.all([listConversations(projectId, request.signal), listMaterials(projectId, request.signal), listWorkspaceMembers(project.workspaceId, request.signal)]);
  const selected = params.conversationId;
  const first = selected ?? (new URL(request.url).searchParams.has('new') ? undefined : threads.items[0]?.id);
  const conversation = first ? await getConversation(first, request.signal) : null;
  if (conversation && conversation.projectId !== projectId) throw new Response('Not found', { status: 404 });
  return { project, conversations: threads.items, conversationTotal: threads.total, materials: materials.items, materialTotal: materials.total, members, conversation };
}

function readableError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return 'This project or conversation is no longer available to you.';
  if (error instanceof ApiError && error.status === 403) return 'You can read this project, but cannot post here.';
  return error instanceof Error ? error.message : 'Could not save. Try again.';
}
function savedDraft(key: string) { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } }
function putDraft(key: string, value: string) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* private mode */ } }
interface MaterialFormSnapshot { open: boolean; title: string; body: string; url: string; sourceDraft: Draft | null; mutationId: string }
function savedMaterialForm(key: string): MaterialFormSnapshot {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}') as Partial<MaterialFormSnapshot>;
    return { open: value.open === true, title: value.title ?? '', body: value.body ?? '', url: value.url ?? '', sourceDraft: value.sourceDraft ?? null, mutationId: value.mutationId ?? crypto.randomUUID() };
  } catch { return { open: false, title: '', body: '', url: '', sourceDraft: null, mutationId: crypto.randomUUID() }; }
}
function when(iso: string) { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
function mergeMessages(current: Conversation['messages'], incoming: Conversation['messages']) {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
}

export function ProjectConversation() {
  const data = useLoaderData() as ProjectData;
  return <ProjectConversationContent key={`${data.project.id}:${data.conversation?.id ?? 'new'}`} data={data} />;
}

function ProjectConversationContent({ data }: { data: ProjectData }) {
  const { project, conversations, materials, members, conversation } = data;
  const { me } = useShellData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const materialFormKey = `flux.project-material.${me.user.id}.${project.id}`;
  const savedMaterial = useMemo(() => savedMaterialForm(materialFormKey), [materialFormKey]);
  const [draft, setDraft] = useState(() => savedDraft(`flux.project-composer.${me.user.id}.${project.id}.${conversation?.id ?? 'new'}`));
  const [pending, setPending] = useState<SendMessageCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<Conversation['messages']>(conversation?.messages ?? []);
  const [olderCursor, setOlderCursor] = useState(conversation?.messagePage.nextBeforeSequence ?? null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [threadItems, setThreadItems] = useState(conversations);
  const [threadOffset, setThreadOffset] = useState(conversations.length);
  const [threadTotal, setThreadTotal] = useState(data.conversationTotal);
  const [threadBusy, setThreadBusy] = useState(false);
  const [materialItems, setMaterialItems] = useState(materials);
  const [materialOffset, setMaterialOffset] = useState(materials.length);
  const [materialTotal, setMaterialTotal] = useState(data.materialTotal);
  const [moreMaterialsBusy, setMoreMaterialsBusy] = useState(false);
  const [showMaterialForm, setShowMaterialForm] = useState(savedMaterial.open);
  const [materialTitle, setMaterialTitle] = useState(savedMaterial.title);
  const [materialBody, setMaterialBody] = useState(savedMaterial.body);
  const [materialUrl, setMaterialUrl] = useState(savedMaterial.url);
  const [materialBusy, setMaterialBusy] = useState(false);
  const [materialError, setMaterialError] = useState('');
  const [materialMutationId, setMaterialMutationId] = useState(savedMaterial.mutationId);
  const [privateDrafts, setPrivateDrafts] = useState<Draft[]>([]);
  const [sourceDraft, setSourceDraft] = useState<Draft | null>(savedMaterial.sourceDraft);
  const [citation, setCitation] = useState<{ title: string; materialId: string; version: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftKey = `flux.project-composer.${me.user.id}.${project.id}.${conversation?.id ?? 'new'}`;
  const writable = project.access !== 'viewer';
  const conversationId = conversation?.id;
  const author = (id: string) => id === me.user.id ? me.user.name : members.find((member) => member.userId === id)?.name ?? 'Member';
  useEffect(() => {
    try { sessionStorage.setItem(materialFormKey, JSON.stringify({ open: showMaterialForm, title: materialTitle, body: materialBody, url: materialUrl, sourceDraft, mutationId: materialMutationId } satisfies MaterialFormSnapshot)); }
    catch { /* private mode: the form remains usable during this visit */ }
  }, [materialFormKey, showMaterialForm, materialTitle, materialBody, materialUrl, sourceDraft, materialMutationId]);
  const refresh = useCallback(async () => {
    revalidator.revalidate();
    try {
      const [threads, latestMaterials, latestConversation] = await Promise.all([
        listConversations(project.id),
        listMaterials(project.id),
        conversationId ? getConversation(conversationId) : Promise.resolve(null),
      ]);
      setThreadItems((current) => [...threads.items, ...current.filter((item) => !threads.items.some((latest) => latest.id === item.id))]);
      setThreadTotal(threads.total);
      setMaterialItems((current) => [...latestMaterials.items, ...current.filter((item) => !latestMaterials.items.some((latest) => latest.materialId === item.materialId))]);
      setMaterialTotal(latestMaterials.total);
      if (latestConversation) setMessages((current) => mergeMessages(current, latestConversation.messages));
    } catch { /* the route loader shows current denial or connectivity state */ }
  }, [conversationId, project.id, revalidator]);
  useEffect(() => {
    if (!showMaterialForm) return;
    const controller = new AbortController();
    listDrafts(project.workspaceId, controller.signal).then((page) => setPrivateDrafts(page.items.filter((item) => item.visibility === 'private' && item.owner.kind === 'human' && item.owner.id === me.user.id))).catch(() => { /* publication remains available without a draft */ });
    return () => controller.abort();
  }, [showMaterialForm, project.workspaceId, me.user.id]);

  useEffect(() => {
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(onFocus, 15000);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(interval); };
  }, [refresh]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [conversation?.id]);

  function changeDraft(value: string) { setDraft(value); putDraft(draftKey, value); if (pending && pending.body !== value.trim()) setPending(null); setError(''); }
  async function send() {
    if (!writable || busy || !draft.trim()) return;
    const command = pending ?? { body: draft.trim(), clientMessageId: crypto.randomUUID(), ...(citation ? { source: { materialId: citation.materialId, version: citation.version } } : {}) };
    setPending(command); setBusy(true); setError('');
    try {
      const result = conversation ? await reply(conversation.id, command) : await startConversation(project.id, command);
      setPending(null); setDraft(''); putDraft(draftKey, ''); setCitation(null);
      if (!conversation) navigate(`/projects/${project.id}/conversations/${(result as Conversation).id}`);
      else void refresh();
    } catch (cause) {
      setError(readableError(cause));
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 401)) void refresh();
    } finally { setBusy(false); }
  }
  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  }
  async function loadOlder() {
    if (!conversation || !olderCursor || olderBusy) return;
    setOlderBusy(true);
    try {
      const page = await olderMessages(conversation.id, olderCursor);
      setMessages((current) => mergeMessages(current, page.messages)); setOlderCursor(page.messagePage.nextBeforeSequence);
    } catch (cause) { setError(readableError(cause)); }
    finally { setOlderBusy(false); }
  }
  async function loadMoreThreads() {
    if (threadBusy || threadOffset >= threadTotal) return;
    setThreadBusy(true);
    try {
      const page = await listConversations(project.id, undefined, threadOffset);
      setThreadItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setThreadOffset((current) => current + page.items.length);
      setThreadTotal(page.total);
    } catch (cause) { setError(readableError(cause)); }
    finally { setThreadBusy(false); }
  }
  async function loadMoreMaterials() {
    if (moreMaterialsBusy || materialOffset >= materialTotal) return;
    setMoreMaterialsBusy(true);
    try {
      const page = await listMaterials(project.id, undefined, materialOffset);
      setMaterialItems((current) => [...current, ...page.items.filter((item) => !current.some((existing) => existing.materialId === item.materialId))]);
      setMaterialOffset((current) => current + page.items.length);
      setMaterialTotal(page.total);
    } catch (cause) { setMaterialError(readableError(cause)); }
    finally { setMoreMaterialsBusy(false); }
  }
  async function submitMaterial(event: FormEvent) {
    event.preventDefault(); if (!materialTitle.trim() || materialBusy) return;
    setMaterialBusy(true); setMaterialError('');
    try {
      await publishMaterial(project.id, { title: materialTitle.trim(), body: materialBody, ...(materialUrl.trim() ? { url: materialUrl.trim() } : {}), ...(sourceDraft ? { sourceDraftId: sourceDraft.id, sourceDraftVersion: sourceDraft.version } : {}), clientMutationId: materialMutationId });
      setMaterialTitle(''); setMaterialBody(''); setMaterialUrl(''); setSourceDraft(null); setMaterialMutationId(crypto.randomUUID()); setShowMaterialForm(false); void refresh();
    } catch (cause) { setMaterialError(readableError(cause)); }
    finally { setMaterialBusy(false); }
  }
  async function cite(material: Material) {
    try {
      const snapshot = await getMaterialVersion(material.materialId, material.version);
      setCitation({ title: snapshot.title, materialId: material.materialId, version: snapshot.version }); setPending(null); setError('');
      document.getElementById('project-composer')?.focus();
    } catch (cause) { setError(readableError(cause)); }
  }

  return <div className="project-convo" data-project-id={project.id}>
    <div className="project-convo__feed" ref={scrollRef}>
      <div className="project-convo__in">
        <div className="project-convo__head"><div><p className="project-convo__eyebrow">{project.name} · {project.visibility === 'restricted' ? 'Members only' : 'Workspace members'}</p><h2>{conversation ? conversation.firstMessageBody.split('\n')[0] || 'Conversation' : 'New conversation'}</h2><p>Capture an idea or reply here. Everyone with access to this project can read it.</p></div></div>
        <div className="project-convo__columns">
          <section aria-label="Conversations" className="project-convo__threads"><div className="project-convo__section-head"><h3>Threads</h3><span>{threadTotal}</span></div>
            <Link to={`/projects/${project.id}?new=1`} className={`project-convo__thread ${!conversation ? 'is-current' : ''}`}>New conversation</Link>
            {threadItems.map((thread) => <Link key={thread.id} to={`/projects/${project.id}/conversations/${thread.id}`} className={`project-convo__thread ${conversation?.id === thread.id ? 'is-current' : ''}`} aria-current={conversation?.id === thread.id ? 'page' : undefined}>{thread.firstMessageBody || 'Conversation'}<small>{when(thread.lastMessageAt)}</small></Link>)}
            {threadOffset < threadTotal ? <Button variant="quiet" busy={threadBusy} onClick={() => void loadMoreThreads()}>Load more conversations</Button> : null}
          </section>
          <section aria-label="Messages" className="project-convo__messages">
            {conversation ? <>
              {olderCursor ? <Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Load earlier replies</Button> : null}
              <ol className="project-convo__message-list">{messages.map((message) => <li key={message.id} className="project-convo__message"><div className="project-convo__message-meta"><strong>{author(message.authorId)}{message.authorId === me.user.id ? ' · you' : ''}</strong><time dateTime={message.createdAt}>{when(message.createdAt)}</time><span>#{message.sequence}</span></div><p>{message.body}</p>{message.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} /> : null}</li>)}</ol>
            </> : <EmptyState icon="chat" title="Start a conversation"><p>Share a thought with the people in {project.name}. No material form is required.</p></EmptyState>}
          </section>
          <section aria-label="Project materials" className="project-convo__materials"><div className="project-convo__section-head"><h3>Materials</h3><span>{materialTotal}</span></div>
            {materialItems.map((material) => <article className="project-convo__material" key={material.materialId}><strong>{material.title}</strong><p>{material.body || material.url || 'Link'}</p><small>v{material.version} · {author(material.authorId)} · Saved {when(material.updatedAt)}</small>{material.url ? <a href={material.url} target="_blank" rel="noreferrer">Open link</a> : null}<Button variant="link" onClick={() => void cite(material)}>Discuss this version</Button></article>)}
            {!materialItems.length ? <p className="project-convo__muted">Shared text and links appear here.</p> : null}
            {materialOffset < materialTotal ? <Button variant="quiet" busy={moreMaterialsBusy} onClick={() => void loadMoreMaterials()}>Load more materials</Button> : null}
            {writable ? <Button variant="secondary" icon="plus" disabled={materialBusy} onClick={() => setShowMaterialForm((open) => !open)}>{showMaterialForm ? 'Close' : 'Add material'}</Button> : null}
            {showMaterialForm ? <form className="project-convo__material-form" onSubmit={(event) => void submitMaterial(event)}><fieldset className="project-convo__material-fields" disabled={materialBusy}>{privateDrafts.length ? <label>Start from a private draft<select value={sourceDraft?.id ?? ''} onChange={(event) => { const chosen = privateDrafts.find((item) => item.id === event.target.value) ?? null; setSourceDraft(chosen); if (chosen) { setMaterialTitle(chosen.title); setMaterialBody(chosen.body); } setMaterialMutationId(crypto.randomUUID()); }}><option value="">No private draft</option>{privateDrafts.map((item) => <option key={item.id} value={item.id}>{item.title} · v{item.version}</option>)}</select></label> : null}<Input label="Title" value={materialTitle} onChange={(event) => { setMaterialTitle(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} required maxLength={200} /><label htmlFor="material-body">Text</label><textarea id="material-body" value={materialBody} onChange={(event) => { setMaterialBody(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} maxLength={100000} /><Input label="Link (optional)" type="url" value={materialUrl} onChange={(event) => { setMaterialUrl(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} />{sourceDraft ? <p className="project-convo__publication">Publishing selected content from private draft v{sourceDraft.version}. Review the exact text and link above. Your original draft remains private.</p> : null}{materialError ? <p role="alert">{materialError}</p> : null}<Button type="submit" variant="primary" busy={materialBusy}>Save for this project</Button></fieldset></form> : null}
          </section>
        </div>
      </div>
    </div>
    <div className="composer project-convo__composer"><div className="composer__in">{conversation ? <p className="project-convo__current-thread" title={conversation.firstMessageBody.split('\n')[0]}>Replying to · {conversation.firstMessageBody.split('\n')[0] || 'Conversation'}</p> : null}<p className="composer__audience"><Icon name="lock" size={13} />{project.name} · {project.visibility === 'restricted' ? 'Members only' : 'Workspace members'} · Saved to project</p>{citation ? <div className="project-convo__citation">Discussing “{citation.title}” v{citation.version}<button type="button" disabled={busy} onClick={() => { setCitation(null); setPending(null); setError(''); }} aria-label="Remove material citation">×</button></div> : null}<div className="composer__box"><label className="ui-vh" htmlFor="project-composer">{conversation ? 'Reply' : 'Start a conversation'}</label><textarea id="project-composer" value={draft} onChange={(event) => changeDraft(event.target.value)} onKeyDown={onComposerKey} disabled={!writable || busy} placeholder={conversation ? 'Reply…' : 'Share a thought…'} rows={1} /><button className="composer__send" aria-label={conversation ? 'Send reply' : 'Start conversation'} aria-disabled={!draft.trim() || !writable || busy} type="button" onClick={() => void send()}><Icon name="send" /></button></div>{error ? <p className="project-convo__error" role="alert">{error} <button type="button" onClick={() => void send()}>Retry</button></p> : null}<p className="composer__hint">{writable ? 'Enter sends · Shift+Enter adds a line. Your draft stays in this browser.' : 'You have read access to this project.'}</p></div></div>
  </div>;
}

function SourceCitation({ materialId, version }: { materialId: string; version: number }) {
  const [title, setTitle] = useState('Material');
  useEffect(() => { const controller = new AbortController(); getMaterialVersion(materialId, version, controller.signal).then((item) => setTitle(item.title)).catch(() => setTitle('Material unavailable')); return () => controller.abort(); }, [materialId, version]);
  return <Link to={`/materials/${materialId}/versions/${version}`} className="project-convo__source">Source: {title} · v{version}</Link>;
}
