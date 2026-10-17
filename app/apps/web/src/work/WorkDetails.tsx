import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useRevalidator } from 'react-router';
import type { Agent, ObjectLink, Project, WorkspaceMember, WorkStatus, WorkDetailObject, WorkDetailProjection } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { AgentIdentity, Avatar, Button, Icon, Input, StatusGlyph, useToast } from '../ui';
import { getProject, listWorkspaceMembers } from '../app/conversation-api';
import { useShellData } from '../app/data';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { LiveEntry } from '../live/LiveEntry';
import { useShellActions, type ObjectView, type WorkFormView } from '../app/shellContext';
import { acceptDecision, createResult, listAgents, proposeDecision, undoTaskCreation, updateWork } from './api';
import { STATUS_LABEL, decisionLine, firstLine, isFinished, linked, resultLine, shortDate, taskNumber } from './format';
import { docsLinking } from '../docs/AddToDoc';
import { useAgentOwners } from '../agents/owners';
import { HandOffDialog } from '../agents/HandOff';
import { useProjectShell } from '../project/data';
import { useWorkRead } from './useWorkRead';
import { useNativeOwn, useWorkChoices, useDetailRelations, type DetailRelations, type DetailChoices } from './useDetailReads';
import { WorkPagination } from './WorkPagination';
import { TaskDiscussionSection } from './TaskDiscussion';
import { AgentThreadLink } from '../agents/AgentThreadLink';
import { TaskThoughtLinks } from './TaskThoughtLinks';
import { ReadyToClose, TaskPullRequests } from '../github/TaskPullRequests';
import { PanelMeta, StatusControl, TitleField, useStateKeys } from './TaskParts';

// The Details panel for work items, decisions and results, and the two forms that start from a
// message (#101). Everything shown here is visible to the people with access to the project;
// the panel says so. Changes send If-Match and an Idempotency-Key that retries reuse.

interface Context {
  project: Project;
  members: WorkspaceMember[];
  agents: Agent[];
}

const forbidden = (error: unknown) => error instanceof ApiError && error.status === 403 ? [] : Promise.reject(error);

async function loadContext(projectId: string, signal: AbortSignal): Promise<Context> {
  const project = await getProject(projectId, signal);
  const [members, agents] = await Promise.all([
    listWorkspaceMembers(project.workspaceId, signal).catch(forbidden),
    listAgents(project.workspaceId, signal).catch(forbidden),
  ]);
  return { project, members, agents: agents.filter((agent) => !agent.revokedAt) };
}

function readable(error: unknown) {
  if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') return 'Someone changed this a moment ago. The latest version is shown; try again if it still applies.';
  if (error instanceof ApiError && error.code === 'TASK_PREREQUISITES_UNMET') return 'It can start or finish only when every task it waits for is done and not parked.';
  if (error instanceof ApiError && error.code === 'WORK_NOT_FINISHABLE') return 'That work was parked or set aside meanwhile, so this result cannot finish it. The latest state is shown.';
  if (error instanceof ApiError && error.code === 'SUPERSEDED_DECISION_CHANGED') return 'The rule this would replace has already changed. Review the current rule first.';
  if (error instanceof ApiError && error.status === 404) return 'This is no longer available to you.';
  if (error instanceof ApiError && error.status === 403) return 'You can read this project but not change it.';
  return error instanceof Error ? error.message : 'Could not save. Try again.';
}

type OwnWork = Extract<WorkDetailObject, { kind: 'work' }>;
type OwnDecision = Extract<WorkDetailObject, { kind: 'decision' }>;
type OwnResult = Extract<WorkDetailObject, { kind: 'result' }>;
type Choice = 'keep' | 'park' | 'leave';
interface PanelDraft { busy: boolean; error: string; attempt: string; blocker?: string }
interface PanelCommands {
  state: PanelDraft;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setAttempt: (value: string) => void;
  setBlocker: (value: string | undefined) => void;
  isCurrent: () => boolean;
}

/** Object/form scope owns private state; versions and paging never remount it. */
export function WorkDetails({ view }: { view: ObjectView | WorkFormView }) {
  const { me } = useShellData();
  const shell = useProjectShell();
  const projectId = view.projectId ?? shell?.project.id ?? '';
  const accountId = me.user.id;
  const key = JSON.stringify([accountId, projectId, view.kind, 'id' in view ? view.id : [view.source?.messageId, view.workId]]);
  // Returning to the same object starts a new ownership lifetime. An earlier A command
  // must stay retired after A → B → A, even though its serialized scope matches again.
  const owner = useMemo(() => ({ key }), [key]);
  const activeOwner = useRef<typeof owner | null>(owner);
  useLayoutEffect(() => { activeOwner.current = owner; return () => { activeOwner.current = null; }; }, [owner]);
  const initial = useMemo(() => ({ owner, state: { busy: false, error: '', attempt: crypto.randomUUID() } as PanelDraft }), [owner]);
  const [panelDraft, setPanelDraft] = useState(initial);
  const draft = panelDraft.owner === owner ? panelDraft.state : initial.state;
  const patchDraft = (patch: Partial<PanelDraft>) => { if (activeOwner.current === owner) setPanelDraft((current) => ({ owner, state: { ...(current.owner === owner ? current.state : initial.state), ...patch } })); };
  const commands: PanelCommands = { state: draft, setBusy: (busy) => patchDraft({ busy }), setError: (error) => patchDraft({ error }), setAttempt: (attempt) => patchDraft({ attempt }), setBlocker: (blocker) => patchDraft({ blocker }), isCurrent: () => activeOwner.current === owner };
  const [tick, setTick] = useState(0);
  const revalidator = useRevalidator();
  const reload = useCallback(() => { setTick((value) => value + 1); revalidator.revalidate(); }, [revalidator]);
  // A change to this project's work by anyone (for example an Undo of a task's creation, #238) re-reads the open
  // object, so no other tab or account keeps acting on what it showed before. Private drafts are kept.
  useStreamEvents(accountId, (event) => {
    if (event.objectType === 'project' && event.objectId === projectId && /^project\.(work|decision|result|link)_/.test(event.kind)) setTick((value) => value + 1);
  }, () => setTick((value) => value + 1));
  const load = useCallback((signal: AbortSignal) => loadContext(projectId, signal), [projectId]);
  const contextRead = useWorkRead(projectId ? { accountId, projectId, selector: 'detail-context' } : null, load, tick, revalidator.state === 'idle');
  const context = contextRead.phase === 'ready' || contextRead.phase === 'refreshing' ? contextRead.value : null;
  const own = useNativeOwn(accountId, projectId, 'id' in view ? view.kind : 'work', 'id' in view ? view.id : undefined, !!context, tick);
  const detail = context ? own.value : null;
  const relations = useDetailRelations(accountId, projectId, detail);
  const [picks, setPicks] = useState<{ owner: typeof owner; values: Record<string, Choice> }>({ owner, values: {} });
  const choices = picks.owner === owner ? picks.values : {};
  const setChoices = (update: (current: Record<string, Choice>) => Record<string, Choice>) => { if (activeOwner.current === owner) setPicks((current) => ({ owner, values: update(current.owner === owner ? current.values : {}) })); };
  const unavailable = contextRead.phase === 'unavailable' || own.read.phase === 'unavailable';
  const contextStatus = contextRead.phase === 'unavailable'
    ? <p className="wd-error" role="alert">Project context could not be loaded. Your draft is kept. <button type="button" className="wd-inline" onClick={reload}>Refresh context</button></p>
    : !context ? <p className="wd-muted" role="status">Loading project context…</p> : null;
  if (view.kind === 'propose-decision') return <ProposeDecision key={key} view={view} context={context} contextStatus={contextStatus} revision={tick} isCurrent={commands.isCurrent} />;
  if (view.kind === 'attach-result') return <AttachResult key={key} view={view} context={context} contextStatus={contextStatus} reload={reload} revision={tick} isCurrent={commands.isCurrent} />;
  if (!projectId || unavailable) return <div className="details"><p className="details__eyebrow">Details</p><h3 className="details__title">Not available</h3><p className="details__lead" role="alert">{contextRead.phase === 'unavailable' ? readable(contextRead.error) : own.read.phase === 'unavailable' ? readable(own.read.error) : 'Open this object in its project.'}</p><Button variant="secondary" onClick={reload}>Refresh details</Button></div>;
  if (!context || !detail) return <div className="details" aria-busy="true"><p className="details__lead">Loading…</p></div>;
  const currentContext = { ...context, project: { ...context.project, access: detail.access } };
  const object = detail.object;
  if (object.kind === 'work') return <WorkPanel key={key} item={object} context={currentContext} detail={detail} relations={relations} reload={reload} commands={commands} />;
  if (object.kind === 'decision') return <DecisionPanel key={key} decision={object} context={currentContext} detail={detail} relations={relations} reload={reload} choices={choices} setChoices={setChoices} revision={tick} commands={commands} />;
  return <ResultPanel key={key} result={object} context={currentContext} relations={relations} />;
}

function RelationPages({ relations }: { relations: DetailRelations }) {
  // Only a successful, complete first observation proves there are no links. A later
  // empty page must retain navigation/Refresh, and pending or failed reads remain visible.
  const emptyEntry = relations.read.phase === 'ready' && relations.complete && relations.page?.total === 0 && !relations.links.length;
  return <div data-detail-relations-phase={relations.read.phase} data-detail-relations-observed-at={relations.page?.observedAt}>
    {!emptyEntry ? <WorkPagination {...relations} page={relations.page} label="Object relationship pages" noun="links" /> : null}
    {relations.read.phase === 'unavailable' ? <p className="wd-error" role="alert">Relationships could not be loaded. <button type="button" className="wd-inline" onClick={relations.onRefresh}>Refresh relationships</button></p> : null}
    {relations.page && !relations.complete ? <p className="wd-muted">Linked sections show this page of relationships. Browse all pages to explore every link.</p> : null}
  </div>;
}

function emptyLinks(relations: DetailRelations, empty: string) {
  return relations.complete ? empty : relations.page ? 'No matching links on this page.' : relations.busy ? 'Loading relationships…' : 'Relationships are unavailable.';
}

function ChoicePages({ choices, label }: { choices: DetailChoices; label: string }) {
  return <div><WorkPagination {...choices} label={label} noun="choices" />
    {choices.read.phase === 'unavailable' ? <p className="wd-error" role="alert">Choices could not be loaded. Your selection is kept. <button type="button" className="wd-inline" onClick={choices.onRefresh}>Refresh choices</button></p> : null}
  </div>;
}

function Audience({ project }: { project: Project }) {
  return (
    <section className="details__sec" aria-labelledby="wd-audience">
      <h4 id="wd-audience">Who can see this</h4>
      <p className="wd-audience"><Icon name="lock" size={13} />Everyone with access to {project.name}</p>
    </section>
  );
}

/** Buttons and links to the other ends of an object's links. */
function Linked({ items, empty }: { items: { key: string; label: ReactNode; open: () => void; hint?: string }[]; empty?: string }) {
  if (!items.length) return empty ? <p className="wd-muted">{empty}</p> : null;
  return <ul className="wd-links">{items.map((item) => <li key={item.key}><button type="button" className="wd-link" onClick={item.open}><span>{item.label}</span>{item.hint ? <small>{item.hint}</small> : null}<Icon name="chevron-right" size={14} /></button></li>)}</ul>;
}

function Sources({ links, id, project }: { links: ObjectLink[]; id: string; project: Project }) {
  const sources = links.filter((link) => link.from.id === id && link.role === 'source');
  if (!sources.length) return null;
  return (
    <ul className="wd-links">
      {sources.map((link) => {
        const to = link.to.type === 'message'
          ? `/projects/${project.id}/conversations/${link.conversationId}#message-${link.to.id}`
          : link.to.type === 'material' ? `/materials/${link.to.id}/versions/${link.to.version}`
            : link.to.type === 'thought' && link.sketchId ? `/projects/${project.id}/map/${link.sketchId}#thought-${link.to.id}` : null;
        const kind = link.to.type === 'message' ? 'Message' : link.to.type === 'thought' ? 'Thought' : `Material v${link.to.type === 'material' ? link.to.version : ''}`;
        return <li key={link.id}>{to ? <Link className="wd-link" to={to}><span><b>{kind}:</b> {link.toTitle}</span><Icon name="chevron-right" size={14} /></Link> : null}</li>;
      })}
    </ul>
  );
}

/** Docs that include or mention this result or decision (#112), and "Add to docs". */
/** Every native role has a reachable destination, including links outside the named sections. */
function OtherRelationships({ object, relations, project }: { object: WorkDetailObject; relations: DetailRelations; project: Project }) {
  const { openDetails } = useShellActions();
  const items = relations.links.flatMap((link) => {
    const outgoing = link.from.type === object.kind && link.from.id === object.id;
    const other = outgoing ? link.to : link.from;
    const title = outgoing ? link.toTitle : link.fromTitle;
    if (!outgoing && other.type === 'doc') return [];
    if (outgoing && link.role === 'source' && ['message', 'material', 'thought'].includes(other.type)) return [];
    if (object.kind === 'work' && ['decision', 'result'].includes(other.type)) return [];
    // Thoughts a task is linked to are listed in its own "Linked thoughts" section.
    if (object.kind === 'work' && other.type === 'thought') return [];
    if (object.kind === 'decision' && other.type === 'work' && ['affects', 'still_applies'].includes(link.role)) return [];
    if (object.kind === 'result' && ['work', 'decision'].includes(other.type) && link.role === 'about') return [];
    const body = <><span>{other.type}: {title}</span><small>{link.role.replaceAll('_', ' ')}</small><Icon name="chevron-right" size={14} /></>;
    if (other.type === 'work' || other.type === 'decision' || other.type === 'result') {
      const kind = other.type, id = other.id;
      return [<li key={link.id}><button type="button" className="wd-link" onClick={() => openDetails({ kind, id, projectId: project.id })}>{body}</button></li>];
    }
    const to = other.type === 'message' && link.conversationId ? `/projects/${project.id}/conversations/${link.conversationId}#message-${other.id}`
      : other.type === 'material' ? `/materials/${other.id}/versions/${other.version}`
        : other.type === 'thought' && link.sketchId ? `/projects/${project.id}/map/${link.sketchId}#thought-${other.id}`
          : other.type === 'doc' ? `/projects/${project.id}/docs/${other.id}` : other.type === 'sketch' ? `/projects/${project.id}/map/${other.id}` : null;
    return to ? [<li key={link.id}><Link className="wd-link" to={to}>{body}</Link></li>] : [];
  });
  return items.length ? <section className="details__sec" aria-label="Other relationships"><h4>Other relationships on this page</h4><ul className="wd-links">{items}</ul></section> : null;
}

function InDocs({ object, kind, project, relations }: { object: { id: string; title: string }; relations: DetailRelations; kind?: 'result' | 'decision'; project: Project }) {
  const { openDetails } = useShellActions();
  const docs = docsLinking(relations.links, object.id);
  const writable = project.access !== 'viewer';
  return (
    <section className="details__sec" aria-labelledby={`wd-docs-${object.id}`}>
      <h4 id={`wd-docs-${object.id}`}>In docs</h4>
      {docs.length ? (
        <ul className="wd-links">{docs.map((doc) => <li key={doc.id}><Link className="wd-link" to={`/projects/${project.id}/docs/${doc.id}`}><span>{doc.title}</span>{doc.role === 'source' ? <small>added</small> : <small>mentioned</small>}<Icon name="chevron-right" size={14} /></Link></li>)}</ul>
      ) : <p className="wd-muted">{emptyLinks(relations, 'Not in a doc yet.')}</p>}
      {writable && kind ? <div className="wd-actions"><Button variant="secondary" icon="doc" onClick={() => openDetails({ kind: 'add-to-doc', projectId: project.id, from: { type: kind, id: object.id, title: object.title }, inDocs: docs.filter((doc) => doc.role === 'source').map((doc) => doc.id), inDocsComplete: relations.complete })}>Add to docs</Button></div> : null}
    </section>
  );
}

function IdsLine({ children }: { children: ReactNode }) {
  return <p className="wd-ids">{children}</p>;
}

function WorkPanel({ item, context, detail, relations, reload, commands }: { item: OwnWork; context: Context; detail: WorkDetailProjection; relations: DetailRelations; reload: () => void; commands: PanelCommands }) {
  const { openDetails } = useShellActions();
  const { me } = useShellData();
  // A task whose creation was undone (#238) stays as read-only history: no change, live or new-target control.
  const reverted = item.lifecycle?.state === 'creation_reverted' ? item.lifecycle : null;
  const writable = context.project.access !== 'viewer' && !reverted;
  const { busy, error } = commands.state;
  const { setBusy, setError, setBlocker, isCurrent } = commands;
  const blocker = commands.state.blocker ?? item.blocker ?? '';
  const ownerId = useId();
  const [handingOff, setHandingOff] = useState(false);
  const owners = useAgentOwners(context.project);
  const decisions = linked(relations.links, item.id, 'decision');
  const results = linked(relations.links, item.id, 'result');
  const parkedBy = item.parked ? detail.context.find((decision) => decision.id === item.parked!.decisionId) : null;
  // An open task is the most specific place to work together, and a fragment others can open.
  const liveAnchor = { projectId: item.projectId, context: { type: 'work' as const, id: item.id }, label: item.title };
  useRegisterLiveHere(reverted ? null : liveAnchor, reverted ? null : { ref: { type: 'work', id: item.id, version: item.version }, label: item.title, what: 'task' });

  // The same change of the same version retried after a lost response reuses its command UUID: it never
  // contributes the saved blocker to the task conversation twice. A different change gets a new one.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const latest = useRef(item);
  useEffect(() => { latest.current = item; });
  const toast = useToast();
  async function change(command: Parameters<typeof updateWork>[1], base: Pick<OwnWork, 'id' | 'version'> = item, onConflict?: () => void, onSaved?: (stored: Awaited<ReturnType<typeof updateWork>>) => void): Promise<boolean> {
    const key = JSON.stringify([base.id, base.version, command]);
    if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { const stored = await updateWork(base, command, attempt.current.id); attempt.current = null; if (isCurrent()) { onSaved?.(stored); reload(); } return true; }
    catch (cause) { if (!isCurrent()) return false; setError(readable(cause)); if (cause instanceof ApiError && cause.status === 409) { attempt.current = null; onConflict?.(); reload(); } return false; }
    finally { setBusy(false); }
  }
  // A title draft is based on the version shown when its editing began. A newer version that arrives live while the
  // field is open (someone else's change, which the field hides) is a conflict the person is told about, never silently
  // written over. After that conflict the latest version is shown, and trying again saves over it.
  const titleBase = useRef<number | null>(null);
  const blockerBase = useRef<number | null>(null);
  const fieldEdits = useRef({ title: 0, blocker: 0 });
  const ownerBase = useRef<number | null>(null);
  const [ownerDraft, setOwnerDraft] = useState<string | null>(null);
  const rebase = useRef<{ title?: number; blocker?: number; owner?: number }>({});
  useEffect(() => {
    for (const field of ['title', 'blocker', 'owner'] as const) {
      const version = rebase.current[field];
      if (version !== undefined && item.version > version) {
        (field === 'title' ? titleBase : field === 'blocker' ? blockerBase : ownerBase).current = item.version;
        delete rebase.current[field];
      }
    }
  }, [item.version]);
  async function saveField(field: 'title' | 'blocker', value: string | null) {
    const base = field === 'title' ? titleBase : blockerBase;
    const version = base.current ?? item.version;
    const edit = fieldEdits.current[field];
    const ok = await change({ [field]: value }, { id: item.id, version }, () => {
      // Rebase only to the snapshot visible when the conflict is reported. Later
      // live changes must still conflict with an explicit retry.
      base.current = latest.current.version;
      if (latest.current.version <= version) rebase.current[field] = version;
    }, (stored) => {
      delete rebase.current[field];
      if (fieldEdits.current[field] === edit) {
        base.current = null;
        if (field === 'blocker') setBlocker(undefined);
      } else {
        // Text entered while the answer waited is a new draft after our own
        // stored change. Only that acknowledged version becomes its base.
        base.current = stored.version;
      }
    });
    return ok;
  }
  async function saveOwner(value: string) {
    const [kind, ...rest] = value.split(':');
    const version = ownerBase.current ?? item.version;
    const ok = await change({ owner: value ? { kind: kind as 'human' | 'agent', id: rest.join(':') } : null }, { id: item.id, version }, () => {
      ownerBase.current = latest.current.version;
      if (latest.current.version <= version) rebase.current.owner = version;
    });
    if (ok) { ownerBase.current = null; delete rebase.current.owner; setOwnerDraft(null); }
  }
  // One tap or a key changes the state at once, and the toast takes it back (S9).
  async function setState(next: WorkStatus) {
    if (!writable || busy || next === item.status) return;
    // Undo restores what this change replaced: leaving "blocked" clears its reason, so the reason goes back too.
    const before = { status: item.status, blocker: item.status === 'blocked' ? item.blocker : null, waitingFor: item.status === 'blocked' ? item.waitingFor : null };
    if (await change({ status: next })) {
      // Finishing parked work also unparks it, and the contract cannot park it again, so Undo would leave it unparked: no Undo for that change.
      // The one wink (F-026 §3) on a task closed: the words carry it without the face.
      const mascot = next === 'done' ? 'wink' as const : undefined;
      if (item.parked && (next === 'done' || next === 'not_pursued')) {
        toast({ message: `${taskNumber(item)} is now ${STATUS_LABEL[next].toLowerCase()} and no longer parked`, timeout: 8000, mascot });
        return;
      }
      // A put-back blocker is not said again in the task's conversation (restore).
      const restore = before.status === 'blocked' && (before.blocker || before.waitingFor)
        ? { status: before.status, ...(before.blocker ? { blocker: before.blocker } : {}), ...(before.waitingFor ? { waitingFor: { kind: 'human' as const, id: before.waitingFor.id } } : {}), restore: true as const }
        : { status: before.status };
      // Closing says it in the words of the wink (#N done); the other states keep their status label.
      const words = next === 'done' ? `${taskNumber(item)} done` : `${taskNumber(item)} is now ${STATUS_LABEL[next].toLowerCase()}`;
      toast({ message: words, timeout: 8000, mascot, action: { label: 'Undo', onClick: () => { void change(restore, latest.current); } } });
    }
  }
  useStateKeys(writable, (status) => void setState(status));
  const ownerValue = item.owner ? `${item.owner.kind}:${item.owner.id}` : '';
  const people = context.members.length ? context.members.map((member) => ({ value: `human:${member.userId}`, label: member.userId === me.user.id ? `${member.name} (you)` : member.name }))
    : [{ value: `human:${me.user.id}`, label: `${me.user.name} (you)` }];
  if (item.owner && !people.some((person) => person.value === ownerValue) && item.owner.kind === 'human') people.push({ value: ownerValue, label: item.owner.name });
  const waitingId = useId();
  const waitingPeople = people.map((person) => ({ ...person, id: person.value.slice('human:'.length) }));
  if (item.waitingFor && !waitingPeople.some((person) => person.id === item.waitingFor!.id)) waitingPeople.push({ value: `human:${item.waitingFor.id}`, id: item.waitingFor.id, label: item.waitingFor.name });
  const agents = context.agents.map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (agent)` }));
  if (item.owner?.kind === 'agent' && !agents.some((agent) => agent.value === ownerValue)) agents.push({ value: ownerValue, label: `${item.owner.name} (agent)` });

  return (
    <div className="details wd" data-detail-kind="work" data-detail-id={item.id}>
      <PanelMeta>{taskNumber(item)}</PanelMeta>
      <p className="wd-where"><span className="ui-task-number">{taskNumber(item)}</span> · <span className="wd-project-name">{context.project.name}</span>{item.parked ? ' · parked, not done' : ''}</p>
      <TitleField title={item.title} editable={writable} onEdit={() => { titleBase.current = item.version; }}
        onDraftChange={() => { fieldEdits.current.title++; }} onSave={(title) => saveField('title', title)} />
      {item.outcome ? <p className="details__lead">{item.outcome}</p> : null}

      <dl className="wd-rows">
        <div className="wd-row">
          <dt id={`${ownerId}-status`}>Status</dt>
          <dd>{writable ? <StatusControl status={item.status} disabled={busy} onChoose={(status) => void setState(status)} /> : <span className="wd-value"><StatusGlyph status={item.status} size={16} /><span>{reverted ? 'Creation undone · read-only history' : STATUS_LABEL[item.status]}</span></span>}</dd>
        </div>
        <div className="wd-row">
          <dt><label htmlFor={ownerId}>Owner</label></dt>
          <dd>
            {item.owner ? (item.owner.kind === 'agent' ? <AgentIdentity name={item.owner.name} owner={owners.get(item.owner.id)} /> : <Avatar name={item.owner.name} size="sm" tone={item.owner.id === me.user.id ? 'me' : 'neutral'} />) : null}
            {writable ? (
              <select id={ownerId} className="wd-owner" disabled={busy} value={ownerDraft ?? ownerValue} onFocus={() => { ownerBase.current ??= item.version; }} onPointerDown={() => { ownerBase.current ??= item.version; }} onBlur={() => { if (ownerDraft === null) ownerBase.current = null; }} onKeyDown={(event) => { if (event.key === 'Escape' && ownerDraft === null) ownerBase.current = null; else ownerBase.current ??= item.version; }} onChange={(event) => {
                ownerBase.current ??= item.version;
                setOwnerDraft(event.target.value);
                void saveOwner(event.target.value);
              }}>
                <option value="">Nobody yet</option>
                <optgroup label="People">{people.map((person) => <option key={person.value} value={person.value}>{person.label}</option>)}</optgroup>
                {agents.length ? <optgroup label="Agents">{agents.map((agent) => <option key={agent.value} value={agent.value}>{agent.label}</option>)}</optgroup> : null}
              </select>
            ) : <span className="wd-value" id={ownerId}>{item.owner?.name ?? 'Nobody yet'}</span>}
            {writable && ownerDraft !== null && !busy ? <><span className="wd-muted">Now: {item.owner?.name ?? 'Nobody yet'}</span><Button variant="quiet" onClick={() => void saveOwner(ownerDraft)}>Retry owner change</Button></> : null}
          </dd>
        </div>
        <div className="wd-row">
          <dt>Came from</dt>
          <dd className="wd-from"><CameFrom item={item} links={relations.links} project={context.project} empty={emptyLinks(relations, 'Added directly on the Tasks tab.')} /></dd>
        </div>
      </dl>
      {writable && !isFinished(item) ? <Button variant="secondary" className="wd-handoff" onClick={() => setHandingOff(true)}>Hand off to an agent</Button> : null}

      {item.status === 'blocked' ? (
        <section className="wd-blocker" aria-label="Blocker">
          <div className="wd-blocker__head"><span className="ui-pill ui-pill--inv">Blocked</span>
            {writable ? <Button variant="quiet" className="wd-blocker__resolve" disabled={busy} onClick={() => void setState('in_progress')}>Resolve</Button> : null}</div>
          {writable ? (
            <form className="wd-blocker-form" onSubmit={(event) => { event.preventDefault(); void saveField('blocker', blocker.trim() || null); }}>
              <Input label="What is it waiting for?" value={blocker} onFocus={() => { blockerBase.current ??= item.version; }} onBlur={() => { if (blocker.trim() === (item.blocker ?? '')) { blockerBase.current = null; setBlocker(undefined); } }} onChange={(event) => { fieldEdits.current.blocker++; blockerBase.current ??= item.version; setBlocker(event.target.value); }} maxLength={2000} />
              {commands.state.blocker !== undefined && item.blocker !== blocker ? <p className="wd-muted">Now: {item.blocker || 'No blocker written.'}</p> : null}
              <Button type="submit" variant="secondary" busy={busy} disabled={blocker.trim() === (item.blocker ?? '')}>Save</Button>
            </form>
          ) : <p>{item.blocker || 'Waiting for something; no reason written.'}</p>}
          {writable ? (
            <div className="wd-waiting">
              <label htmlFor={waitingId}>Waiting for</label>
              <select id={waitingId} className="wd-owner" disabled={busy} value={item.waitingFor?.id ?? ''}
                onChange={(event) => void change({ waitingFor: event.target.value ? { kind: 'human', id: event.target.value } : null })}>
                <option value="">No one in particular</option>
                {waitingPeople.map((person) => <option key={person.id} value={person.id}>{person.label}</option>)}
              </select>
            </div>
          ) : item.waitingFor ? <p className="wd-muted">Waiting for {item.waitingFor.name}</p> : null}
        </section>
      ) : null}
      {writable ? <HandOffDialog open={handingOff} onClose={() => setHandingOff(false)} project={context.project} task={{ id: item.id, version: item.version, number: item.number, title: item.title }} onDone={reload} /> : null}
      <ReadyToClose item={item} writable={writable} busy={busy} done={() => void setState('done')} />
      {!reverted && !isFinished(item) ? <LiveEntry variant="inline" anchor={liveAnchor} /> : null}

      {reverted ? <section className="details__sec wd-history" data-task-lifecycle="creation_reverted" aria-labelledby={`wd-history-${item.id}`}>
        <p className="wd-muted">Creation undone by {reverted.revertedBy.name} on {shortDate(reverted.revertedAt)}. This task stays here as history.</p>
        <h4 id={`wd-history-${item.id}`}>Activity</h4>
        <ol className="wd-history__events" aria-label="Task activity">
          <li><span className="wd-history__action">Created by</span><HistoryActor actor={item.createdBy} owners={owners} />
            <time dateTime={item.createdAt}>{historyTime(item.createdAt)}</time></li>
          <li><span className="wd-history__action">Creation undone by</span><HistoryActor actor={reverted.revertedBy} owners={owners} />
            <time dateTime={reverted.revertedAt}>{historyTime(reverted.revertedAt)}</time></li>
        </ol>
      </section> : null}
      {item.creationUndo?.eligible && writable ? <UndoCreation key={`${me.user.id}:${item.id}:${item.version}`} item={item} userId={me.user.id} reload={reload} isCurrent={isCurrent} /> : null}
      {error ? <p className="wd-error" role="alert">{error}</p> : null}

      {item.parked ? (
        <section className="details__sec" aria-labelledby="wd-parked">
          <h4 id="wd-parked">Parked by a pivot</h4>
          <p>Set aside on {shortDate(item.parked.at)} when {parkedBy ? <button type="button" className="wd-inline" onClick={() => openDetails({ kind: 'decision', id: parkedBy.id, projectId: context.project.id })}>“{parkedBy.title}”</button> : 'a new decision'} was accepted. It keeps its status and can come back.</p>
          {writable ? <div className="wd-actions"><Button variant="secondary" busy={busy} onClick={() => void change({ parked: false })}>Bring back into the plan</Button></div> : null}
        </section>
      ) : null}

      {item.criteria.length ? (
        <section className="details__sec" aria-labelledby={`wd-criteria-${item.id}`}>
          <h4 id={`wd-criteria-${item.id}`}>Done when</h4>
          <ul className="wd-criteria">{item.criteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul>
          <p className="wd-muted">Written down by whoever planned it. Flux does not check them off.</p>
        </section>
      ) : null}

      {item.prerequisites.length ? <Prerequisites item={item} openDetails={openDetails} /> : null}

      <TaskPullRequests item={item} project={context.project} writable={writable} reload={reload} />

      <RelationPages relations={relations} />

      <section className="details__sec" aria-labelledby="wd-results">
        <div className="wd-sechead"><h4 id="wd-results">Results</h4>
          {writable ? <Button variant="secondary" icon="plus" onClick={() => openDetails({ kind: 'attach-result', projectId: item.projectId, workId: item.id })}>Attach a result</Button> : null}</div>
        <Linked empty={emptyLinks(relations, isFinished(item) ? 'Finished without a written result.' : 'No result yet. Small tasks do not need one.')} items={results.map((entry) => ({ key: entry.link.id, label: entry.title, open: () => openDetails({ kind: 'result', id: entry.id, projectId: context.project.id }) }))} />
      </section>
      <TaskThoughtLinks item={item} project={context.project} links={relations.links} writable={writable} reload={reload}
        empty={emptyLinks(relations, 'Not linked to a thought yet.')} />

      <TaskDiscussionSection key={`${me.user.id}:${context.project.id}:${item.id}`} readOnly={!!reverted} revision={detail.observedAt} workId={item.id} project={context.project} number={item.number} members={context.members} me={{ id: me.user.id, name: me.user.name }} />
      <AgentThreadLink workId={item.id} projectId={context.project.id} revision={detail.observedAt} />

      <section className="details__sec" aria-labelledby="wd-decisions">
        <h4 id="wd-decisions">Decisions</h4>
        <Linked empty={emptyLinks(relations, 'No decision refers to this work yet.')} items={decisions.map((entry) => ({ key: entry.link.id, label: entry.title, hint: entry.link.role === 'still_applies' ? 'still applies' : undefined, open: () => openDetails({ kind: 'decision', id: entry.id, projectId: context.project.id }) }))} />
      </section>

      <OtherRelationships object={item} relations={relations} project={context.project} />
      <InDocs object={item} project={context.project} relations={relations} />
      <Audience project={context.project} />
      <IdsLine>Added by {item.createdBy.name} · {shortDate(item.createdAt)} · version {item.version}</IdsLine>
    </div>
  );
}

function historyTime(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function HistoryActor({ actor, owners }: { actor: OwnWork['createdBy']; owners: ReturnType<typeof useAgentOwners> }) {
  return actor.kind === 'agent'
    ? <AgentIdentity name={actor.name} owner={owners.get(actor.id)} />
    : <strong>{actor.name}</strong>;
}

/**
 * "Undo task creation" (#238): only for a server-derived eligible task. One command identity per intended Undo
 * survives a remount and a lost response, so a retry returns the same receipt instead of a second notice.
 */
function UndoCreation({ item, userId, reload, isCurrent }: { item: OwnWork; userId: string; reload: () => void; isCurrent: () => boolean }) {
  const identityKey = `flux:creation-undo:${userId}:${item.projectId}:${item.id}:${item.version}`;
  const attempt = useRef<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => () => pending.current?.abort(), []);
  async function undo() {
    if (busy || !isCurrent()) return;
    if (!attempt.current) {
      try { attempt.current = sessionStorage.getItem(identityKey); } catch { /* An in-memory retry still works. */ }
      attempt.current ??= crypto.randomUUID();
      try { sessionStorage.setItem(identityKey, attempt.current); } catch { /* Storage may be disabled. */ }
    }
    const controller = new AbortController(); pending.current = controller;
    setBusy(true); setError('');
    try {
      await undoTaskCreation(item, attempt.current, controller.signal);
      try { sessionStorage.removeItem(identityKey); } catch { /* No persisted retry to remove. */ }
      if (!controller.signal.aborted && isCurrent()) reload();
    } catch (cause) {
      if (!controller.signal.aborted && isCurrent()) setError(cause instanceof ApiError && cause.status === 409
        ? 'This task has changed or been used. Refresh its details before trying again.' : readable(cause));
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  return <section className="details__sec" aria-label="Undo task creation">
    <Button variant="secondary" busy={busy} disabled={busy} onClick={() => void undo()}>Undo task creation</Button>
    <p className="wd-muted">Available while this AI-created task is unchanged and unused. Its history stays visible.</p>
    {error ? <p className="wd-error" role="alert">{error} <button type="button" className="wd-inline" onClick={reload}>Refresh details</button></p> : null}
  </section>;
}

/** Where the task came from, as one value: its sources, or the plan revision that made it. */
function CameFrom({ item, links, project, empty }: { item: OwnWork; links: ObjectLink[]; project: Project; empty: string }) {
  const has = links.some((link) => link.from.id === item.id && link.role === 'source');
  return (
    <>
      <Sources links={links} id={item.id} project={project} />
      {item.planIntent ? (
        <p className="wd-plan">Planned from <Link className="wd-inline" to={`/materials/${item.planIntent.materialId}/versions/${item.planIntent.version}`}>plan revision {item.planIntent.version}</Link>
          {' '}as <code>{item.planIntent.intentKey}</code>. This task stays tied to that revision.</p>
      ) : null}
      {!has && !item.planIntent ? <span className="wd-muted">{empty}</span> : null}
    </>
  );
}

/** What this task waits for: each direct prerequisite with its state in words, never colour alone. */
function Prerequisites({ item, openDetails }: { item: OwnWork; openDetails: ReturnType<typeof useShellActions>['openDetails'] }) {
  const waiting = item.prerequisites.filter((prerequisite) => !prerequisite.met).length;
  // What still blocks it comes first.
  const ordered = [...item.prerequisites].sort((a, b) => Number(a.met) - Number(b.met) || a.title.localeCompare(b.title));
  return (
    <section className="details__sec" aria-labelledby={`wd-waits-${item.id}`}>
      <h4 id={`wd-waits-${item.id}`}>Waits for</h4>
      <p className={waiting ? 'wd-waiting' : 'wd-muted'} role="status">
        {waiting ? `Waiting on ${waiting} of ${item.prerequisites.length} ${item.prerequisites.length === 1 ? 'prerequisite' : 'prerequisites'}. It can start when every one is done.` : 'Every prerequisite is done.'}
      </p>
      <ul className="wd-links">
        {ordered.map((prerequisite) => (
          <li key={prerequisite.id}>
            <button type="button" className="wd-link" onClick={() => openDetails({ kind: 'work', id: prerequisite.id, projectId: item.projectId })}>
              <StatusGlyph status={prerequisite.status} size={14} />
              <span>{prerequisite.title}</span>
              <small>{STATUS_LABEL[prerequisite.status]}{prerequisite.parked ? ' · parked' : ''}{prerequisite.met ? '' : ' · waiting'}</small>
              <Icon name="chevron-right" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DecisionPanel({ decision, context, detail, relations, reload, choices, setChoices, revision, commands }: { decision: OwnDecision; context: Context; detail: WorkDetailProjection; relations: DetailRelations; reload: () => void; choices: Record<string, Choice>; setChoices: (update: (current: Record<string, Choice>) => Record<string, Choice>) => void; revision: number; commands: PanelCommands }) {
  const { openDetails } = useShellActions();
  const owners = useAgentOwners(context.project);
  const writable = context.project.access !== 'viewer';
  const earlier = decision.supersedes ? detail.context.find((item) => item.id === decision.supersedes) : null;
  const later = decision.supersededBy ? detail.context.find((item) => item.id === decision.supersededBy) : null;
  const affected = linked(relations.links, decision.id, 'work', ['affects']);
  const stillApplies = linked(relations.links, decision.id, 'work', ['still_applies']);
  const { me } = useShellData();
  const earlierRead = useNativeOwn(me.user.id, context.project.id, 'decision', earlier?.id, true, revision);
  const earlierObject = earlierRead.value?.object;
  const pivotChoices = useWorkChoices(me.user.id, context.project.id, decision.status === 'proposed' && decision.supersedes ? { purpose: 'choices', choice: 'pivot_work' } : null, true, revision);
  const parkedChoices = useWorkChoices(me.user.id, context.project.id, decision.status !== 'proposed' ? { purpose: 'choices', choice: 'parked_work', decisionId: decision.id } : null, true, revision);
  const candidates = pivotChoices.page?.items.filter((row) => row.kind === 'work') ?? [];
  const parked = parkedChoices.page?.items.filter((row) => row.kind === 'work') ?? [];
  const { busy, error, attempt } = commands.state;
  const { setBusy, setError, setAttempt, isCurrent } = commands;
  const pivot = decision.status === 'proposed' && !!decision.supersedes;
  const selectedCount = (choice: Choice) => Object.values(choices).filter((value) => value === choice).length;

  async function accept(event: FormEvent) {
    event.preventDefault();
    if (pivot && !pivotChoices.page) return;
    if (selectedCount('keep') > 50 || selectedCount('park') > 50) { setError('A pivot can keep up to 50 work items and park up to 50.'); return; }
    setBusy(true); setError('');
    const pick = (choice: Choice) => Object.entries(choices).filter(([, value]) => value === choice).map(([id]) => id);
    try {
      await acceptDecision(decision, pivot ? { stillApplies: pick('keep'), park: pick('park') } : {}, attempt);
      if (isCurrent()) reload();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(readable(cause));
      if (cause instanceof ApiError && cause.status === 409) { setAttempt(crypto.randomUUID()); reload(); }
    } finally { setBusy(false); }
  }

  return (
    <div className="details wd" data-detail-kind="decision" data-detail-id={decision.id}>
      <div className="wd-decision-identity">
        <p className={`details__eyebrow wd-eyebrow${decision.status === 'proposed' ? ' wd-need' : ''}`}><Icon name="rule" size={13} />{decisionLine(decision)}</p>
        <h3 className={`details__title${decision.status === 'superseded' ? ' wd-was' : ''}`}>{decision.title}</h3>
      </div>
      {decision.rationale ? <p className="details__lead">{decision.rationale}</p> : null}
      <dl className="details__dl wd-dl">
        <dt>Proposed</dt><dd>{decision.proposedBy.kind === 'agent' ? <AgentIdentity name={decision.proposedBy.name} owner={owners.get(decision.proposedBy.id)} /> : decision.proposedBy.name} · {shortDate(decision.createdAt)}</dd>
        {decision.decidedBy ? <><dt>Decided</dt><dd>{decision.decidedBy.name} · {shortDate(decision.decidedAt!)}</dd></> : null}
      </dl>

      {earlier ? (
        <section className="details__sec" aria-labelledby="wd-replaces">
          <h4 id="wd-replaces">{decision.status === 'proposed' ? 'Would replace' : 'Replaced'}</h4>
          <button type="button" className="wd-link" onClick={() => openDetails({ kind: 'decision', id: earlier.id, projectId: context.project.id })}><span className={earlierObject?.kind === 'decision' && earlierObject.status === 'superseded' ? 'wd-was' : ''}>{earlier.title}</span><Icon name="chevron-right" size={14} /></button>
          {earlierObject?.kind === 'decision' && earlierObject.rationale ? <p className="wd-quote">Earlier reason: {earlierObject.rationale}</p> : null}
          {earlierRead.read.phase === 'unavailable' ? <p className="wd-error" role="alert">Earlier reason could not be loaded. <button type="button" className="wd-inline" onClick={reload}>Refresh details</button></p> : null}
        </section>
      ) : null}
      {later ? (
        <section className="details__sec" aria-labelledby="wd-replaced-by">
          <h4 id="wd-replaced-by">Replaced by</h4>
          <button type="button" className="wd-link" onClick={() => openDetails({ kind: 'decision', id: later.id, projectId: context.project.id })}><span>{later.title}</span><Icon name="chevron-right" size={14} /></button>
        </section>
      ) : null}

      <RelationPages relations={relations} />
      <section className="details__sec" aria-labelledby="wd-based">
        <h4 id="wd-based">Based on</h4>
        <Sources links={relations.links} id={decision.id} project={context.project} />
        {!relations.links.some((link) => link.role === 'source') ? <p className="wd-muted">{emptyLinks(relations, 'No source linked.')}</p> : null}
      </section>
      {affected.length ? (
        <section className="details__sec" aria-labelledby="wd-affects">
          <h4 id="wd-affects">Affects</h4>
          <Linked items={affected.map((entry) => ({ key: entry.link.id, label: entry.title, open: () => openDetails({ kind: 'work', id: entry.id, projectId: context.project.id }) }))} />
        </section>
      ) : null}
      {decision.status !== 'proposed' || stillApplies.length ? (
        <section className="details__sec" aria-labelledby="wd-pivot">
          <h4 id="wd-pivot">At this pivot</h4>
          {decision.status !== 'proposed' ? <ChoicePages choices={parkedChoices} label="Parked work pages" /> : null}
          <Linked items={[
            ...stillApplies.map((entry) => ({ key: entry.link.id, label: entry.title, hint: 'still applies', open: () => openDetails({ kind: 'work', id: entry.id, projectId: context.project.id }) })),
            ...parked.map((item) => ({ key: item.id, label: item.title, hint: 'parked', open: () => openDetails({ kind: 'work', id: item.id, projectId: context.project.id }) })),
          ]} />
        </section>
      ) : null}

      {decision.status === 'proposed' && !writable ? (
        // O-009 (#250): a reader without write access sees that the proposal is not binding and who decides it.
        <section className="details__sec" aria-labelledby="wd-who-decides">
          <h4 id="wd-who-decides">Who decides</h4>
          <p>Not accepted yet. A person who can edit {context.project.name} accepts it; agents and assistants can only propose.</p>
        </section>
      ) : null}
      {decision.status === 'proposed' && writable ? (
        <form className="details__sec wd-accept" onSubmit={(event) => void accept(event)}>
          <h4>{pivot ? 'Accept as a pivot' : 'Accept'}</h4>
          <p>Accepting makes this the current rule{earlier ? ` in place of “${earlier.title}”, which stays in the history` : ''}. You are recorded as the person who decided.</p>
          {pivot ? <ChoicePages choices={pivotChoices} label="Pivot work pages" /> : null}
          {pivot && candidates.length ? (
            <fieldset className="wd-pivot" disabled={busy}>
              <legend>What happens to current work?</legend>
              {candidates.map((item) => (
                <div className="wd-pivot__row" key={item.id} role="radiogroup" aria-label={item.title}>
                  <span className="wd-pivot__t">{item.title}<small>{STATUS_LABEL[item.status]}{item.owner ? ` · ${item.owner.name}` : ''}</small></span>
                  {(['keep', 'park', 'leave'] as const).map((choice) => (
                    <label key={choice} className="wd-pivot__c"><input type="radio" name={`pivot-${item.id}`} value={choice} disabled={choice !== 'leave' && choices[item.id] !== choice && selectedCount(choice) >= 50} checked={(choices[item.id] ?? 'leave') === choice}
                      onChange={() => { setChoices((current) => { const next = { ...current }; if (choice === 'leave') delete next[item.id]; else next[item.id] = choice; return next; }); setAttempt(crypto.randomUUID()); }} />{choice === 'keep' ? 'Still applies' : choice === 'park' ? 'Park' : 'Unchanged'}</label>
                  ))}
                </div>
              ))}
            </fieldset>
          ) : null}
          <div className="wd-accept-finish">
            {pivot ? <p className="wd-muted">{selectedCount('keep')} still apply · {selectedCount('park')} parked · selections stay across pages (up to 50 each).</p> : null}
            {error ? <p className="wd-error" role="alert">{error}</p> : null}
            <div className="wd-actions"><Button type="submit" variant="primary" busy={busy} disabled={pivot && !pivotChoices.page}>{pivot ? 'Accept and pivot' : 'Accept decision'}</Button></div>
          </div>
          <p className="wd-muted">Agents can propose decisions; only people accept them.</p>
        </form>
      ) : null}

      <OtherRelationships object={decision} relations={relations} project={context.project} />
      <InDocs object={decision} kind="decision" project={context.project} relations={relations} />
      <Audience project={context.project} />
      <IdsLine>Version {decision.version}{decision.supersedes ? ' · supersedes an earlier rule' : ''}</IdsLine>
    </div>
  );
}

function ResultPanel({ result, context, relations }: { result: OwnResult; context: Context; relations: DetailRelations }) {
  const { openDetails } = useShellActions();
  useRegisterLiveHere(null, { ref: { type: 'result', id: result.id, version: 1 }, label: result.title, what: 'result' });
  const about = [...linked(relations.links, result.id, 'work', ['about']), ...linked(relations.links, result.id, 'decision', ['about'])];
  const related = relations.links.filter((link) => link.role === 'related');
  return (
    <div className="details wd" data-detail-kind="result" data-detail-id={result.id}>
      <p className={`details__eyebrow wd-eyebrow wd-finding--${result.finding}`}><Icon name="result" size={13} />{resultLine(result)} · {shortDate(result.createdAt)}</p>
      <h3 className="details__title">{result.title}</h3>
      {result.evidence ? <p className="details__lead wd-evidence">{result.evidence}</p> : null}
      <RelationPages relations={relations} />
      <section className="details__sec" aria-labelledby="wd-evidence">
        <h4 id="wd-evidence">Evidence</h4>
        <Sources links={relations.links} id={result.id} project={context.project} />
        {!relations.links.some((link) => link.role === 'source') && !result.evidence ? <p className="wd-muted">{emptyLinks(relations, 'No evidence linked.')}</p> : null}
      </section>
      <section className="details__sec" aria-labelledby="wd-about">
        <h4 id="wd-about">Reports on</h4>
        <Linked empty={emptyLinks(relations, 'Not linked to work or a decision.')} items={about.map((entry) => ({ key: entry.link.id, label: entry.title, hint: entry.link.to.type === 'decision' ? 'decision' : 'work', open: () => openDetails({ kind: entry.link.to.type as 'work' | 'decision', id: entry.id, projectId: context.project.id }) }))} />
        {related.length ? <p className="wd-muted">{related.length} more {related.length === 1 ? 'link' : 'links'}</p> : null}
      </section>
      <OtherRelationships object={result} relations={relations} project={context.project} />
      <InDocs object={result} kind="result" project={context.project} relations={relations} />
      <Audience project={context.project} />
    </div>
  );
}

function SourcePreview({ view }: { view: WorkFormView }) {
  if (!view.source) return null;
  return <blockquote className="wd-source"><span>From the message</span>{firstLine(view.source.text, 280)}</blockquote>;
}

function ProposeDecision({ view, context, contextStatus, revision, isCurrent }: { view: WorkFormView; context: Context | null; contextStatus: ReactNode; revision: number; isCurrent: () => boolean }) {
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const { me } = useShellData();
  const candidates = useWorkChoices(me.user.id, view.projectId, { purpose: 'choices', choice: 'accepted_decisions' }, !!context, revision);
  const current = candidates.page?.items.filter((item) => item.kind === 'decision') ?? [];
  const [title, setTitle] = useState(view.source ? firstLine(view.source.text) : view.title ?? '');
  const [rationale, setRationale] = useState('');
  const [supersedes, setSupersedes] = useState('');
  const selected = useNativeOwn(me.user.id, view.projectId, 'decision', supersedes || undefined, !!context, revision);
  const chosen = selected.value?.object.kind === 'decision' ? selected.value.object : null;
  const canSubmit = !!context && context.project.access !== 'viewer' && !!candidates.page && (!supersedes || chosen?.status === 'accepted');
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const rationaleId = useId();
  const replacesId = useId();
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setAttempt(crypto.randomUUID()); setError(''); };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy || !canSubmit) return;
    setBusy(true); setError('');
    try {
      const decision = await proposeDecision(view.projectId, {
        title: title.trim(), rationale, ...(supersedes ? { supersedes } : {}),
        ...(view.source ? { sources: [{ type: 'message', id: view.source.messageId }] } : {}),
        ...(view.workId ? { affects: [view.workId] } : {}),
      }, attempt);
      if (!isCurrent()) return;
      revalidator.revalidate();
      openDetails({ kind: 'decision', id: decision.id, projectId: view.projectId });
    } catch (cause) { if (isCurrent()) setError(readable(cause)); }
    finally { if (isCurrent()) setBusy(false); }
  }

  return (
    <form className="details wd" onSubmit={(event) => void submit(event)}>
      <p className="details__eyebrow wd-eyebrow"><Icon name="rule" size={13} />New proposal</p>
      <h3 className="details__title">Propose a decision</h3>
      {contextStatus}
      {context ? <SourcePreview view={view} /> : null}
      <fieldset className="wd-form" disabled={busy}>
        <Input label="Decision" value={title} onChange={(event) => edit(setTitle)(event.target.value)} required maxLength={200} />
        <label htmlFor={rationaleId}>Why</label>
        <textarea id={rationaleId} value={rationale} onChange={(event) => edit(setRationale)(event.target.value)} maxLength={20000} rows={4} placeholder="What makes this the right call" />
        <>
          <label htmlFor={replacesId}>Replaces</label>
          <select id={replacesId} value={supersedes} disabled={!candidates.page} onChange={(event) => edit(setSupersedes)(event.target.value)}>
            <option value="">Nothing, this is a new rule</option>
            {supersedes && !current.some((item) => item.id === supersedes) ? <option value={supersedes}>{chosen?.title ?? 'Selected rule (not loaded)'}</option> : null}
            {current.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
        </>
      </fieldset>
      <ChoicePages choices={candidates} label="Current rule choices" />
      {supersedes && (!chosen || chosen.status !== 'accepted') ? <p className="wd-muted">The selected rule must be currently available and accepted before this proposal can replace it.</p> : null}
      {error ? <p className="wd-error" role="alert">{error} <button type="button" className="wd-inline" onClick={(event) => void submit(event)}>Retry</button></p> : null}
      <div className="wd-actions"><Button type="submit" variant="primary" busy={busy} disabled={!canSubmit}>Propose decision</Button></div>
      <p className="wd-muted">A person with write access accepts it. The message stays where it is and links here.</p>
      {context ? <Audience project={context.project} /> : null}
    </form>
  );
}

function AttachResult({ view, context, contextStatus, reload, revision, isCurrent }: { view: WorkFormView; context: Context | null; contextStatus: ReactNode; reload: () => void; revision: number; isCurrent: () => boolean }) {
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const { me } = useShellData();
  const candidates = useWorkChoices(me.user.id, view.projectId, { purpose: 'choices', choice: 'result_work', ...(view.workId ? { selected: view.workId } : {}) }, !!context, revision);
  const open = candidates.page?.items.filter((item) => item.kind === 'work') ?? [];
  const [title, setTitle] = useState(view.source ? firstLine(view.source.text) : '');
  const [finding, setFinding] = useState<'positive' | 'negative' | ''>('');
  const [evidence, setEvidence] = useState('');
  const [workId, setWorkId] = useState(view.workId ?? '');
  const [finishes, setFinishes] = useState(false);
  const [finishVersion, setFinishVersion] = useState<number | null>(null);
  const [attempt, setAttempt] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const evidenceId = useId();
  const findingId = useId();
  const workSelectId = useId();
  const edit = <T,>(set: (value: T) => void) => (value: T) => { set(value); setAttempt(crypto.randomUUID()); setError(''); };
  const selected = useNativeOwn(me.user.id, view.projectId, 'work', workId || undefined, !!context, revision);
  const chosen = selected.value?.object.kind === 'work' ? selected.value.object : null;
  const finishable = !!chosen && !chosen.parked && chosen.status !== 'not_pursued';
  const canSubmit = !!context && context.project.access !== 'viewer' && !!candidates.page && (!workId || !!chosen) && (!finishes || finishVersion !== null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !finding || busy || !canSubmit) { if (!finding) setError('Choose whether the finding is positive or negative.'); return; }
    setBusy(true); setError('');
    try {
      const result = await createResult(view.projectId, {
        title: title.trim(), finding, evidence,
        ...(view.source ? { sources: [{ type: 'message', id: view.source.messageId }] } : {}),
        ...(workId ? { work: [workId], ...(finishes && finishVersion !== null ? { finishes: { id: workId, expectedVersion: finishVersion } } : {}) } : {}),
      }, attempt);
      if (!isCurrent()) return;
      revalidator.revalidate();
      openDetails({ kind: 'result', id: result.id, projectId: view.projectId });
    } catch (cause) {
      if (!isCurrent()) return;
      setError(readable(cause));
      // The work changed meanwhile: show its current state so the author decides again.
      if (cause instanceof ApiError && cause.status === 409) { setFinishVersion(null); setAttempt(crypto.randomUUID()); reload(); }
    } finally { if (isCurrent()) setBusy(false); }
  }

  return (
    <form className="details wd" onSubmit={(event) => void submit(event)}>
      <p className="details__eyebrow wd-eyebrow"><Icon name="result" size={13} />New result</p>
      <h3 className="details__title">Attach a result</h3>
      {contextStatus}
      {context ? <SourcePreview view={view} /> : null}
      <fieldset className="wd-form" disabled={busy}>
        <label htmlFor={findingId}>Finding</label>
        <textarea id={findingId} value={title} onChange={(event) => edit(setTitle)(event.target.value)} required maxLength={200} rows={3} />
        <div className="wd-seg" role="radiogroup" aria-label="Positive or negative">
          {(['positive', 'negative'] as const).map((value) => (
            <label key={value} className="wd-seg__b"><input type="radio" name="finding" value={value} checked={finding === value} onChange={() => edit(setFinding)(value)} />{value === 'positive' ? 'Positive' : 'Negative'}</label>
          ))}
        </div>
        <label htmlFor={evidenceId}>Evidence</label>
        <textarea id={evidenceId} value={evidence} onChange={(event) => edit(setEvidence)(event.target.value)} maxLength={20000} rows={3} placeholder="Numbers, observations or where to find them" />
        <>
          <label htmlFor={workSelectId}>For work</label>
          <select id={workSelectId} value={workId} disabled={!candidates.page} onChange={(event) => { edit(setWorkId)(event.target.value); setFinishes(false); setFinishVersion(null); }}>
            <option value="">Not linked to work</option>
            {workId && !open.some((item) => item.id === workId) ? <option value={workId}>{chosen?.title ?? 'Selected work (not loaded)'}</option> : null}
            {open.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          {chosen && finishable && finishes && finishVersion === null ? <Button variant="quiet" onClick={() => { setFinishVersion(chosen.version); setAttempt(crypto.randomUUID()); setError(''); }}>Finish current version</Button> : null}
          {chosen && !finishable && finishes ? <Button variant="quiet" onClick={() => edit(setFinishes)(false)}>Attach without finishing</Button> : null}
          {chosen && !finishable ? <p className="wd-muted">“{chosen.title}” cannot be finished by this result in its current state. Parked work must first return to the plan.</p> : null}
          {chosen && finishable ? <label className="wd-check"><input type="checkbox" checked={finishes} onChange={(event) => { setFinishVersion(event.target.checked ? chosen.version : null); edit(setFinishes)(event.target.checked); }} />This finishes “{chosen.title}”</label> : null}
        </>
      </fieldset>
      <ChoicePages choices={candidates} label="Result work choices" />
      {selected.read.phase === 'unavailable' ? <p className="wd-error" role="alert">Selected work could not be loaded. Your selection is kept. <button type="button" className="wd-inline" onClick={reload}>Refresh selected work</button></p> : null}
      {error ? <p className="wd-error" role="alert">{error}</p> : null}
      <div className="wd-actions"><Button type="submit" variant="primary" busy={busy} disabled={!canSubmit}>Attach result</Button></div>
      <p className="wd-muted">A negative result is a real outcome: it can finish an experiment.</p>
      {context ? <Audience project={context.project} /> : null}
    </form>
  );
}
