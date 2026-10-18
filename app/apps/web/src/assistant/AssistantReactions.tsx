import { useCallback, useEffect, useMemo, useState } from 'react';
import { ASSISTANT_REACTION_ACTIONS, ASSISTANT_REACTION_EVENTS, assistantReactionPath, assistantReactionsPath, type AssistantReaction, type AssistantReactionAction, type AssistantReactionEvent, type GithubBinding, type PersonalAssistantStatus, type SaveAssistantReaction } from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { useShellData, type ProjectSummary } from '../app/data';
import { Button, Icon } from '../ui';
import { NoteLines, SheetFrame, useBackgroundNote } from './ScheduleSheet';
import type { ScheduleScope } from './scheduleApi';

const failure = (error: unknown) => error instanceof ApiError ? error.message : 'Couldn’t save. Your choice is kept. Try again.';
const eventLabel = (id: AssistantReactionEvent) => ASSISTANT_REACTION_EVENTS.find((event) => event.id === id)!.label;
const save = (scope: ScheduleScope, id: string | null, body: SaveAssistantReaction) => request<AssistantReaction>(id ? assistantReactionPath(scope.workspaceId, scope.ownerId, id) : assistantReactionsPath(scope.workspaceId, scope.ownerId), { method: id ? 'PUT' : 'POST', body });

/** The fixed two pickers of AST-7. Empty starter opens a prepared sentence; Turn on is the second tap. */
export function AssistantReactions({ status, userId }: { status: PersonalAssistantStatus; userId: string }) {
  const { projects: allProjects } = useShellData();
  const workspaceId = status.enablement?.agents[0]?.workspaceId ?? '';
  const scope = useMemo(() => ({ workspaceId, ownerId: userId }), [workspaceId, userId]);
  const projects = allProjects.filter((project) => project.workspaceId === workspaceId);
  const [items, setItems] = useState<AssistantReaction[] | null>(null);
  const [linked, setLinked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<AssistantReaction | 'new' | null>(null);
  const load = useCallback(() => {
    if (!workspaceId) return;
    request<{ items: AssistantReaction[] }>(assistantReactionsPath(workspaceId, userId)).then((result) => { setItems(result.items); setError(''); }, () => setError('Your choices couldn’t load. Try again.'));
  }, [workspaceId, userId]);
  useEffect(load, [load]);
  useEffect(() => {
    let live = true;
    Promise.all(projects.map(async (project) => {
      try { const bindings = await request<GithubBinding[]>(`/api/v1/projects/${project.id}/github/bindings`); return bindings.some((item) => item.state === 'active') ? project.id : null; }
      catch { return null; }
    })).then((ids) => { if (live) setLinked(ids.filter((id): id is string => !!id)); });
    return () => { live = false; };
  }, [workspaceId, allProjects]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!workspaceId) return null;
  const toggle = async (item: AssistantReaction) => {
    try { await save(scope, item.id, { projectId: item.projectId, event: item.event, action: item.action, dailyLimit: item.dailyLimit, enabled: !item.enabled, expectedVersion: item.version }); load(); }
    catch (cause) { if (cause instanceof ApiError && cause.code === 'ASSISTANT_BACKGROUND_NOTE_REQUIRED') setEditing(item); else setError(failure(cause)); }
  };
  return <>
    <h3 className="aset-screen__h" id="awhen-title">When something happens</h3>
    <section className="sset-card asched__card" aria-labelledby="awhen-title">
      {items?.map((item) => <div className="sset-row asched__row" key={item.id}>
        <button className="asched__main" type="button" onClick={() => setEditing(item)}><span className="sset-row__t">When {eventLabel(item.event)} → {ASSISTANT_REACTION_ACTIONS[item.action]}</span>
          <span className="sset-row__s">{item.projectName}{item.last ? ` · ${item.last.line || 'Working…'}` : ''}</span><span className="asched__go"><Icon name="chevron-right" size={14} /></span></button>
        <button type="button" role="switch" className="sset-switch" aria-checked={item.enabled} aria-label={`When ${eventLabel(item.event)}`} onClick={() => void toggle(item)}><span aria-hidden="true" /></button>
      </div>)}
      {items === null && !error ? <p className="sset-row" aria-busy="true">Loading…</p> : null}
      {items?.length === 0 ? <div className="sset-row sset-row--stack"><span className="sset-row__s">Nothing yet. Try one:</span><button type="button" className="asched__chip" disabled={!projects.length} onClick={() => setEditing('new')}>Tell me when a task is blocked</button></div> : null}
      <button type="button" className="sset-row sset-row--link asched__add" disabled={!projects.length} onClick={() => setEditing('new')}><span className="sset-row__ic"><Icon name="plus" size={14} /></span><span>Add</span></button>
    </section>
    {error ? <p className="nset__error" role="alert">{error} <button type="button" className="ui-link" onClick={load}>Try again</button></p> : null}
    <SheetFrame open={editing !== null} onClose={() => setEditing(null)} label="When something happens">
      {editing ? <Body scope={scope} projects={projects} linked={linked} item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} /> : null}
    </SheetFrame>
  </>;
}

function Body({ scope, projects, linked, item, onClose, onSaved }: { scope: ScheduleScope; projects: ProjectSummary[]; linked: string[]; item: AssistantReaction | null; onClose: () => void; onSaved: () => void }) {
  const [project, setProject] = useState(item?.projectId ?? projects[0]?.id ?? '');
  const [event, setEvent] = useState<AssistantReactionEvent>(item?.event ?? 'blocked');
  const [action, setAction] = useState<AssistantReactionAction>(item?.action ?? 'tell');
  const [limit, setLimit] = useState(item?.dailyLimit ?? 10);
  const [note] = useBackgroundNote(scope);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const actions = ASSISTANT_REACTION_EVENTS.find((entry) => entry.id === event)!.actions;
  const allowed = event !== 'pr_ready' || linked.includes(project);
  return <form className="asched__body" onSubmit={(submit) => { submit.preventDefault(); setBusy(true); setError('');
    void save(scope, item?.id ?? null, { projectId: project, event, action, dailyLimit: limit, enabled: true, ...(item ? { expectedVersion: item.version } : {}), ...(note ? { noteVersion: note.version } : {}) })
      .then(onSaved, (cause) => setError(failure(cause))).finally(() => setBusy(false)); }}>
    <h2 className="asched__title">When something happens</h2>
    <label className="asched__field">In<select aria-label="Project" value={project} onChange={(change) => { setProject(change.target.value); if (event === 'pr_ready' && !linked.includes(change.target.value)) { setEvent('blocked'); setAction('tell'); } }}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
    <label className="asched__field">When<select aria-label="When" value={event} onChange={(change) => { setEvent(change.target.value as AssistantReactionEvent); setAction('tell'); }}>{ASSISTANT_REACTION_EVENTS.filter((entry) => entry.id !== 'pr_ready' || linked.includes(project)).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
    <label className="asched__field">Then<select aria-label="Then" value={action} onChange={(change) => setAction(change.target.value as AssistantReactionAction)}>{actions.map((id) => <option key={id} value={id}>{ASSISTANT_REACTION_ACTIONS[id]}</option>)}</select></label>
    <p className="asched__meta">Only your items in this project. At most once per item in 30 minutes.</p>
    {action === 'draft_reply' ? <p className="asched__note">Opens Reply with a draft for you to review. Only Send posts it.</p> : null}
    <details><summary>More</summary><label className="asched__field">Runs a day<input type="number" min="1" max="24" value={limit} onChange={(change) => setLimit(Number(change.target.value))} /></label></details>
    <NoteLines note={note} />
    {error ? <p role="alert" className="nset__error">{error}</p> : null}
    <div className="asched__actions"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" busy={busy} disabled={!allowed || !project || !note}>{item?.enabled ? 'Save' : 'Turn on'}</Button></div>
  </form>;
}
