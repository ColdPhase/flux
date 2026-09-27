import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLoaderData, useNavigate, useRevalidator, type LoaderFunctionArgs } from 'react-router';
import type { Conversation, ConversationSummary, Draft, Material, Project, SendMessageCommand, WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, EmptyState, Icon, Input } from '../ui';
import { getConversation, getMaterialVersion, getProject, listConversations, listDrafts, listMaterials, listWorkspaceMembers, olderMessages, publishMaterial, reply, startConversation } from './conversation-api';
import { useShellData } from './data';
import './project-conversation.css';

interface ProjectData { project: Project; conversations: ConversationSummary[]; materials: Material[]; members: WorkspaceMember[]; conversation: Conversation | null }
export async function projectConversationLoader({ params, request }: LoaderFunctionArgs): Promise<ProjectData> {
  const projectId = params.projectId!;
  const project = await getProject(projectId, request.signal);
  const [threads, materials, members] = await Promise.all([listConversations(projectId, request.signal), listMaterials(projectId, request.signal), listWorkspaceMembers(project.workspaceId, request.signal)]);
  const selected = params.conversationId;
  const first = selected ?? (new URL(request.url).searchParams.has('new') ? undefined : threads.items[0]?.id);
  const conversation = first ? await getConversation(first, request.signal) : null;
  if (conversation && conversation.projectId !== projectId) throw new Response('Not found', { status: 404 });
  return { project, conversations: threads.items, materials: materials.items, members, conversation };
}

function readableError(error: unknown) {
  if (error instanceof ApiError && error.status === 404) return 'This project or conversation is no longer available to you.';
  if (error instanceof ApiError && error.status === 403) return 'You can read this project, but cannot post here.';
  return error instanceof Error ? error.message : 'Could not save. Try again.';
}
function savedDraft(key: string) { try { return sessionStorage.getItem(key) ?? ''; } catch { return ''; } }
function putDraft(key: string, value: string) { try { if (value) sessionStorage.setItem(key, value); else sessionStorage.removeItem(key); } catch { /* private mode */ } }
function when(iso: string) { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }

export function ProjectConversation() {
  const data = useLoaderData() as ProjectData;
  return <ProjectConversationContent key={`${data.project.id}:${data.conversation?.id ?? 'new'}`} data={data} />;
}

function ProjectConversationContent({ data }: { data: ProjectData }) {
  const { project, conversations, materials, members, conversation } = data;
  const { me } = useShellData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState(() => savedDraft(`flux.project-composer.${me.user.id}.${project.id}.${conversation?.id ?? 'new'}`));
  const [pending, setPending] = useState<SendMessageCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [older, setOlder] = useState<Conversation['messages']>([]);
  const [olderCursor, setOlderCursor] = useState(conversation?.messagePage.nextBeforeSequence ?? null);
  const [olderBusy, setOlderBusy] = useState(false);
  const [showMaterialForm, setShowMaterialForm] = useState(false);
  const [materialTitle, setMaterialTitle] = useState('');
  const [materialBody, setMaterialBody] = useState('');
  const [materialUrl, setMaterialUrl] = useState('');
  const [materialBusy, setMaterialBusy] = useState(false);
  const [materialError, setMaterialError] = useState('');
  const [materialMutationId, setMaterialMutationId] = useState(crypto.randomUUID());
  const [privateDrafts, setPrivateDrafts] = useState<Draft[]>([]);
  const [sourceDraft, setSourceDraft] = useState<Draft | null>(null);
  const [citation, setCitation] = useState<{ title: string; materialId: string; version: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const draftKey = `flux.project-composer.${me.user.id}.${project.id}.${conversation?.id ?? 'new'}`;
  const writable = project.access !== 'viewer';
  const messages = [...older, ...(conversation?.messages ?? [])];
  const author = (id: string) => id === me.user.id ? 'You' : members.find((member) => member.userId === id)?.name ?? 'Member';
  useEffect(() => {
    if (!showMaterialForm) return;
    const controller = new AbortController();
    listDrafts(project.workspaceId, controller.signal).then((page) => setPrivateDrafts(page.items.filter((item) => item.visibility === 'private' && item.owner.kind === 'human' && item.owner.id === me.user.id))).catch(() => { /* publication remains available without a draft */ });
    return () => controller.abort();
  }, [showMaterialForm, project.workspaceId, me.user.id]);

  useEffect(() => {
    const onFocus = () => revalidator.revalidate();
    const onVisible = () => { if (document.visibilityState === 'visible') revalidator.revalidate(); };
    window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onVisible);
    const interval = window.setInterval(onFocus, 15000);
    return () => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onVisible); window.clearInterval(interval); };
  }, [revalidator]);
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
      else revalidator.revalidate();
    } catch (cause) {
      setError(readableError(cause));
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 401)) revalidator.revalidate();
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
      setOlder((current) => [...page.messages, ...current]); setOlderCursor(page.messagePage.nextBeforeSequence);
    } catch (cause) { setError(readableError(cause)); }
    finally { setOlderBusy(false); }
  }
  async function submitMaterial(event: FormEvent) {
    event.preventDefault(); if (!materialTitle.trim() || materialBusy) return;
    setMaterialBusy(true); setMaterialError('');
    try {
      await publishMaterial(project.id, { title: materialTitle.trim(), body: materialBody, ...(materialUrl.trim() ? { url: materialUrl.trim() } : {}), ...(sourceDraft ? { sourceDraftId: sourceDraft.id, sourceDraftVersion: sourceDraft.version } : {}), clientMutationId: materialMutationId });
      setMaterialTitle(''); setMaterialBody(''); setMaterialUrl(''); setSourceDraft(null); setMaterialMutationId(crypto.randomUUID()); setShowMaterialForm(false); revalidator.revalidate();
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
        <div className="project-convo__head"><div><p className="project-convo__eyebrow">Project conversation · {project.visibility === 'restricted' ? 'Members only' : 'Workspace members'}</p><h2>{project.name}</h2><p>Capture an idea or reply here. Everyone with access to this project can read it.</p></div></div>
        <div className="project-convo__columns">
          <section aria-label="Conversations" className="project-convo__threads"><div className="project-convo__section-head"><h3>Threads</h3><span>{conversations.length}</span></div>
            <Link to={`/projects/${project.id}?new=1`} className={`project-convo__thread ${!conversation ? 'is-current' : ''}`}>New conversation</Link>
            {conversations.map((thread) => <Link key={thread.id} to={`/projects/${project.id}/conversations/${thread.id}`} className={`project-convo__thread ${conversation?.id === thread.id ? 'is-current' : ''}`} aria-current={conversation?.id === thread.id ? 'page' : undefined}>{thread.lastMessageBody || 'Conversation'}<small>{when(thread.lastMessageAt)}</small></Link>)}
          </section>
          <section aria-label="Messages" className="project-convo__messages">
            {conversation ? <>
              {olderCursor ? <Button variant="quiet" busy={olderBusy} onClick={() => void loadOlder()}>Load earlier replies</Button> : null}
              <ol className="project-convo__message-list">{messages.map((message) => <li key={message.id} className="project-convo__message"><div className="project-convo__message-meta"><strong>{author(message.authorId)}</strong><time dateTime={message.createdAt}>{when(message.createdAt)}</time><span>#{message.sequence}</span></div><p>{message.body}</p>{message.source ? <SourceCitation materialId={message.source.materialId} version={message.source.version} /> : null}</li>)}</ol>
            </> : <EmptyState icon="chat" title="Start a conversation"><p>Share a thought with the people in {project.name}. No material form is required.</p></EmptyState>}
          </section>
          <section aria-label="Project materials" className="project-convo__materials"><div className="project-convo__section-head"><h3>Materials</h3><span>{materials.length}</span></div>
            {materials.map((material) => <article className="project-convo__material" key={material.materialId}><strong>{material.title}</strong><p>{material.body || material.url || 'Link'}</p><small>v{material.version} · {author(material.authorId)} · Saved {when(material.updatedAt)}</small>{material.url ? <a href={material.url} target="_blank" rel="noreferrer">Open link</a> : null}<Button variant="quiet" onClick={() => void cite(material)}>Discuss this version</Button></article>)}
            {!materials.length ? <p className="project-convo__muted">Shared text and links appear here.</p> : null}
            {writable ? <Button variant="secondary" icon="plus" onClick={() => setShowMaterialForm((open) => !open)}>{showMaterialForm ? 'Close' : 'Add material'}</Button> : null}
            {showMaterialForm ? <form className="project-convo__material-form" onSubmit={(event) => void submitMaterial(event)}>{privateDrafts.length ? <label>Start from a private draft<select value={sourceDraft?.id ?? ''} onChange={(event) => { const chosen = privateDrafts.find((item) => item.id === event.target.value) ?? null; setSourceDraft(chosen); if (chosen) { setMaterialTitle(chosen.title); setMaterialBody(chosen.body); } setMaterialMutationId(crypto.randomUUID()); }}><option value="">No private draft</option>{privateDrafts.map((item) => <option key={item.id} value={item.id}>{item.title} · v{item.version}</option>)}</select></label> : null}<Input label="Title" value={materialTitle} onChange={(event) => { setMaterialTitle(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} required maxLength={200} /><label htmlFor="material-body">Text</label><textarea id="material-body" value={materialBody} onChange={(event) => { setMaterialBody(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} maxLength={100000} /><Input label="Link (optional)" type="url" value={materialUrl} onChange={(event) => { setMaterialUrl(event.target.value); setMaterialMutationId(crypto.randomUUID()); }} />{sourceDraft ? <p className="project-convo__publication">Publishing selected content from private draft v{sourceDraft.version}. Review the exact text and link above. Your original draft remains private.</p> : null}{materialError ? <p role="alert">{materialError}</p> : null}<Button type="submit" variant="primary" busy={materialBusy}>Save for this project</Button></form> : null}
          </section>
        </div>
      </div>
    </div>
    <div className="composer project-convo__composer"><div className="composer__in"><p className="composer__audience"><Icon name="lock" size={13} />{project.name} · {project.visibility === 'restricted' ? 'Members only' : 'Workspace members'} · Saved to project</p>{citation ? <div className="project-convo__citation">Discussing “{citation.title}” v{citation.version}<button type="button" onClick={() => { setCitation(null); setPending(null); setError(''); }} aria-label="Remove material citation">×</button></div> : null}<div className="composer__box"><label className="ui-vh" htmlFor="project-composer">{conversation ? 'Reply' : 'Start a conversation'}</label><textarea id="project-composer" value={draft} onChange={(event) => changeDraft(event.target.value)} onKeyDown={onComposerKey} disabled={!writable} placeholder={conversation ? 'Reply…' : 'Share a thought…'} rows={1} /><button className="composer__send" aria-label={conversation ? 'Send reply' : 'Start conversation'} aria-disabled={!draft.trim() || !writable || busy} type="button" onClick={() => void send()}><Icon name="send" /></button></div>{error ? <p className="project-convo__error" role="alert">{error} <button type="button" onClick={() => void send()}>Retry</button></p> : null}<p className="composer__hint">{writable ? 'Enter sends · Shift+Enter adds a line. Your draft stays in this browser.' : 'You have read access to this project.'}</p></div></div>
  </div>;
}

function SourceCitation({ materialId, version }: { materialId: string; version: number }) {
  const [title, setTitle] = useState('Material');
  useEffect(() => { const controller = new AbortController(); getMaterialVersion(materialId, version, controller.signal).then((item) => setTitle(item.title)).catch(() => setTitle('Material unavailable')); return () => controller.abort(); }, [materialId, version]);
  return <Link to={`/materials/${materialId}/versions/${version}`} className="project-convo__source">Source: {title} · v{version}</Link>;
}
