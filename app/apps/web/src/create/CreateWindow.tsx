import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { useWorkspaceAi } from '../ai/workspaceAi';
import { useLocation, useNavigate, useRevalidator } from 'react-router';
import { WORK_LIMITS, WORK_STATUSES, type Agent, type CreateWorkCommand, type ObjectRef, type Project, type WorkItem, type WorkspaceMember, type WorkStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { openDm, sendDmMessage } from '../api/direct-messages';
import { useIntentKeys } from '../api/intent-keys';
import { getProject } from '../api/sketches';
import { noteTitle } from '../app/captures';
import { createPrivateDraft, listWorkspaceMembers } from '../app/conversation-api';
import { useShellData } from '../app/data';
import { readDraft, useDraft, writeDraft } from '../app/drafts';
import { NEW_PROJECT_AUDIENCE, TEMPLATES, useNewProject } from '../app/newProject';
import { AccountChangedError, assertSignedInAs, ensurePersonalSpace } from '../app/personalSpace';
import { useShellActions, type CreateRequest } from '../app/shellContext';
import { searchFlux } from '../search/api';
import { Button, Icon, MEDIA, Overlay, Spinner, StatusGlyph, Tabs, useMediaQuery, useToast, Select, Option, OptionGroup } from '../ui';
import { createWork, listAgents, proposeDecision } from '../work/api';
import { STATUS_LABEL, taskNumber } from '../work/format';
import './create.css';

// The one Create window (F-026 S3, #345, #521): the computer's centred window and the phone's bottom sheet hold the
// same tabs and fields, whether it opens from New / C, Tasks, a message's menu, the Map or ⌘K. Task is the default;
// Thought, Message, Decision and Project are tabs in the same window, and the typed text goes with the person between them.

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A one-line field shows a carried text on one line (its words, not its line breaks) and leaves the text itself as it is. */
const flat = (text: string) => text.replace(/\s*\n\s*/g, ' ');
const oneLine = (text: string) => flat(text).trim();

type Kind = 'task' | 'thought' | 'message' | 'decision' | 'project';
const KINDS: { id: Kind; label: string; name: string }[] = [
  { id: 'task', label: 'Task', name: 'New task' },
  { id: 'thought', label: 'Thought', name: 'New thought' },
  { id: 'message', label: 'Message', name: 'New message' },
  { id: 'decision', label: 'Decision', name: 'New decision' },
  { id: 'project', label: 'Project', name: 'New project' },
];

/** Mounted once by the shell; `request` is what the person asked to create, or null while closed. */
export function CreateHost({ request, onClose }: { request: CreateRequest | null; onClose: () => void }) {
  const phone = useMediaQuery(MEDIA.phone);
  // Each opening starts on Task (F-026 S3); the window is named after the tab it shows, so no heading repeats the tab.
  const [chosen, setChosen] = useState<{ request: CreateRequest | null; kind: Kind }>({ request: null, kind: 'task' });
  const kind = chosen.request === request ? chosen.kind : 'task';
  return (
    <Overlay open={request !== null} onClose={onClose} placement={phone ? 'bottom' : 'center'} label={KINDS.find((item) => item.id === kind)!.name} className="create">
      {request ? <CreateBody request={request} phone={phone} kind={kind} onKind={(next) => setChosen({ request, kind: next })} onClose={onClose} /> : null}
    </Overlay>
  );
}

/** The text the window carries between its tabs, and how a panel says it was used. */
interface Carried {
  text: string;
  set(text: string): void;
  /** Read when a create starts; after it succeeds, `made` clears the kept draft only if it still reads the same. */
  begin(): { text: string; revision: number };
  made(snapshot: { text: string; revision: number }): void;
}

/** A panel's ids and whether its tab is the selected one. */
interface PanelIds { id: string; tab: string; field: string; active: boolean }

function CreateBody({ request, phone, kind, onKind, onClose }: { request: CreateRequest; phone: boolean; kind: Kind; onKind: (kind: Kind) => void; onClose: () => void }) {
  const { me, projects } = useShellData();
  const location = useLocation();
  const here = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const known = (id: string | undefined) => (id && projects.some((project) => project.id === id) ? id : undefined);
  const [projectId, setProjectId] = useState(() => known(request.projectId) ?? known(here) ?? projects[0]?.id ?? '');
  const prefix = useId();
  // One text for every tab: a task's title, a thought, a message, a decision, a project's name (#521). A blank window keeps
  // it as this project's draft on this device, so closing the window or switching tabs never loses it; a window opened
  // with text (a message, ⌘K) holds it for this opening.
  const prefilled = request.title !== undefined || !!request.sources?.length;
  const draft = useDraft(me.user.id, `project-work:${projectId || 'none'}`);
  const [own, setOwn] = useState(request.title || '');
  const carried: Carried = {
    text: prefilled ? own : draft.text,
    set: (text) => { if (prefilled) setOwn(text); else draft.setText(text); },
    begin: () => ({ text: draft.text, revision: draft.revision }),
    made: (snapshot) => { if (!prefilled) draft.clearIfMatches(snapshot.text, snapshot.revision); },
  };
  // The typed text goes with the person to the project the picker shows; that project's own kept draft is never overwritten.
  const changeProject = (id: string) => {
    if (id === projectId) return;
    if (!prefilled && draft.text && !readDraft(me.user.id, `project-work:${id}`).trim()) {
      writeDraft(me.user.id, `project-work:${id}`, draft.text);
      draft.clear();
    }
    setProjectId(id);
  };
  const ids = (id: Kind): PanelIds => ({ id: `${prefix}-${id}`, tab: `${prefix}-tab-${id}`, field: `${prefix}-${id}-field`, active: kind === id });
  // A pointer on a tab goes on to its text, so typing continues there; the arrow keys keep focus on the tabs.
  const pointerOnTab = (event: MouseEvent) => {
    const tab = event.detail > 0 ? (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')?.dataset.tab : undefined;
    if (tab) requestAnimationFrame(() => document.getElementById(`${prefix}-${tab}-field`)?.focus());
  };
  const shared = { phone, carried, projectId, onProject: changeProject, onClose };
  return (
    <div className="create__in">
      <div className="create__head ui-panel__head">
        <div className="create__kinds" onClick={pointerOnTab}>
          <Tabs variant="segmented" className="create__tabs" label="Create" items={KINDS} value={kind} onChange={(id) => onKind(id as Kind)} panelIdPrefix={prefix} />
        </div>
        <button type="button" className="create__x" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <TaskForm {...shared} ids={ids('task')} request={request} prefilled={prefilled} />
      <ThoughtForm {...shared} ids={ids('thought')} />
      <MessageForm {...shared} ids={ids('message')} />
      <DecisionForm {...shared} ids={ids('decision')} />
      <ProjectForm {...shared} ids={ids('project')} />
    </div>
  );
}

/**
 * One tab's panel: where it goes (the same row in every tab), its text and properties, and its foot. ⌘↵ / Ctrl+↵ makes
 * it from anywhere in the panel. A panel stays mounted while another tab shows, so its own fields wait for the person.
 */
function Panel({ ids, where, foot, onSubmit, children }: { ids: PanelIds; where: ReactNode; foot: ReactNode; onSubmit: () => void; children: ReactNode }) {
  return (
    <form className="create__panel" id={ids.id} role="tabpanel" aria-labelledby={ids.tab} hidden={!ids.active}
      onSubmit={(event: FormEvent) => { event.preventDefault(); onSubmit(); }}
      onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); onSubmit(); } }}>
      <div className="create__where">{where}</div>
      <div className="create__scroll">{children}</div>
      <div className="create__foot">{foot}</div>
    </form>
  );
}

/** The panel's one primary action, in the same place in every tab. */
function Go({ label, busy, ready, phone }: { label: string; busy: boolean; ready: boolean; phone: boolean }) {
  return <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!ready} className="create__go">{label}{phone ? null : <kbd aria-hidden="true">{mac ? '⌘↵' : 'Ctrl ↵'}</kbd>}</Button>;
}

/** A field that holds one line: a carried text longer than it allows says so instead of being cut. */
function TooLong({ text, limit }: { text: string; limit: number }) {
  return text.length > limit ? <p className="create__error" role="alert">This is {text.length} characters; shorten it to {limit} to create it here.</p> : null;
}

/** The project's tile and name; a native select over it, so touch and keyboard get the platform's picker. */
function PlacePicker({ projectId, onChange, compact = false, plain = false }: { projectId: string; onChange: (id: string) => void; compact?: boolean; plain?: boolean }) {
  const { projects } = useShellData();
  const current = projects.find((project) => project.id === projectId);
  const label = current ? current.name + (current.workspaceName ? ` · ${current.workspaceName}` : '') : 'Choose a project';
  return (
    <label className={`create__place${plain ? ' create__place--plain' : ''}`}>
      <span className="create__tile" aria-hidden="true">{(current?.name.trim()[0] ?? '?').toUpperCase()}</span>
      <span className="create__place-name">{label}</span>
      {compact ? <Icon name="chevron-down" size={12} /> : null}
      <Select aria-label="Project" value={projectId} onChange={(next) => onChange(next)}>
        {current ? null : <Option value="">Choose a project</Option>}
        {projects.map((project) => <Option key={project.id} value={project.id}>{project.name}{project.workspaceName ? ` · ${project.workspaceName}` : ''}</Option>)}
      </Select>
    </label>
  );
}

/** Where a task, a message or a decision goes: the project picker, shown only in the selected tab, so there is one. */
function ProjectWhere({ ids, projectId, onProject, phone }: { ids: PanelIds; projectId: string; onProject: (id: string) => void; phone: boolean }) {
  const { projects } = useShellData();
  if (!projects.length) return <span>No project yet</span>;
  return ids.active ? <PlacePicker projectId={projectId} onChange={onProject} compact plain={phone} /> : null;
}

/** A chip with a native select over it: shows the chosen option, opens the platform's picker. */
function PickChip({ label, icon, shown, value, onChange, children }: { label: string; icon?: ReactNode; shown: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <div className="create__prop">
      <span className="create__lab" aria-hidden="true">{label}</span>
      <label className="create__chip">{icon}<span>{shown}</span>
        <Select aria-label={label} value={value} onChange={(next) => onChange(next)}>{children}</Select>
      </label>
    </div>
  );
}

interface PanelProps { ids: PanelIds; phone: boolean; carried: Carried; projectId: string; onProject: (id: string) => void; onClose: () => void }

interface SavedForm { title: string; outcome: string; status: WorkStatus; blocker: string; owner: string; waiting?: string; sources: { ref: ObjectRef; label: string }[] }
const sameRefs = (a: ObjectRef[], b: ObjectRef[]) => a.length === b.length && a.every((ref, i) => ref.type === b[i]!.type && ref.id === b[i]!.id);

/**
 * An unresolved command: sent, its response lost, not yet known to have succeeded. Its key is reused by a retry of the same
 * payload, whichever entry point it comes from. A project keeps one list of them, so a create that completes never removes
 * another command's record.
 */
interface Unresolved { payload: string; key: string; form: SavedForm }
const UNRESOLVED_LIMIT = 20;

function isUnresolved(value: unknown): value is Unresolved {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<Unresolved>;
  return typeof record.payload === 'string' && typeof record.key === 'string' && UUID.test(record.key)
    && !!record.form && typeof record.form.title === 'string' && Array.isArray(record.form.sources);
}

/** The project's unresolved commands, oldest first. */
function unresolvedOf(text: string): Unresolved[] {
  try {
    const list: unknown = JSON.parse(text);
    return Array.isArray(list) ? list.filter(isUnresolved) : [];
  } catch { return []; }
}

/** The form of the most recent unresolved command this opening would send (same title; for a message, the same source). */
function savedForm(records: Unresolved[], title: string, sources: ObjectRef[] | null): SavedForm | null {
  const match = [...records].reverse().find(({ form }) => form.title === title && (!sources || sameRefs(form.sources.map((s) => s.ref), sources)));
  return match?.form ?? null;
}

interface Context { project: Project; members: WorkspaceMember[]; agents: Agent[] }
const forbidden = (error: unknown) => (error instanceof ApiError && error.status === 403 ? [] : Promise.reject(error));

function TaskForm({ ids, request, prefilled, phone, carried, projectId, onProject, onClose }: PanelProps & { request: CreateRequest; prefilled: boolean }) {
  const { me, projects } = useShellData();
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const toast = useToast();
  const noteId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  // A task made from a message, thoughts or a typed title starts from that; a blank one keeps its private draft.
  const draft = useDraft(me.user.id, `project-work:${projectId || 'none'}`);
  // An uncertain response can be retried after a reload with the same key.
  const pendingContext = `project-work:${projectId || 'none'}:pending`;
  const pending = useDraft(me.user.id, pendingContext);
  const title = carried.text;
  // Editing the text never drops an unresolved command: only its own successful create resolves it.
  const setTitle = (text: string) => { carried.set(text); setError(''); };
  // An unresolved command (its response was lost) comes back whole: every field it sent, not just the title.
  const [saved] = useState(() => savedForm(unresolvedOf(readDraft(me.user.id, pendingContext)), prefilled ? (request.title || '') : draft.text.trim(), prefilled ? (request.sources ?? []).map((s) => s.ref) : null));
  const [outcome, setOutcome] = useState(saved?.outcome ?? '');
  const [status, setStatus] = useState<WorkStatus>(saved?.status ?? request.status ?? 'open');
  const [blocker, setBlocker] = useState(saved?.blocker ?? '');
  const [ownerPick, setOwnerPick] = useState({ projectId, value: saved?.owner ?? '' });
  // An owner belongs to one project's people: another project starts with none.
  const owner = ownerPick.projectId === projectId ? ownerPick.value : '';
  const setOwner = (value: string) => setOwnerPick({ projectId, value });
  // The one person a blocked task waits for (#550); like an owner, one project's people.
  const [waitingPick, setWaitingPick] = useState({ projectId, value: saved?.waiting ?? '' });
  const waiting = status === 'blocked' && waitingPick.projectId === projectId ? waitingPick.value : '';
  const setWaiting = (value: string) => setWaitingPick({ projectId, value });
  // Sources belong to the project they were picked in: another project (from any tab's picker) starts with none, rather
  // than failing on submit.
  const [sourcesFor, setSourcesFor] = useState(() => ({ projectId, list: saved?.sources ?? request.sources ?? [] }));
  const sources = sourcesFor.projectId === projectId ? sourcesFor.list : [];
  const setSources = (list: { ref: ObjectRef; label: string }[]) => setSourcesFor({ projectId, list });
  const [linkingIn, setLinkingIn] = useState<string | null>(null);
  const linking = linkingIn === projectId;
  const setLinking = (open: boolean) => setLinkingIn(open ? projectId : null);
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set synchronously before the first await, so a second submit in the same tick never sends another command.
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const [context, setContext] = useState<{ projectId: string; value: Context | null } | null>(null);
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { titleRef.current?.focus(); }, []);

  useEffect(() => {
    if (!projectId) return undefined;
    const controller = new AbortController();
    void getProject(projectId, controller.signal).then(async (project) => {
      const [members, agents] = await Promise.all([
        listWorkspaceMembers(project.workspaceId, controller.signal).catch(forbidden),
        listAgents(project.workspaceId, controller.signal).catch(forbidden),
      ]);
      setContext({ projectId, value: { project, members, agents: agents.filter((agent) => !agent.revokedAt) } });
    }).catch(() => { if (!controller.signal.aborted) setContext({ projectId, value: null }); });
    return () => controller.abort();
  }, [projectId]);
  const loaded = context?.projectId === projectId ? context.value : null;
  const viewer = loaded?.project.access === 'viewer';

  const people = useMemo(() => (loaded?.members.length ? loaded.members.map((m) => ({ value: `human:${m.userId}`, label: m.userId === me.user.id ? `${m.name} (you)` : m.name }))
    : [{ value: `human:${me.user.id}`, label: `${me.user.name} (you)` }]), [loaded, me.user.id, me.user.name]);
  // F-029 (#614): no agent owners while the workspace's AI is off.
  const aiOff = useWorkspaceAi(loaded?.project.workspaceId).blocked;
  const agents = (aiOff ? [] : loaded?.agents ?? []).map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (agent)` }));
  const waitingLabel = people.find((o) => o.value === waiting)?.label.replace(/ \((you|agent)\)$/, '') ?? 'No one';
  const ownerLabel = [...people, ...agents].find((o) => o.value === owner)?.label.replace(/ \((you|agent)\)$/, '') ?? 'No owner';

  const text = oneLine(title);
  const needsBlocker = status === 'blocked' && !blocker.trim();
  const ready = !!text && text.length <= WORK_LIMITS.title && !!projectId && !viewer && !needsBlocker;
  const noPlace = !projects.length;

  async function submit() {
    if (!ready || busy || inFlight.current) return;
    inFlight.current = true;
    const command: CreateWorkCommand = {
      title: text,
      ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
      ...(status !== 'open' ? { status } : {}),
      ...(status === 'blocked' ? { blocker: blocker.trim() } : {}),
      ...(waiting ? { waitingFor: { kind: 'human' as const, id: waiting.slice('human:'.length) } } : {}),
      ...(owner && !(aiOff && owner.startsWith('agent:')) ? { owner: { kind: owner.startsWith('agent:') ? 'agent' as const : 'human' as const, id: owner.slice(owner.indexOf(':') + 1) } } : {}),
      ...(sources.length ? { sources: sources.map((s) => s.ref) } : {}),
    };
    const payload = JSON.stringify([projectId, command]);
    const original = draft.text; const revision = draft.revision;
    // Every way in keeps its unresolved command: a lost response is retried with the same identity, whatever the entry point.
    const records = unresolvedOf(readDraft(me.user.id, pendingContext));
    let key = records.find((record) => record.payload === payload)?.key ?? crypto.randomUUID() as string;
    if (attempt.current?.payload === payload) key = attempt.current.key;
    attempt.current = { payload, key };
    const form: SavedForm = { title: text, outcome, status, blocker, owner, waiting, sources };
    const next = [...records.filter((record) => record.payload !== payload), { payload, key, form }].slice(-UNRESOLVED_LIMIT);
    pending.setText(JSON.stringify(next));
    setBusy(true); setError('');
    try {
      const item = await createWork(projectId, command, key);
      attempt.current = null;
      // This command is resolved once its draft is gone from this device; a refused removal keeps its record for a retry.
      // Other unresolved commands of the project stay.
      if (prefilled || draft.clearIfMatches(original, revision) === 'device') {
        const rest = unresolvedOf(readDraft(me.user.id, pendingContext)).filter((record) => record.payload !== payload);
        pending.setText(rest.length ? JSON.stringify(rest) : '');
      }
      request.onCreated?.();
      revalidator.revalidate();
      if (!mounted.current) return;
      if (another) { done(item); return; }
      onClose();
      openDetails({ kind: 'work', id: item.id, projectId });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof ApiError && cause.status === 403 ? 'You can read this project but not add tasks.' : cause instanceof Error ? cause.message : 'Could not create the task.');
    } finally { inFlight.current = false; if (mounted.current) setBusy(false); }
  }
  /** Create another: the next task starts empty in the same project, with the same status and owner. */
  function done(item: WorkItem) {
    toast({ message: `Created ${taskNumber(item)}`, tone: 'success', timeout: 3000 });
    if (prefilled) carried.set('');
    setOutcome(''); setBlocker(''); setSources([]); setLinking(false);
    // The field is disabled while the command runs: focus it once it is enabled again.
    requestAnimationFrame(() => titleRef.current?.focus());
  }
  const where = <ProjectWhere ids={ids} projectId={projectId} onProject={onProject} phone={phone} />;

  if (noPlace) return (
    <Panel ids={ids} where={where} onSubmit={() => undefined} foot={<><p className="create__note">A task belongs to a project</p><Go label="Create task" busy={false} ready={false} phone={phone} /></>}>
      <p className="create__note">There is no project yet. Make one in the Project tab, then add its tasks here.</p>
    </Panel>
  );
  return (
    <Panel ids={ids} where={where} onSubmit={() => void submit()} foot={<>
      <p className="create__note">Goes to Tasks · Conversation gets a one-line note</p>
      <label className="create__another"><input type="checkbox" role="switch" checked={another} onChange={(event) => setAnother(event.target.checked)} /><span className="create__sw" aria-hidden="true" />Create another{phone ? ' after this' : ''}</label>
      <Go label="Create task" busy={busy} ready={ready} phone={phone} />
    </>}>
      <label className="ui-vh" htmlFor={ids.field}>Title</label>
      <input ref={titleRef} id={ids.field} className="create__title" value={flat(title)} maxLength={WORK_LIMITS.title} disabled={busy} placeholder="What needs doing?"
        aria-describedby={!prefilled && (draft.text || draft.storage === 'visit') ? noteId : undefined}
        onChange={(event) => setTitle(event.target.value)} />
      <textarea className="create__details" aria-label="Details" rows={2} value={outcome} maxLength={WORK_LIMITS.outcome} disabled={busy}
        placeholder="Add details or what “done” means…" onChange={(event) => setOutcome(event.target.value)} />
      <div className="create__props">
        <PickChip label="Status" icon={<StatusGlyph status={status} size={14} />} shown={STATUS_LABEL[status]} value={status} onChange={(value) => setStatus(value as WorkStatus)}>
          {WORK_STATUSES.filter((s) => s !== 'not_pursued').map((s) => <Option key={s} value={s}>{STATUS_LABEL[s]}</Option>)}
        </PickChip>
        <PickChip label="Owner" icon={<Icon name="person" size={14} />} shown={ownerLabel} value={owner} onChange={setOwner}>
          <Option value="">No owner</Option>
          <OptionGroup label="People">{people.map((p) => <Option key={p.value} value={p.value}>{p.label}</Option>)}</OptionGroup>
          {agents.length ? <OptionGroup label="Agents" data-ai-surface="create-agent-owners">{agents.map((a) => <Option key={a.value} value={a.value}>{a.label}</Option>)}</OptionGroup> : null}
        </PickChip>
        {status === 'blocked' ? <PickChip label="Waiting for" icon={<Icon name="person" size={14} />} shown={waitingLabel} value={waiting} onChange={setWaiting}>
          <Option value="">No one in particular</Option>
          {people.map((p) => <Option key={p.value} value={p.value}>{p.label}</Option>)}
        </PickChip> : null}
        <div className="create__prop">
          <span className="create__lab" aria-hidden="true">Link</span>
          <div className="create__links">
            {sources.map((source) => (
              <span key={`${source.ref.type}:${source.ref.id}`} className="create__chip create__chip--link">
                <Icon name={source.ref.type === 'message' ? 'chat' : 'map'} size={13} />{/* Focusable (not in the tab order): a tap on the label is not adjusted onto the nearby Remove target. */}
                <span tabIndex={-1}>{source.label}</span>
                <button type="button" aria-label={`Remove link to ${source.label}`} onClick={() => setSources(sources.filter((s) => s !== source))}><Icon name="x" size={12} /></button>
              </span>
            ))}
            <button type="button" className="create__chip create__chip--add" aria-expanded={linking} onClick={() => setLinking(!linking)}>+ Link a message or thought</button>
          </div>
        </div>
      </div>
      {status === 'blocked' ? <label className="create__blocker">What is it waiting for?
        <input className="ui-input" value={blocker} maxLength={WORK_LIMITS.blocker} onChange={(event) => setBlocker(event.target.value)} /></label> : null}
      {linking && projectId ? <LinkPicker projectId={projectId} taken={sources.map((s) => s.ref)} onPick={(ref, label) => { setSources([...sources, { ref, label }]); setLinking(false); }} onDone={() => setLinking(false)} /> : null}
      <TooLong text={text} limit={WORK_LIMITS.title} />
      {viewer ? <p className="create__error" role="alert">You can read this project but not add tasks.</p> : null}
      {error ? <p className="create__error" role="alert">{error}</p> : null}
      {!prefilled && (draft.text || draft.storage === 'visit') ? <p id={noteId} className="create__draft" role="status">
        {draft.storage === 'visit' || (pending.text && pending.storage === 'visit')
          ? draft.text ? 'Draft kept for this visit. Reloading may lose it.' : 'Draft changes are kept for this visit. Reloading may restore older text.'
          : 'Draft kept on this device'}</p> : null}
    </Panel>
  );
}

/**
 * Thought: a private note in Your notes (the Sketchbook, HOME-3), the same as the phone's "+" Thought. It is saved in the
 * person's space: the only one, the one chosen here, or the personal space the first note creates.
 */
function ThoughtForm({ ids, phone, carried, projectId, onClose }: PanelProps) {
  const { me, workspaces, projects } = useShellData();
  const revalidator = useRevalidator();
  const toast = useToast();
  const go = useNavigate();
  const intents = useIntentKeys();
  const [space, setSpace] = useState(() => projects.find((project) => project.id === projectId)?.workspaceId ?? workspaces[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const body = carried.text.trim();
  const ready = !!body && !busy;
  async function submit() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    const snapshot = carried.begin();
    try {
      const target = workspaces.length === 1 ? workspaces[0]!.id : workspaces.length > 1 ? space : await ensurePersonalSpace(me.user.id);
      if (!workspaces.length) revalidator.revalidate();
      if (!target) { setError('Choose a space for this thought in the Sketchbook first.'); return; }
      // One key per text and space (#178): a retry after a lost answer returns the same note.
      const intent = `draft:${target}:${body}`;
      await assertSignedInAs(me.user.id);
      await createPrivateDraft(target, noteTitle(body), body, intents.keyFor(intent));
      intents.settle(intent);
      carried.made(snapshot);
      onClose();
      toast({ message: 'Thought saved to Your notes', tone: 'success', timeout: 4000, action: { label: 'Open', onClick: () => go('/map') } });
    } catch (cause) {
      setError(cause instanceof AccountChangedError ? cause.message : 'Could not save the thought. Your text is still here; try again.');
    } finally { inFlight.current = false; setBusy(false); }
  }
  const spaceName = workspaces.find((item) => item.id === space)?.name ?? 'your space';
  const where = workspaces.length > 1 && ids.active ? (
    <label className="create__chip create__chip--quiet"><Icon name="lock" size={13} /><span>Only you · {spaceName}</span>
      <Select aria-label="Space" value={space} onChange={(next) => setSpace(next)}>
        {workspaces.map((item) => <Option key={item.id} value={item.id}>{item.name}</Option>)}
      </Select>
    </label>
  ) : <span className="create__private"><Icon name="lock" size={13} />Only you</span>;
  return (
    <Panel ids={ids} where={where} onSubmit={() => void submit()} foot={<><p className="create__note">Saved to Your notes in the Sketchbook</p><Go label="Save thought" busy={busy} ready={ready} phone={phone} /></>}>
      <textarea id={ids.field} className="create__text" aria-label="Thought" rows={3} value={carried.text} disabled={busy} placeholder="What’s on your mind?"
        onChange={(event) => { carried.set(event.target.value); setError(''); }} />
      {error ? <p className="create__error" role="alert">{error}</p> : null}
    </Panel>
  );
}

/**
 * Message: a direct message to one person, as the phone's "+" Message and New message start it. Only the two of you can
 * read it, and nobody is chosen until the person picks someone, so a private message never goes anywhere by default.
 * A group starts on the Messages page; a project's conversation has its own composer.
 */
function MessageForm({ ids, phone, carried, onClose }: PanelProps) {
  const { me, workspaces } = useShellData();
  const revalidator = useRevalidator();
  const toast = useToast();
  const go = useNavigate();
  const [people, setPeople] = useState<{ workspaceId: string; members: WorkspaceMember[] }[] | null>(null);
  // A guest cannot list the members of a space (403): their people are none, and the copy says why.
  const [guest, setGuest] = useState(false);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  // A retry reuses its keys: the same conversation opens once and a lost answer never sends the message twice.
  const opening = useRef<{ to: string; key: string } | null>(null);
  const attempt = useRef<{ payload: string; id: string } | null>(null);
  // The people of the person's spaces, read when the tab is first shown.
  useEffect(() => {
    if (!ids.active || people !== null) return undefined;
    const controller = new AbortController();
    void Promise.all(workspaces.map(async (space) => {
      const listed = await listWorkspaceMembers(space.id, controller.signal).then((members) => ({ members, denied: false }), (error: unknown) => {
        if (error instanceof ApiError && error.status === 403) return { members: [], denied: true };
        throw error;
      });
      return { workspaceId: space.id, members: listed.members.filter((member) => member.userId !== me.user.id), denied: listed.denied };
    }))
      .then((lists) => { setGuest(lists.some((list) => list.denied)); setPeople(lists.filter((list) => list.members.length)); })
      .catch(() => { if (!controller.signal.aborted) setPeople([]); });
    return () => controller.abort();
  }, [ids.active, people, workspaces, me.user.id]);
  const [toSpace, toUser] = to ? to.split(':') : [];
  const person = people?.find((list) => list.workspaceId === toSpace)?.members.find((member) => member.userId === toUser);
  const body = carried.text.trim();
  const ready = !!body && !!person && !busy;
  async function submit() {
    if (!ready || !person || !toSpace || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    const snapshot = carried.begin();
    if (opening.current?.to !== to) opening.current = { to, key: crypto.randomUUID() };
    try {
      const dm = await openDm(toSpace, [person.userId], opening.current.key);
      const payload = JSON.stringify([dm.id, body]);
      if (attempt.current?.payload !== payload) attempt.current = { payload, id: crypto.randomUUID() };
      await sendDmMessage(dm.id, { body, clientMessageId: attempt.current.id });
      attempt.current = null;
      carried.made(snapshot);
      revalidator.revalidate();
      onClose();
      toast({ message: `Sent to ${person.name}`, tone: 'success', timeout: 4000, action: { label: 'Open', onClick: () => go(`/dm/${dm.id}`) } });
    } catch (cause) {
      setError(cause instanceof ApiError && (cause.code === 'DM_RECIPIENT_LEFT' || cause.code === 'DM_RECIPIENT_UNAVAILABLE') ? cause.message
        : cause instanceof ApiError && cause.code === 'DM_PARTICIPANT_UNAVAILABLE' ? 'This person is no longer in this space.'
          : cause instanceof ApiError && cause.status === 403 ? 'You can’t start conversations in this space.' : 'Could not send the message. Your text is still here; try again.');
    } finally { inFlight.current = false; setBusy(false); }
  }
  const spaceName = (id: string) => workspaces.find((space) => space.id === id)?.name ?? 'Space';
  const where = people === null ? <span>{ids.active ? 'Loading people…' : null}</span> : !people.length ? <span>{guest ? 'Guests can reply in conversations they are added to, but cannot start one.' : 'Nobody else is in your spaces yet'}</span> : (
    <label className="create__chip create__chip--quiet"><Icon name="person" size={13} /><span>{person ? `To ${person.name}` : 'Choose a person'}</span><Icon name="chevron-down" size={12} />
      <Select aria-label="To" value={to} onChange={(next) => { setTo(next); setError(''); }}>
        <Option value="">Choose a person</Option>
        {people.map((list) => {
          const options = list.members.map((member) => <Option key={member.userId} value={`${list.workspaceId}:${member.userId}`}>{member.name}</Option>);
          return people.length > 1 ? <OptionGroup key={list.workspaceId} label={spaceName(list.workspaceId)}>{options}</OptionGroup> : options;
        })}
      </Select>
    </label>
  );
  return (
    <Panel ids={ids} where={where} onSubmit={() => void submit()}
      foot={<><p className="create__note">{person ? `Only you and ${person.name} can read it` : 'A direct message: only the two of you can read it'}</p><Go label="Send message" busy={busy} ready={ready} phone={phone} /></>}>
      <textarea id={ids.field} className="create__text" aria-label="Message" rows={3} value={carried.text} maxLength={100_000} disabled={busy} placeholder="Write a message…"
        onChange={(event) => { carried.set(event.target.value); setError(''); }} />
      {error ? <p className="create__error" role="alert">{error}</p> : null}
    </Panel>
  );
}

/** Decision: a proposal in the chosen project, as the composer's /decide makes it; it opens in Details once made. */
function DecisionForm({ ids, phone, carried, projectId, onProject, onClose }: PanelProps) {
  const { projects } = useShellData();
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ payload: string; key: string } | null>(null);
  const project = projects.find((item) => item.id === projectId);
  const title = oneLine(carried.text);
  const ready = !!title && title.length <= WORK_LIMITS.title && !!project && !busy;
  async function submit() {
    if (!ready || !project || inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    const snapshot = carried.begin();
    const command = { title, ...(why.trim() ? { rationale: why.trim() } : {}) };
    const payload = JSON.stringify([project.id, command]);
    if (attempt.current?.payload !== payload) attempt.current = { payload, key: crypto.randomUUID() };
    try {
      const decision = await proposeDecision(project.id, command, attempt.current.key);
      attempt.current = null;
      carried.made(snapshot);
      revalidator.revalidate();
      onClose();
      openDetails({ kind: 'decision', id: decision.id, projectId: project.id });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status === 403 ? 'You can read this project but not propose decisions.' : 'Could not propose the decision. Your text is still here; try again.');
    } finally { inFlight.current = false; setBusy(false); }
  }
  return (
    <Panel ids={ids} where={<ProjectWhere ids={ids} projectId={projectId} onProject={onProject} phone={phone} />} onSubmit={() => void submit()}
      foot={<><p className="create__note">{project ? 'A person with write access accepts it' : 'A decision belongs to a project'}</p><Go label="Propose decision" busy={busy} ready={ready} phone={phone} /></>}>
      {project ? <>
        <input id={ids.field} className="create__name" aria-label="Decision" value={flat(carried.text)} maxLength={WORK_LIMITS.title} disabled={busy} placeholder="What is being decided?"
          onChange={(event) => { carried.set(event.target.value); setError(''); }} />
        <textarea className="create__details" aria-label="Why" rows={2} value={why} maxLength={WORK_LIMITS.rationale} disabled={busy} placeholder="Why this is the right call (optional)"
          onChange={(event) => { setWhy(event.target.value); setError(''); }} />
        <TooLong text={title} limit={WORK_LIMITS.title} />
        {error ? <p className="create__error" role="alert">{error}</p> : null}
      </> : <p className="create__note">There is no project yet. Make one in the Project tab, then propose its decisions here.</p>}
    </Panel>
  );
}

/** Project: a name and a template in one step (S20), the same as New project; people and agents come later. */
function ProjectForm({ ids, phone, carried, onClose }: PanelProps) {
  const go = useNavigate();
  const { space, spaceName, setSpaceName, template, setTemplate, busy, error, ready, create } = useNewProject();
  const aiOff = useWorkspaceAi(space?.id).blocked;
  const name = oneLine(carried.text);
  const chosen = TEMPLATES.find((item) => item.id === template) ?? TEMPLATES[0]!;
  const canCreate = ready(name) && name.length <= WORK_LIMITS.title && !busy;
  async function submit() {
    if (!canCreate) return;
    const snapshot = carried.begin();
    const project = await create(name);
    if (!project) return;
    carried.made(snapshot);
    onClose();
    // A new project is restricted; its "Who can see this" opens next, to add people (#188).
    go(`/projects/${project.id}?new=1&open=people`);
  }
  // The first project also names the person's space.
  const where = space ? <span>In {space.name}</span>
    : <input className="create__space" aria-label="Your space" value={spaceName} maxLength={200} disabled={busy} placeholder="Name your space first" onChange={(event) => setSpaceName(event.target.value)} />;
  return (
    <Panel ids={ids} where={where} onSubmit={() => void submit()} foot={<><p className="create__note">Starts with {chosen.has} · invite people {aiOff ? '' : 'and agents '}later</p><Go label="Create project" busy={busy} ready={canCreate} phone={phone} /></>}>
      <input id={ids.field} className="create__name" aria-label="What is it about?" value={flat(carried.text)} maxLength={WORK_LIMITS.title} disabled={busy} placeholder="What is it about?"
        onChange={(event) => carried.set(event.target.value)} />
      <div className="create__props">
        <PickChip label="Start from" icon={<Icon name="board" size={14} />} shown={chosen.name} value={template} onChange={(value) => setTemplate(value as typeof template)}>
          {TEMPLATES.map((item) => <Option key={item.id} value={item.id}>{item.name} · {item.has}</Option>)}
        </PickChip>
      </div>
      <p className="create__note">{NEW_PROJECT_AUDIENCE}</p>
      <TooLong text={name} limit={WORK_LIMITS.title} />
      {error ? <p className="create__error" role="alert">{error}</p> : null}
    </Panel>
  );
}

/** Finds a message or a thought of this project with the same search as ⌘K, and links it as the task's source. */
function LinkPicker({ projectId, taken, onPick, onDone }: { projectId: string; taken: ObjectRef[]; onPick: (ref: ObjectRef, label: string) => void; onDone: () => void }) {
  const [query, setQuery] = useState('');
  type Found = { ref: ObjectRef; label: string; kind: string };
  const [answer, setAnswer] = useState<{ key: string; items: Found[] | null } | null>(null);
  const listId = useId();
  const text = query.trim();
  const key = `${projectId}:${text}`;
  useEffect(() => {
    if (!text) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchFlux({ q: text, place: `project:${projectId}`, limit: 12 }, controller.signal).then((response) => {
        const found: Found[] = [];
        for (const result of response.items) {
          const label = result.title.map((part) => part.text).join('');
          if (result.target.type === 'message') found.push({ ref: { type: 'message', id: result.target.messageId }, label, kind: 'Message' });
          else if (result.target.type === 'thought') found.push({ ref: { type: 'thought', id: result.target.thoughtId }, label, kind: 'Thought' });
        }
        setAnswer({ key, items: found });
      }).catch(() => { if (!controller.signal.aborted) setAnswer({ key, items: null }); });
    }, 140);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [text, projectId, key]);
  const current = text && answer?.key === key ? answer : null;
  const state = !text ? 'idle' : !current ? 'loading' : current.items ? 'ready' : 'failed';
  // A link that was just taken no longer needs offering.
  const items = (current?.items ?? []).filter((f) => !taken.some((t) => t.type === f.ref.type && t.id === f.ref.id));
  return (
    <div className="create__picker">
      <input className="ui-input" type="search" autoFocus aria-label="Search messages and thoughts" aria-controls={listId} placeholder="Search this project’s messages and thoughts" value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.stopPropagation(); onDone(); }
          else if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); const first = items[0]; if (first) onPick(first.ref, first.label); }
        }} />
      {state === 'loading' ? <Spinner /> : null}
      <ul id={listId} className="create__results" aria-label="Messages and thoughts">
        {text && state !== 'loading' ? items.map((item) => (
          <li key={`${item.ref.type}:${item.ref.id}`}><button type="button" onClick={() => onPick(item.ref, item.label)}><small>{item.kind}</small><span>{item.label}</span></button></li>
        )) : null}
      </ul>
      {text && state === 'ready' && !items.length ? <p className="create__note" role="status">No message or thought matches.</p> : null}
      {state === 'failed' ? <p className="create__error" role="alert">Search is unavailable right now.</p> : null}
    </div>
  );
}
