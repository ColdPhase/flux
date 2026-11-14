import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSpaceAi } from '../ai/spaceAi';
import { useRevalidator } from 'react-router';
import { waitingPhrase, type ObjectLink, type Project, type ProjectPerson, type WorkspaceMember, type WorkStatus, type WorkDetailObject, type WorkDetailProjection } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { AgentIdentity, Avatar, Button, Icon, Kreska, Morph, PanelGlyph, StatusGlyph, useToast } from '../ui';
import { getProject, listWorkspaceMembers } from '../project/api';
import { useShellData } from '../app/data';
import { DetailsSkeleton } from '../app/SurfaceSkeletons';
import { useRegisterLiveHere } from '../live/LiveProvider';
import { LiveEntry } from '../live/LiveEntry';
import { useShellActions, type ObjectView } from '../app/shellContext';
import { useNeedsYou, announceInboxChange } from '../notifications/needsYou';
import { useNeedsYouActions } from '../notifications/useNeedsYouActions';
import { NotNowButton, WaitingLine } from '../notifications/NeedsYouCard';
import '../notifications/needs-you.css';
import { useDiscussDecision } from './discuss';
import { acceptDecision, resolveWaiting, undoTaskCreation, updateWork } from './api';
import { STATUS_LABEL, decisionLine, isFinished, linked, shortDate, statusPhrase, taskNumber } from './format';
import { docsLinking } from '../docs/AddToDoc';
import { useAgentOwners } from '../agents/owners';
import { TaskPeople } from '../agents/TaskPeople';
import { listProjectPeople, useProjectShell } from '../project/data';
import { useWorkRead } from './useWorkRead';
import { useNativeOwn, useWorkChoices, useDetailRelations, type DetailRelations } from './useDetailReads';
import { WorkPagination } from './WorkPagination';
import { ActivityTimeline, TaskComposer, useTaskActivity } from './TaskActivity';
import { LinkThoughtButton, LinkedThoughts, useThoughtLinks } from './TaskThoughtLinks';
import { PropertyMenu } from './PropertyMenu';
import { WaitingField } from './WaitingField';
import { useComposerDraft } from '../composer/draft';
import { RefLink } from '../place/origin';
import { ReadyToClose, TaskPullRequests } from '../github/TaskPullRequests';
import { DueField, StatusControl, TitleField, useStateKeys } from './TaskParts';
import { stateWords } from './taskState';

/** The user id in an owner choice's value (`human:<id>`), for the person's photo (F-039); null for an agent or nobody. */
const humanId = (value: string | null | undefined) => value?.startsWith('human:') ? value.slice('human:'.length) : null;

// The Details panel for work items and decisions, and the two forms that start from a
// message (#101). Everything shown here is visible to the people with access to the project;
// the panel says so. Changes send If-Match and an Idempotency-Key that retries reuse.

interface Context {
  project: Project;
  members: WorkspaceMember[];
  /** The people in the space (F-037): the Owner and Waiting-for choices offer these and nobody else, so nobody is given a task unannounced. */
  spacePeople: { userId: string; name: string }[];
}

const forbidden = (error: unknown) => error instanceof ApiError && error.status === 403 ? [] : Promise.reject(error);

async function loadContext(projectId: string, signal: AbortSignal): Promise<Context> {
  const project = await getProject(projectId, signal);
  const [members, audience] = await Promise.all([
    listWorkspaceMembers(project.workspaceId, signal).catch(forbidden),
    listProjectPeople(projectId, signal).catch(() => [] as ProjectPerson[]),
  ]);
  const spacePeople = audience.filter((person) => person.kind === 'human').map((person) => ({ userId: person.id, name: person.name }));
  return { project, members, spacePeople };
}

function readable(error: unknown) {
  if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') return 'Someone changed this a moment ago. The latest version is shown; try again if it still applies.';
  if (error instanceof ApiError && error.code === 'TASK_PREREQUISITES_UNMET') return 'It can start or finish only when every task it waits for is done.';
  if (error instanceof ApiError && error.code === 'WAITING_ON_RESOLVED') return 'That is already decided or done, so there is nothing to wait for.';
  if (error instanceof ApiError && error.code === 'WAITING_ON_CYCLE') return 'That task is waiting for this one.';
  if (error instanceof ApiError && error.code === 'WAITING_ON_ITSELF') return 'A task cannot wait for itself.';
  if (error instanceof ApiError && error.code === 'NOT_WAITING_FOR_YOU') return 'This task no longer waits for you. The latest state is shown.';
  if (error instanceof ApiError && error.code === 'SUPERSEDED_DECISION_CHANGED') return 'The decision this would replace has already changed. Check it first.';
  if (error instanceof ApiError && error.status === 404) return 'This is no longer available to you.';
  if (error instanceof ApiError && error.status === 403) return 'You can read this space but not change it.';
  return error instanceof Error ? error.message : 'Could not save. Try again.';
}

type OwnWork = Extract<WorkDetailObject, { kind: 'work' }>;
type OwnDecision = Extract<WorkDetailObject, { kind: 'decision' }>;
interface PanelDraft { busy: boolean; error: string; attempt: string; blocker?: string }
interface PanelCommands {
  state: PanelDraft;
  setBusy: (value: boolean) => void;
  setError: (value: string) => void;
  setAttempt: (value: string) => void;
  setBlocker: (value: string | undefined) => void;
  isCurrent: () => boolean;
}

/** Object scope owns private state; versions and paging never remount it. */
export function WorkDetails({ view }: { view: ObjectView }) {
  const { me } = useShellData();
  const shell = useProjectShell();
  const projectId = view.projectId ?? shell?.project.id ?? '';
  const accountId = me.user.id;
  const key = JSON.stringify([accountId, projectId, view.kind, view.id]);
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
  // A change to this project's work by anyone (for example an Undo of a task's creation, #238, or the owner deleting an agent's line in
  // the thread, #961) re-reads the open object, so no other tab or account keeps acting on what it showed before. Private drafts are kept.
  useStreamEvents(accountId, (event) => {
    if (event.objectType === 'project' && event.objectId === projectId && /^project\.((work|decision|link)_|assistant_change_undone\.)/.test(event.kind)) setTick((value) => value + 1);
  }, () => setTick((value) => value + 1));
  const load = useCallback((signal: AbortSignal) => loadContext(projectId, signal), [projectId]);
  const contextRead = useWorkRead(projectId ? { accountId, projectId, selector: 'detail-context' } : null, load, tick, revalidator.state === 'idle');
  const context = contextRead.phase === 'ready' || contextRead.phase === 'refreshing' ? contextRead.value : null;
  const own = useNativeOwn(accountId, projectId, view.kind, view.id, !!context, tick);
  const detail = context ? own.value : null;
  const relations = useDetailRelations(accountId, projectId, detail);
  const [shownWith, setShownWith] = useState<string | null>(null);
  const unavailable = contextRead.phase === 'unavailable' || own.read.phase === 'unavailable';
  if (!projectId || unavailable) {
    // A read that failed for now is said as every place says it, with Try again and no server words (#1369); one that is gone or closed is "Not available".
    const failure = contextRead.phase === 'unavailable' ? contextRead.error : own.read.phase === 'unavailable' ? own.read.error : null;
    const gone = !projectId || (failure instanceof ApiError && (failure.status === 404 || failure.status === 403));
    return <div className="details"><p className="details__eyebrow">Details</p><h3 className="details__title">{gone ? 'Not available' : 'The details couldn’t be loaded'}</h3>
      <p className="details__lead" role="alert">{!projectId ? 'Open this object in its space.' : gone ? 'This is no longer available to you.' : 'Nothing was lost.'}</p>
      {gone ? null : <Button variant="secondary" icon="refresh" onClick={reload}>Try again</Button>}</div>;
  }
  // A task's panel appears in its final layout (#899, motion rule 2): its relationships decide which rows and sections it has,
  // so their first read finishes before it is shown. Once shown, a refresh or another page keeps the panel (and its drafts).
  const relationsSettled = relations.read.phase !== 'loading' && relations.read.phase !== 'idle';
  if (relationsSettled && shownWith !== key) setShownWith(key);
  if (!context || !detail || (detail.object.kind === 'work' && shownWith !== key && !relationsSettled)) return <DetailsSkeleton title={view.kind === 'work' ? view.title : undefined} />;
  const currentContext = { ...context, project: { ...context.project, access: detail.access } };
  const object = detail.object;
  if (object.kind === 'work') return <WorkPanel key={key} item={object} context={currentContext} detail={detail} relations={relations} reload={reload} commands={commands} />;
  return <DecisionPanel key={key} decision={object} context={currentContext} detail={detail} relations={relations} reload={reload} revision={tick} commands={commands} />;
}

function RelationPages({ relations }: { relations: DetailRelations }) {
  // Pagination shows only when there is another page (Spokój rule 4); a failed read stays visible. While the first read is pending its status
  // is still there for a screen reader, but it takes no room: a row that stood for the length of the read pushed the sections below it down
  // by 61 px and took them back when the page arrived (#863 rule 6).
  const paged = !relations.page || !!relations.page.previousCursor || !!relations.page.nextCursor || relations.page.before > 0;
  const pending = !relations.page && relations.read.phase !== 'unavailable';
  return <div data-detail-relations-phase={relations.read.phase} data-detail-relations-observed-at={relations.page?.observedAt}>
    {paged ? pending ? <nav className="ui-vh" aria-label="Object relationship pages" aria-busy="true"><span role="status">Loading work…</span></nav>
      : <WorkPagination {...relations} page={relations.page} label="Object relationship pages" noun="links" stepsWhenPaged /> : null}
    {relations.read.phase === 'unavailable' ? <p className="wd-error" role="alert">Relationships could not be loaded. <button type="button" className="wd-inline" onClick={relations.onRefresh}>Refresh relationships</button></p> : null}
    {relations.page && !relations.complete ? <p className="wd-muted">Linked sections show this page of relationships. Browse all pages to explore every link.</p> : null}
  </div>;
}

function emptyLinks(relations: DetailRelations, empty: string) {
  return relations.complete ? empty : relations.page ? 'No matching links on this page.' : relations.busy ? 'Loading relationships…' : 'Relationships are unavailable.';
}

/** Buttons and links to the other ends of an object's links. */
function Linked({ items, empty }: { items: { key: string; label: ReactNode; open: () => void; hint?: string }[]; empty?: string }) {
  if (!items.length) return empty ? <p className="wd-muted">{empty}</p> : null;
  return <ul className="wd-links">{items.map((item) => <li key={item.key}><button type="button" className="wd-link" onClick={item.open}><span>{item.label}</span>{item.hint ? <small>{item.hint}</small> : null}<Icon name="chevron-right" size={14} /></button></li>)}</ul>;
}

/** The other ends a task, decision or result came from; `of` names the task a message link arrives for ("Source of #1"). */
function Sources({ links, id, project, of }: { links: ObjectLink[]; id: string; project: Project; of?: string }) {
  const sources = links.filter((link) => link.from.id === id && link.role === 'source');
  if (!sources.length) return null;
  return (
    <ul className="wd-links">
      {sources.map((link) => {
        const to = link.to.type === 'message'
          ? `/projects/${project.id}/conversations/${link.conversationId}#message-${link.to.id}`
          : link.to.type === 'material' ? `/materials/${link.to.id}/versions/${link.to.version}`
            : link.to.type === 'thought' && link.sketchId ? `/projects/${project.id}/map/${link.sketchId}#thought-${link.to.id}` : null;
        const kind = link.to.type === 'message' ? 'Message' : link.to.type === 'thought' ? 'Thought' : `Wiki page v${link.to.type === 'material' ? link.to.version : ''}`;
        return <li key={link.id}>{to ? <RefLink className="wd-link" to={to} state={link.to.type === 'message' ? { keepPanel: true, ...(of ? { sourceOf: of } : {}) } : undefined}><span><b>{kind}:</b> {link.toTitle}</span><Icon name="chevron-right" size={14} /></RefLink> : null}</li>;
      })}
    </ul>
  );
}

/** Wiki pages that include or mention this result or decision (#112), and "Add to a Wiki page" (#763 D6: the view is the Wiki). */
/** Every native role has a reachable destination, including links outside the named sections. */
/** One word per object (CW-7, journeys-and-vocabulary.md). */
const OBJECT_WORD: Record<string, string> = { work: 'Task', decision: 'Decision', doc: 'Wiki page', message: 'Message', material: 'File', thought: 'Thought', sketch: 'Map' };

function OtherRelationships({ object, relations, project }: { object: WorkDetailObject; relations: DetailRelations; project: Project }) {
  const { openDetails } = useShellActions();
  const items = relations.links.flatMap((link) => {
    const outgoing = link.from.type === object.kind && link.from.id === object.id;
    const other = outgoing ? link.to : link.from;
    const title = outgoing ? link.toTitle : link.fromTitle;
    if (!outgoing && other.type === 'doc') return [];
    if (outgoing && link.role === 'source' && ['message', 'material', 'thought'].includes(other.type)) return [];
    // A subtask is listed in its parent's Subtasks (#841); the other way round it is one line, "Part of".
    if (link.role === 'part_of' && !outgoing) return [];
    if (object.kind === 'work' && other.type === 'decision') return [];
    // Thoughts a task is linked to are listed in its own "Linked thoughts" section.
    if (object.kind === 'work' && other.type === 'thought') return [];
    if (object.kind === 'decision' && other.type === 'work' && ['affects'].includes(link.role)) return [];
    const body = <><span>{OBJECT_WORD[other.type] ?? other.type}: {title}</span><small>{link.role.replaceAll('_', ' ')}</small><Icon name="chevron-right" size={14} /></>;
    if (other.type === 'work' || other.type === 'decision') {
      const kind = other.type, id = other.id;
      return [<li key={link.id}><button type="button" className="wd-link" onClick={() => openDetails({ kind, id, projectId: project.id })}>{body}</button></li>];
    }
    const to = other.type === 'message' && link.conversationId ? `/projects/${project.id}/conversations/${link.conversationId}#message-${other.id}`
      : other.type === 'material' ? `/materials/${other.id}/versions/${other.version}`
        : other.type === 'thought' && link.sketchId ? `/projects/${project.id}/map/${link.sketchId}#thought-${other.id}`
          : other.type === 'doc' ? `/projects/${project.id}/docs/${other.id}` : other.type === 'sketch' ? `/projects/${project.id}/map/${other.id}` : null;
    return to ? [<li key={link.id}><RefLink className="wd-link" to={to}>{body}</RefLink></li>] : [];
  });
  return items.length ? <section className="details__sec" aria-label="Also linked"><h4>Also linked</h4><ul className="wd-links">{items}</ul></section> : null;
}

/** "Shown on the Wiki page Sensor network." A sentence only when the object is on a page; the action to add it stays (#871). */
function InDocs({ object, kind, project, relations, notYet }: { object: { id: string; title: string }; relations: DetailRelations; kind?: 'decision'; project: Project; notYet?: string }) {
  const { openDetails } = useShellActions();
  const docs = docsLinking(relations.links, object.id);
  const pages = docs.map((doc, index) => (
    <Fragment key={doc.id}>{index === 0 ? '' : index === docs.length - 1 ? ' and ' : ', '}<RefLink className="wd-inline" to={`/projects/${project.id}/docs/${doc.id}`}>{doc.title}</RefLink></Fragment>
  ));
  const addable = !!kind && !notYet;
  if (!docs.length && !kind) return null;
  return (
    <div className="details__sec wd-docs">
      {docs.length ? <p className="wd-sentence">Shown on the Wiki {docs.length === 1 ? 'page' : 'pages'} {pages}.</p> : null}
      {!docs.length && !relations.complete ? <p className="wd-muted">{emptyLinks(relations, '')}</p> : null}
      {kind && notYet ? <div className="wd-actions wd-actions--hint"><Button variant="secondary" icon="doc" disabled aria-describedby={`wd-docs-hint-${object.id}`}>Add to a Wiki page</Button><small className="wd-muted" id={`wd-docs-hint-${object.id}`}>{notYet}</small></div> : null}
      {addable ? <div className="wd-actions"><Button variant="secondary" icon="doc" onClick={() => openDetails({ kind: 'add-to-doc', projectId: project.id, from: { type: kind, id: object.id, title: object.title }, inDocs: docs.filter((doc) => doc.role === 'source').map((doc) => doc.id), inDocsComplete: relations.complete })}>Add to a Wiki page</Button></div> : null}
    </div>
  );
}

function IdsLine({ children }: { children: ReactNode }) {
  return <p className="wd-ids">{children}</p>;
}

function WorkPanel({ item, context, detail, relations, reload, commands }: { item: OwnWork; context: Context; detail: WorkDetailProjection; relations: DetailRelations; reload: () => void; commands: PanelCommands }) {
  const { openDetails, labelPanel } = useShellActions();
  // A thread opened from here offers "‹ Task #1" back to this task.
  const label = `Task ${taskNumber(item)}`;
  useEffect(() => { labelPanel(label); return () => labelPanel(null); }, [labelPanel, label]);
  // Your own agents (the shell's list, #904): the only agents the Owner field offers.
  const { me, agents: ownAgents } = useShellData();
  // A task whose creation was undone (#238) stays as read-only history: no change, live or new-target control.
  const reverted = item.lifecycle?.state === 'creation_reverted' ? item.lifecycle : null;
  const writable = !reverted;
  const { busy, error } = commands.state;
  const { setBusy, setError, setBlocker, isCurrent } = commands;
  const blocker = commands.state.blocker ?? item.blocker ?? '';
  const [editingBlocker, setEditingBlocker] = useState(false);
  // Closing the blocker's field (Save or Cancel) gives focus back to its Edit, so the keyboard keeps its place.
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editingBlocker) editButton.current?.focus({ preventScroll: true });
    wasEditing.current = editingBlocker;
  }, [editingBlocker]);
  const owners = useAgentOwners(context.project);
  const decisions = linked(relations.links, item.id, 'decision');
  const docs = docsLinking(relations.links, item.id);
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
  // The owner the person chose and has not yet saved: it stays shown, with a retry, when the save is refused or conflicts.
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
        if (field === 'blocker') { setBlocker(undefined); setEditingBlocker(false); }
      } else {
        // Text entered while the answer waited is a new draft after our own
        // stored change. Only that acknowledged version becomes its base.
        base.current = stored.version;
      }
    });
    return ok;
  }
  // The owner is chosen from the menu against the version the person saw when it opened; a change that came in meanwhile is a
  // conflict they are told about, and choosing again saves over the latest version.
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
    const before = { status: item.status, blocker: item.status === 'blocked' ? item.blocker : null, waitingFor: item.status === 'blocked' ? item.waitingFor : null,
      waitingOn: item.status === 'blocked' ? item.waitingOn : null, dropped: item.status === 'done' && item.dropped, cameOfIt: item.status === 'done' ? item.cameOfIt : null };
    if (await change({ status: next })) {
      // The one wink (F-026 §3) on a task closed: the words carry it without the face.
      const mascot = next === 'done' ? 'wink' as const : undefined;
      // A put-back blocker is not said again in the task's conversation (restore).
      // Leaving Done clears "dropped" and its line the same way, and they go back too (#868).
      const restore = before.status === 'blocked' && (before.blocker || before.waitingFor || before.waitingOn)
        ? { status: before.status, ...(before.blocker ? { blocker: before.blocker } : {}), ...(before.waitingFor ? { waitingFor: { kind: 'human' as const, id: before.waitingFor.id } } : {}),
          ...(before.waitingOn ? { waitingOn: { kind: before.waitingOn.kind, id: before.waitingOn.id } } : {}), restore: true as const }
        : before.status === 'done' && (before.dropped || before.cameOfIt)
          ? { status: before.status, ...(before.dropped ? { dropped: true } : {}), ...(before.cameOfIt ? { cameOfIt: before.cameOfIt } : {}), restore: true as const }
          : { status: before.status };
      // Closing says it in the words of the wink (#N done); the other states keep their status label, in the board's words.
      // Z takes it back from the panel too, as on the board (#763 C2).
      toast({ message: stateWords(item, next), timeout: 8000, mascot, action: { label: 'Undo', key: 'Z', onClick: () => { void change(restore, latest.current); } } });
    }
  }
  useStateKeys(writable, (status) => void setState(status));
  const ownerValue = item.owner ? `${item.owner.kind}:${item.owner.id}` : '';
  // The label says "(you)"; the face is drawn from the name alone, never from that label (#763 H11-9: "M(").
  const people = context.spacePeople.length ? context.spacePeople.map((member) => ({ value: `human:${member.userId}`, name: member.name, label: member.userId === me.user.id ? `${member.name} (you)` : member.name }))
    : [{ value: `human:${me.user.id}`, name: me.user.name, label: `${me.user.name} (you)` }];
  if (item.owner && !people.some((person) => person.value === ownerValue) && item.owner.kind === 'human') people.push({ value: ownerValue, name: item.owner.name, label: item.owner.name });
  const waitingPeople = people.map((person) => ({ ...person, id: person.value.slice('human:'.length) }));
  if (item.waitingFor && !waitingPeople.some((person) => person.id === item.waitingFor!.id)) waitingPeople.push({ value: `human:${item.waitingFor.id}`, id: item.waitingFor.id, name: item.waitingFor.name, label: item.waitingFor.name });
  // F-029 (#614): a workspace whose AI is off offers no agent as an owner. #904: only your own agents are offered; a task another
  // person's agent holds keeps showing its name as the current owner, without being a choice.
  const aiOff = useSpaceAi(context.project.id).blocked;
  const agents = aiOff ? [] : ownAgents.map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (agent)` }));
  const ownerOptions = [
    { value: '', label: 'Nobody yet', icon: <Icon name="person" size={16} /> },
    ...people.map(({ name, ...person }) => ({ ...person, group: 'People', icon: <Avatar name={name} id={humanId(person.value)} size="sm" /> })),
    ...agents.map((agent) => ({ ...agent, group: 'Your agents', icon: <Kreska size={16} /> })),
  ];
  const shownOwner = ownerDraft ?? ownerValue;
  const ownerView = shownOwner
    ? (shownOwner.startsWith('agent:')
      ? <AgentIdentity name={(agents.find((agent) => agent.value === shownOwner)?.label ?? item.owner?.name ?? '').replace(/ \(agent\)$/, '')} owner={owners.get(shownOwner.slice('agent:'.length))} icon={16} />
      : <><Avatar name={people.find((person) => person.value === shownOwner)?.name ?? item.owner?.name ?? ''} id={humanId(shownOwner)} size="sm" tone={shownOwner === `human:${me.user.id}` ? 'me' : 'neutral'} /><span>{people.find((person) => person.value === shownOwner)?.label ?? item.owner?.name}</span></>)
    : <><Icon name="person" size={16} /><span className="wd-muted">{ownerDraft === '' ? 'Nobody yet' : 'Assign'}</span></>;
  // What it can wait for (#868): a person, a decision still to make or another task, one thing. The last two are read only while the blocker is edited.
  const choosingWait = editingBlocker && writable;
  const decisionChoices = useWorkChoices(me.user.id, context.project.id, choosingWait ? { purpose: 'choices', choice: 'doc_refs', kind: 'decision' } : null, choosingWait);
  const taskChoices = useWorkChoices(me.user.id, context.project.id, choosingWait ? { purpose: 'choices', choice: 'open_work' } : null, choosingWait);
  const waitingValue = item.waitingFor ? `human:${item.waitingFor.id}` : item.waitingOn ? `${item.waitingOn.kind}:${item.waitingOn.id}` : '';
  const waitOptions = [
    ...(decisionChoices.page?.items ?? []).flatMap((row) => row.kind === 'decision' && row.status === 'proposed' ? [{ value: `decision:${row.id}`, label: row.title, group: 'Decisions to make' }] : []),
    ...(taskChoices.page?.items ?? []).flatMap((row) => row.kind === 'work' && row.id !== item.id ? [{ value: `task:${row.id}`, label: `${taskNumber(row)} ${row.title}`, group: 'Tasks' }] : []),
  ];
  if (item.waitingOn && !waitOptions.some((option) => option.value === waitingValue))
    waitOptions.push({ value: waitingValue, label: item.waitingOn.kind === 'task' ? `${taskNumber(item.waitingOn)} ${item.waitingOn.title}` : item.waitingOn.title, group: item.waitingOn.kind === 'task' ? 'Tasks' : 'Decisions to make' });
  const waitingOptions = [{ value: '', label: 'No one in particular' }, ...waitingPeople.map((person) => ({ value: `human:${person.id}`, label: person.label, group: 'People' })), ...waitOptions];
  const waitingName = item.waitingFor?.name ?? (item.waitingOn ? waitingPhrase(item.waitingOn) : 'No one in particular');
  function chooseWait(value: string) {
    const [kind, ...rest] = value.split(':');
    const id = rest.join(':');
    void change(!value ? { waitingFor: null, waitingOn: null } : kind === 'human' ? { waitingFor: { kind: 'human', id } } : { waitingOn: { kind: kind as 'decision' | 'task', id } });
  }
  // The person a blocked task waits for says they are done, and it goes back to Doing by itself (#868). Reading the space is enough.
  const waitedOnMe = item.status === 'blocked' && item.waitingFor?.id === me.user.id;
  async function waitingDone() {
    if (busy) return;
    setBusy(true); setError('');
    try { await resolveWaiting(item); if (isCurrent()) reload(); }
    catch (cause) { if (isCurrent()) { setError(readable(cause)); if (cause instanceof ApiError && cause.status === 409) reload(); } }
    finally { setBusy(false); }
  }
  const finished = isFinished(item);
  const { toggle: thoughtToggle, links: thoughts } = useThoughtLinks({ item, project: context.project, links: relations.links, reload });
  const composer = useComposerDraft(me.user.id, context.project.id, `task:${item.id}`);
  const activity = useTaskActivity({ item, links: relations.links, project: context.project, members: context.members, me: { id: me.user.id, name: me.user.name }, revision: detail.observedAt });
  const composerId = useId();
  // Empty sections are hidden (#868): a task without a source has no "From" row. While the relationships have more pages
  // than the one shown, the row stays, so paging never adds or takes rows away.
  const cameFrom = relations.links.some((link) => link.from.type === 'work' && link.from.id === item.id && link.role === 'source') || !!item.planIntent || !relations.complete;

  return (
    <div className="details wd wd--task" data-detail-kind="work" data-detail-id={item.id} data-version={item.version}>
      <PanelGlyph><StatusGlyph status={item.status} size={14} /></PanelGlyph>
      <div className="wd__scroll">
        {/* "#4 · Rain barrel monitor" above the title, as drawn (§7 Tasks): the task's number and the space it belongs to (#1364). */}
        <p className="wd__ref"><span className="ui-task-number">{taskNumber(item)}</span><span aria-hidden="true"> · </span><span className="ui-vh">, in </span>{context.project.name}</p>
        <TitleField title={item.title} editable={writable} onEdit={() => { titleBase.current = item.version; }}
          onDraftChange={() => { fieldEdits.current.title++; }} onSave={(title) => saveField('title', title)} />
        {item.outcome ? <p className="details__lead">{item.outcome}</p> : null}

        <dl className="wd-rows">
          <div className="wd-row">
            <dt>Status</dt>
            <dd>{writable ? <StatusControl status={item.status} dropped={item.dropped} disabled={busy} onChoose={(status) => void setState(status)} /> : <span className="wd-value"><StatusGlyph status={item.status} size={16} /><span>{reverted ? 'Creation undone · read-only history' : statusPhrase(item)}</span></span>}</dd>
          </div>
          <div className="wd-row">
            <dt>Owner</dt>
            <dd>{writable
              ? <>
                <PropertyMenu label="Owner" value={shownOwner} options={ownerOptions} disabled={busy} onOpen={() => { ownerBase.current ??= item.version; }}
                  onClose={() => { if (ownerDraft === null) ownerBase.current = null; }} onChoose={(value) => { setOwnerDraft(value); void saveOwner(value); }}>{ownerView}</PropertyMenu>
                {ownerDraft !== null && !busy ? <><span className="wd-muted">Now: {item.owner?.name ?? 'Nobody yet'}</span><Button variant="quiet" size="sm" onClick={() => void saveOwner(ownerDraft)}>Retry owner change</Button></> : null}
              </>
              : <span className="wd-value">{item.owner ? ownerView : 'Nobody yet'}</span>}</dd>
          </div>
          <TaskPeople workId={item.id} revision={`${detail.observedAt}:${activity.lines.length}`} />
          {cameFrom ? <div className="wd-row">
            <dt>From</dt>
            <dd className="wd-from"><CameFrom item={item} links={relations.links} project={context.project} empty={emptyLinks(relations, '')} /></dd>
          </div> : null}
          {writable || item.dueOn ? <div className="wd-row">
            <dt>Due</dt>
            <dd><DueField value={item.dueOn} editable={writable} finished={finished} disabled={busy} onSave={(day) => change({ dueOn: day })} /></dd>
          </div> : null}
        </dl>
        {reverted ? <p className="wd-muted wd-history" data-task-lifecycle="creation_reverted">Creation undone by {reverted.revertedBy.name} on {shortDate(reverted.revertedAt)}. This task stays here as history.</p> : null}

        {item.status === 'blocked' ? (
          <section className="wd-blocker" aria-label="Blocker">
            <div className="wd-blocker__head">
              <span className="ui-pill ui-pill--inv">Blocked</span>
              <p className="wd-blocker__text">
                {item.waitingFor ? <>Waiting for <b>{item.waitingFor.name}</b>{item.blocker ? ` · ${item.blocker}` : ''}</>
                  : item.waitingOn ? <>Waiting for <button type="button" className="wd-inline" onClick={() => openDetails({ kind: item.waitingOn!.kind === 'decision' ? 'decision' : 'work', id: item.waitingOn!.id, projectId: item.projectId }, { back: 'push' })}><b>{item.waitingOn.kind === 'task' ? `${taskNumber(item.waitingOn)} ${item.waitingOn.title}` : waitingPhrase(item.waitingOn)}</b></button>{item.blocker ? ` · ${item.blocker}` : ''}</>
                    : item.blocker || 'Waiting for something; no reason written.'}
              </p>
              {(writable || waitedOnMe) && !editingBlocker ? <div className="wd-blocker__acts">
                {writable ? <Button ref={editButton} variant="quiet" size="sm" disabled={busy} onClick={() => { blockerBase.current ??= item.version; setEditingBlocker(true); }}>Edit</Button> : null}
                {waitedOnMe ? <Button variant="secondary" size="sm" className="wd-blocker__resolve" disabled={busy} onClick={() => void waitingDone()}>Done</Button>
                  : <Button variant="quiet" size="sm" className="wd-blocker__resolve" disabled={busy} onClick={() => void setState('in_progress')}>Resolve</Button>}
              </div> : null}
            </div>
            {writable && editingBlocker ? (
              <form className="wd-blocker-form" onSubmit={(event) => { event.preventDefault(); void saveField('blocker', blocker.trim() || null); }}>
                {/* One field (#1438 point 12): the reason as words, or a person, a decision or a task picked from its list. */}
                <WaitingField choices={waitingOptions.filter((option) => option.value !== '')} choice={waitingValue} choiceLabel={waitingName} text={blocker} pickDisabled={busy} autoFocus maxLength={2000}
                  onChoice={chooseWait} onText={(value) => { fieldEdits.current.blocker++; blockerBase.current ??= item.version; setBlocker(value); }} />
                {commands.state.blocker !== undefined && item.blocker !== blocker ? <p className="wd-muted">Now: {item.blocker || 'No blocker written.'}</p> : null}
                <div className="wd-blocker__form-acts">
                  <Button variant="secondary" size="sm" onClick={() => { blockerBase.current = null; setBlocker(undefined); setEditingBlocker(false); }}>Cancel</Button>
                  <Button type="submit" variant="secondary" size="sm" busy={busy} disabled={blocker.trim() === (item.blocker ?? '')}>Save</Button>
                </div>
              </form>
            ) : null}
          </section>
        ) : null}
        {error ? <p className="wd-error" role="alert">{error}</p> : null}

        {writable ? (
          <div className="wd-acts" role="group" aria-label="Task actions">
            <LinkThoughtButton links={thoughts} toggle={thoughtToggle} />
          </div>
        ) : null}
        {/* At Done, one optional line (#868). It sits below the actions, so no control above it moves when a task is finished (Spokój rule 7). */}
        {finished && !reverted && (writable || item.cameOfIt) ? <dl className="wd-rows wd-rows--after">
          <div className="wd-row">
            <dt>What came of it</dt>
            <dd><CameOfIt line={item.cameOfIt} dropped={item.dropped} editable={writable} disabled={busy} onSaveLine={(line) => change({ cameOfIt: line })} onDropped={(dropped) => void change({ dropped })} /></dd>
          </div>
        </dl> : null}
        <ReadyToClose item={item} writable={writable} busy={busy} done={() => void setState('done')} />
        {!reverted && !finished ? <LiveEntry variant="inline" anchor={liveAnchor} /> : null}
        <LinkedThoughts links={thoughts} />

        {item.creationUndo?.reason === 'eligible' && writable ? <UndoCreation key={`${me.user.id}:${item.id}:${item.version}`} item={item} userId={me.user.id} reload={reload} isCurrent={isCurrent} /> : null}

        {item.criteria.length ? (
          <section className="details__sec" aria-labelledby={`wd-criteria-${item.id}`}>
            <h4 id={`wd-criteria-${item.id}`}>Done when</h4>
            <ul className="wd-checks">{item.criteria.map((criterion) => <li key={criterion}><span className="wd-check" role="img" aria-label="Not checked off" /><span>{criterion}</span></li>)}</ul>
            <p className="wd-muted">Written down by whoever planned it. Flux does not check them off.</p>
          </section>
        ) : null}

        {item.prerequisites.length ? <Prerequisites item={item} openDetails={(view) => openDetails(view, { back: 'push' })} /> : null}
        {item.subtasks?.length ? <Subtasks item={item} openDetails={(view) => openDetails(view, { back: 'push' })} /> : null}

        <TaskPullRequests item={item} project={context.project} writable={writable} reload={reload} />

        <RelationPages relations={relations} />

        {decisions.length ? (
          <section className="details__sec" aria-labelledby="wd-decisions">
            <h4 id="wd-decisions">Decisions</h4>
            <Linked items={decisions.map((entry) => ({ key: entry.link.id, label: entry.title, open: () => openDetails({ kind: 'decision', id: entry.id, projectId: context.project.id }, { back: 'push' }) }))} />
          </section>
        ) : null}
        <OtherRelationships object={item} relations={relations} project={context.project} />
        {docs.length ? <InDocs object={item} project={context.project} relations={relations} /> : null}

        <ActivityTimeline state={activity} composer={composer} item={item} project={context.project} me={{ id: me.user.id, name: me.user.name }} writable={writable} composerId={composerId} />
      </div>
      <div className="wd__foot" data-version={item.version}>
        <TaskComposer state={activity} composer={composer} item={item} meId={me.user.id} writable={writable} readOnly={!!reverted} id={composerId} />
      </div>
    </div>
  );
}

/**
 * The one optional line at Done, "what came of it" (#868), edited where it is read, and whether the task was dropped, not finished.
 * Enter or leaving the field saves, Esc puts the old line back, and the line is also written in the task's discussion once.
 */
function CameOfIt({ line, dropped, editable, disabled, onSaveLine, onDropped }: { line: string | null; dropped: boolean; editable: boolean; disabled?: boolean; onSaveLine: (line: string | null) => Promise<boolean>; onDropped: (dropped: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const tried = useRef<string | null>(null);
  useLayoutEffect(() => { if (editing) field.current?.focus({ preventScroll: true }); }, [editing]);
  const leave = () => { setEditing(false); tried.current = null; requestAnimationFrame(() => opener.current?.focus({ preventScroll: true })); };
  async function save(fromBlur: boolean) {
    const next = draft.trim();
    if (next === (line ?? '')) { leave(); return; }
    // Leaving the field after a failed attempt does not send the same line again by itself.
    if (fromBlur && tried.current === next) return;
    tried.current = next;
    if (await onSaveLine(next || null)) leave();
  }
  if (!editable) return <span className="wd-value">{line}</span>;
  return (
    <div className="wd-came">
      {editing ? (
        <input ref={field} type="text" className="wd-came__field" aria-label="What came of it" maxLength={500} value={draft} placeholder="One line, optional" disabled={disabled}
          onChange={(event) => setDraft(event.target.value.replace(/\n/g, ' '))} onBlur={() => void save(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); void save(false); }
            else if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); leave(); }
          }} />
      ) : (
        <button ref={opener} type="button" className="wd-state wd-came__text" disabled={disabled} aria-label={line ? `What came of it: ${line}. Edit` : 'What came of it, add a line'}
          onClick={() => { setDraft(line ?? ''); setEditing(true); }}><span className={line ? undefined : 'wd-muted'}>{line ?? 'Add a line'}</span></button>
      )}
      <label className="wd-came__dropped"><input type="checkbox" checked={dropped} disabled={disabled} onChange={(event) => onDropped(event.target.checked)} /><span>Dropped, not finished</span></label>
    </div>
  );
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
      <Sources links={links} id={item.id} project={project} of={taskNumber(item)} />
      {item.planIntent ? (
        <p className="wd-plan">Planned from <RefLink className="wd-inline" to={`/materials/${item.planIntent.materialId}/versions/${item.planIntent.version}`}>plan revision {item.planIntent.version}</RefLink>
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
              <small>{STATUS_LABEL[prerequisite.status]}{prerequisite.met ? '' : ' · waiting'}</small>
              <Icon name="chevron-right" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The tasks that are part of this one (#841): how many are done, and who has each. The parent does not wait for them. */
function Subtasks({ item, openDetails }: { item: OwnWork; openDetails: ReturnType<typeof useShellActions>['openDetails'] }) {
  const subtasks = item.subtasks ?? [];
  const done = subtasks.filter((subtask) => subtask.status === 'done').length;
  return (
    <section className="details__sec" aria-labelledby={`wd-subtasks-${item.id}`} data-subtasks="">
      <h4 id={`wd-subtasks-${item.id}`}>Subtasks · {done} of {subtasks.length} done</h4>
      <ul className="wd-links">
        {subtasks.map((subtask) => (
          <li key={subtask.id}>
            <button type="button" className="wd-link" onClick={() => openDetails({ kind: 'work', id: subtask.id, projectId: item.projectId })}>
              <StatusGlyph status={subtask.status} size={14} />
              <span>{subtask.title}</span>
              <small>{STATUS_LABEL[subtask.status]}{subtask.owner ? ` · ${subtask.owner.name}` : ''}</small>
              <Icon name="chevron-right" size={14} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DecisionPanel({ decision, context, detail, relations, reload, revision, commands }: { decision: OwnDecision; context: Context; detail: WorkDetailProjection; relations: DetailRelations; reload: () => void; revision: number; commands: PanelCommands }) {
  const { openDetails } = useShellActions();
  const owners = useAgentOwners(context.project);
  const earlier = decision.supersedes ? detail.context.find((item) => item.id === decision.supersedes) : null;
  const later = decision.supersededBy ? detail.context.find((item) => item.id === decision.supersededBy) : null;
  const affected = linked(relations.links, decision.id, 'work', ['affects']);
  const { me } = useShellData();
  const earlierRead = useNativeOwn(me.user.id, context.project.id, 'decision', earlier?.id, true, revision);
  const earlierObject = earlierRead.value?.object.kind === 'decision' ? earlierRead.value.object : null;
  const { busy, error, attempt } = commands.state;
  const { setBusy, setError, setAttempt, isCurrent } = commands;
  // The panel is the Inbox's decision card first (F-026 P4, S11; #763 D1): the reason, what it rests on,
  // Accept / Not now / Discuss and who else can accept. Not now and the waiting line are the Inbox item's, when it has one.
  const queue = useNeedsYou(me.user.id);
  const handlers = useNeedsYouActions(queue);
  const need = decision.status === 'proposed' ? queue.items?.find((entry) => entry.key === `decision:${decision.id}`) ?? null : null;
  const discuss = useDiscussDecision();
  const sources = relations.links.filter((link) => link.from.id === decision.id && link.role === 'source');

  async function accept(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      await acceptDecision(decision, attempt);
      // The Inbox and Home read their queue again, so the decision leaves them too.
      announceInboxChange();
      if (isCurrent()) reload();
    } catch (cause) {
      if (!isCurrent()) return;
      setError(readable(cause));
      if (cause instanceof ApiError && cause.status === 409) { setAttempt(crypto.randomUUID()); reload(); }
    } finally { setBusy(false); }
  }
  // Plain sentences, drawn only when they apply (#871): the decision this one replaces, and the one that replaced it. A proposed decision
  // whose earlier one is named below does not also say "replaces an earlier decision" in its top line: it is said once (#1058).
  const earlierDay = earlierObject ? ` (${shortDate(earlierObject.decidedAt ?? earlierObject.createdAt)})` : '';

  return (
    <div className="details wd" data-detail-kind="decision" data-detail-id={decision.id}>
      <div className="wd-decision-identity">
        <p className={`details__eyebrow wd-eyebrow${decision.status === 'proposed' ? ' wd-need' : ''}`}><Icon name="flag" size={13} /><Morph value={decision.status}>{earlier ? decisionLine({ ...decision, supersedes: null }) : decisionLine(decision)}</Morph></p>
        <h3 className={`details__title${decision.status === 'superseded' ? ' wd-was' : ''}`}>{decision.title}</h3>
      </div>
      {decision.rationale ? <p className="details__lead">{decision.rationale}</p> : null}
      {sources.length ? (
        <section className="details__sec" aria-labelledby="wd-based">
          <h4 id="wd-based">Based on</h4>
          <Sources links={relations.links} id={decision.id} project={context.project} />
        </section>
      ) : null}
      {decision.status === 'proposed' ? (
        <section className="wd-decide" aria-label="Your answer">
          <div className="nyc__foot wd-decide__foot">
            <div className="nyc__actions">
              <Button variant="primary" busy={busy} onClick={() => void accept()}>Accept</Button>
              {need ? <NotNowButton onClick={() => handlers.snooze(need, 'tomorrow')} /> : null}
              <Button variant="quiet" onClick={() => void discuss(context.project.id, decision.id, relations.complete ? relations.links : undefined)}>Discuss</Button>
            </div>
            {need ? <WaitingLine item={need} /> : null}
          </div>
          {error ? <p className="wd-error" role="alert">{error}</p> : null}
        </section>
      ) : null}
      <dl className="wd-rows wd-decision-rows">
        <div className="wd-row"><dt>Proposed</dt><dd><span>{decision.proposedBy.kind === 'agent' ? <AgentIdentity name={decision.proposedBy.name} owner={owners.get(decision.proposedBy.id)} /> : decision.proposedBy.name} · {shortDate(decision.createdAt)}</span></dd></div>
        {decision.decidedBy ? <div className="wd-row"><dt>Decided</dt><dd><span>{decision.decidedBy.name} · {shortDate(decision.decidedAt!)}</span></dd></div> : null}
      </dl>

      {earlier ? (
        <div className="details__sec wd-replaces">
          <p className="wd-sentence">This replaces the decision <button type="button" className="wd-inline" onClick={() => openDetails({ kind: 'decision', id: earlier.id, projectId: context.project.id })}>{earlier.title}</button>{earlierDay}.</p>
          {earlierObject?.rationale ? <p className="wd-quote">Earlier reason: {earlierObject.rationale}</p> : null}
          {earlierRead.read.phase === 'unavailable' ? <p className="wd-error" role="alert">Earlier reason could not be loaded. <button type="button" className="wd-inline" onClick={reload}>Try again</button></p> : null}
        </div>
      ) : null}
      {later ? (
        <div className="details__sec wd-replaces">
          <p className="wd-sentence">This was replaced by the decision <button type="button" className="wd-inline" onClick={() => openDetails({ kind: 'decision', id: later.id, projectId: context.project.id })}>{later.title}</button>.</p>
        </div>
      ) : null}

      <RelationPages relations={relations} />
      {affected.length ? (
        <section className="details__sec" aria-labelledby="wd-affects">
          <h4 id="wd-affects">Affects</h4>
          <Linked items={affected.map((entry) => ({ key: entry.link.id, label: entry.title, open: () => openDetails({ kind: 'work', id: entry.id, projectId: context.project.id }) }))} />
        </section>
      ) : null}

      <OtherRelationships object={decision} relations={relations} project={context.project} />
      <InDocs object={decision} kind="decision" project={context.project} relations={relations} notYet={decision.status === 'proposed' ? 'Accept it first to add it to the Wiki.' : undefined} />
      <IdsLine>Version {decision.version}</IdsLine>
    </div>
  );
}
