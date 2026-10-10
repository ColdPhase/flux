import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useRevalidator } from 'react-router';
import { WORK_LIMITS, WORK_STATUSES, type Agent, type CreateWorkCommand, type ObjectRef, type Project, type WorkItem, type WorkspaceMember, type WorkStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { getProject } from '../api/sketches';
import { readDraft, useDraft } from '../app/drafts';
import { listWorkspaceMembers } from '../app/conversation-api';
import { useShellData } from '../app/data';
import { useShellActions, type CreateRequest } from '../app/shellContext';
import { startCapture } from '../app/views';
import { searchFlux } from '../search/api';
import { Button, Icon, MEDIA, Overlay, Spinner, StatusGlyph, useMediaQuery, useToast, type IconName } from '../ui';
import { createWork, listAgents } from '../work/api';
import { STATUS_LABEL, taskNumber } from '../work/format';
import './create.css';

// The one Create window (F-026 S3, #345): the computer's centred window and the phone's bottom sheet hold the
// same fields, whether it opens from New / C, Tasks, a message's menu, the Map or ⌘K.

const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mounted once by the shell; `request` is what the person asked to create, or null while closed. */
export function CreateHost({ request, onClose }: { request: CreateRequest | null; onClose: () => void }) {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <Overlay open={request !== null} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Create" className="create">
      {request ? <CreateBody request={request} phone={phone} onClose={onClose} /> : null}
    </Overlay>
  );
}

function CreateBody({ request, phone, onClose }: { request: CreateRequest; phone: boolean; onClose: () => void }) {
  const [typed, setTyped] = useState<string | null>(null);
  // On the phone "+" first asks what to create; every other way in already knows it is a task.
  const choosing = phone && !request.kind && !request.title && !request.sources?.length && typed === null;
  const { projects } = useShellData();
  const location = useLocation();
  const here = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const known = (id: string | undefined) => (id && projects.some((project) => project.id === id) ? id : undefined);
  const [projectId, setProjectId] = useState(() => known(request.projectId) ?? known(here) ?? projects[0]?.id ?? '');
  if (choosing) return <ChooseStep projectId={projectId} onProject={setProjectId} onTask={(text) => setTyped(text)} onClose={onClose} />;
  return <TaskForm request={request} typed={typed} phone={phone} projectId={projectId} onProject={setProjectId} onClose={onClose} />;
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
      <select aria-label="Project" value={projectId} onChange={(event) => onChange(event.target.value)}>
        {current ? null : <option value="">Choose a project</option>}
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}{project.workspaceName ? ` · ${project.workspaceName}` : ''}</option>)}
      </select>
    </label>
  );
}

function ChooseStep({ projectId, onProject, onTask, onClose }: { projectId: string; onProject: (id: string) => void; onTask: (text: string) => void; onClose: () => void }) {
  const go = useNavigate();
  const { openDetails } = useShellActions();
  const [text, setText] = useState('');
  const after = (run: () => void) => { onClose(); requestAnimationFrame(run); };
  const tiles: { label: string; icon: IconName; run: () => void; off?: boolean }[] = [
    { label: 'Task', icon: 'tasks', run: () => onTask(text) },
    { label: 'Thought', icon: 'map', off: !projectId, run: () => after(() => go(`/projects/${projectId}/map`)) },
    { label: 'Message', icon: 'chat', run: () => after(() => go('/dm/new')) },
    { label: 'Decision', icon: 'rule', off: !projectId, run: () => after(() => openDetails({ kind: 'propose-decision', projectId })) },
    { label: 'Project', icon: 'plus', run: () => after(() => go('/projects/new')) },
    { label: 'Private note', icon: 'lock', run: () => after(() => startCapture(go)) },
  ];
  return (
    <div className="create__in">
      <div className="create__head ui-panel__head">
        <h2 className="create__h">Create</h2>
        <PlacePicker projectId={projectId} onChange={onProject} compact />
        <button type="button" className="create__x" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="create__scroll">
        <div className="create__tiles" role="group" aria-label="What to create">
          {tiles.map((tile) => (
            <button key={tile.label} type="button" className="create__tilebtn" aria-disabled={tile.off || undefined} onClick={() => { if (!tile.off) tile.run(); }}>
              <Icon name={tile.icon} size={22} /><span>{tile.label}</span>
            </button>
          ))}
        </div>
        <label className="create__just">Or just type
          <input className="ui-input" value={text} maxLength={WORK_LIMITS.title} placeholder="“Print labels for the beds” → task" onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing && text.trim()) { event.preventDefault(); onTask(text); } }} />
        </label>
      </div>
    </div>
  );
}

/** A chip with a native select over it: shows the chosen option, opens the platform's picker. */
function PickChip({ label, icon, shown, value, onChange, children }: { label: string; icon?: ReactNode; shown: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <div className="create__prop">
      <span className="create__lab" aria-hidden="true">{label}</span>
      <label className="create__chip">{icon}<span>{shown}</span>
        <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>{children}</select>
      </label>
    </div>
  );
}

interface SavedForm { title: string; outcome: string; status: WorkStatus; blocker: string; owner: string; sources: { ref: ObjectRef; label: string }[] }
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

function TaskForm({ request, typed, phone, projectId, onProject, onClose }: { request: CreateRequest; typed: string | null; phone: boolean; projectId: string; onProject: (id: string) => void; onClose: () => void }) {
  const { me, projects } = useShellData();
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const toast = useToast();
  const go = useNavigate();
  const titleId = useId();
  const noteId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  // A task made from a message, thoughts or a typed title starts from that; a blank one keeps its private draft.
  const prefilled = request.title !== undefined || !!request.sources?.length || !!typed;
  const draft = useDraft(me.user.id, `project-work:${projectId || 'none'}`);
  // An uncertain response can be retried after a reload with the same key.
  const pendingContext = `project-work:${projectId || 'none'}:pending`;
  const pending = useDraft(me.user.id, pendingContext);
  const [own, setOwn] = useState(typed || request.title || '');
  const title = prefilled ? own : draft.text;
  // Editing the text never drops an unresolved command: only its own successful create resolves it.
  const setTitle = (text: string) => { if (prefilled) setOwn(text); else draft.setText(text); setError(''); };
  // An unresolved command (its response was lost) comes back whole: every field it sent, not just the title.
  const [saved] = useState(() => savedForm(unresolvedOf(readDraft(me.user.id, pendingContext)), prefilled ? (typed || request.title || '') : draft.text.trim(), prefilled ? (request.sources ?? []).map((s) => s.ref) : null));
  const [outcome, setOutcome] = useState(saved?.outcome ?? '');
  const [status, setStatus] = useState<WorkStatus>(saved?.status ?? request.status ?? 'open');
  const [blocker, setBlocker] = useState(saved?.blocker ?? '');
  const [ownerPick, setOwnerPick] = useState({ projectId, value: saved?.owner ?? '' });
  // An owner belongs to one project's people: another project starts with none.
  const owner = ownerPick.projectId === projectId ? ownerPick.value : '';
  const setOwner = (value: string) => setOwnerPick({ projectId, value });
  const [sources, setSources] = useState(saved?.sources ?? request.sources ?? []);
  const [linking, setLinking] = useState(false);
  const [another, setAnother] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const agents = (loaded?.agents ?? []).map((agent) => ({ value: `agent:${agent.id}`, label: `${agent.name} (agent)` }));
  const ownerLabel = [...people, ...agents].find((o) => o.value === owner)?.label.replace(/ \((you|agent)\)$/, '') ?? 'No owner';

  const text = title.trim();
  const needsBlocker = status === 'blocked' && !blocker.trim();
  const ready = !!text && !!projectId && !viewer && !needsBlocker;
  const noPlace = !projects.length;

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!ready || busy) return;
    const command: CreateWorkCommand = {
      title: text,
      ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
      ...(status !== 'open' ? { status } : {}),
      ...(status === 'blocked' ? { blocker: blocker.trim() } : {}),
      ...(owner ? { owner: { kind: owner.startsWith('agent:') ? 'agent' as const : 'human' as const, id: owner.slice(owner.indexOf(':') + 1) } } : {}),
      ...(sources.length ? { sources: sources.map((s) => s.ref) } : {}),
    };
    const payload = JSON.stringify([projectId, command]);
    const original = draft.text; const revision = draft.revision;
    // Every way in keeps its unresolved command: a lost response is retried with the same identity, whatever the entry point.
    const records = unresolvedOf(readDraft(me.user.id, pendingContext));
    let key = records.find((record) => record.payload === payload)?.key ?? crypto.randomUUID() as string;
    if (attempt.current?.payload === payload) key = attempt.current.key;
    attempt.current = { payload, key };
    const form: SavedForm = { title: text, outcome, status, blocker, owner, sources };
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
      revalidator.revalidate();
      if (!mounted.current) return;
      if (another) { done(item); return; }
      onClose();
      openDetails({ kind: 'work', id: item.id, projectId });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof ApiError && cause.status === 403 ? 'You can read this project but not add tasks.' : cause instanceof Error ? cause.message : 'Could not create the task.');
    } finally { if (mounted.current) setBusy(false); }
  }
  /** Create another: the next task starts empty in the same project, with the same status and owner. */
  function done(item: WorkItem) {
    toast({ message: `Created ${taskNumber(item)}`, tone: 'success', timeout: 3000 });
    if (prefilled) setOwn('');
    setOutcome(''); setBlocker(''); setSources([]); setLinking(false);
    // The field is disabled while the command runs: focus it once it is enabled again.
    requestAnimationFrame(() => titleRef.current?.focus());
  }
  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); }
  };
  const elsewhere = (run: () => void) => { onClose(); requestAnimationFrame(run); };

  if (noPlace) return (
    <div className="create__in">
      <div className="create__head ui-panel__head"><h2 className="create__h">New task</h2><button type="button" className="create__x" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button></div>
      <div className="create__scroll">
        <p className="create__note">A task belongs to a project. Create a project first.</p>
        <OtherCreates onProject={() => elsewhere(() => go('/projects/new'))} onMessage={() => elsewhere(() => go('/dm/new'))} onNote={() => elsewhere(() => startCapture(go))} />
      </div>
    </div>
  );
  return (
    <form className="create__in" onSubmit={(event) => void submit(event)} onKeyDown={onKeyDown}>
      <div className="create__head ui-panel__head">
        {phone ? <div className="create__ptitle"><h2 className="create__h">New task</h2><PlacePicker projectId={projectId} onChange={onProject} compact plain /></div> : <>
          <PlacePicker projectId={projectId} onChange={onProject} compact />
          <Icon name="chevron-right" size={12} className="create__sep" />
          <h2 className="create__h">New task</h2><kbd aria-hidden="true">C</kbd>
        </>}
        <button type="button" className="create__x" aria-label="Close" onClick={onClose}><Icon name="x" size={18} /></button>
      </div>
      <div className="create__scroll">
        <label className="ui-vh" htmlFor={titleId}>Title</label>
        <input ref={titleRef} id={titleId} className="create__title" value={title} maxLength={WORK_LIMITS.title} disabled={busy} placeholder="What needs doing?"
          aria-describedby={!prefilled && (draft.text || draft.storage === 'visit') ? noteId : undefined}
          onChange={(event) => setTitle(event.target.value)} />
        <textarea className="create__details" aria-label="Details" rows={2} value={outcome} maxLength={WORK_LIMITS.outcome} disabled={busy}
          placeholder="Add details or what “done” means…" onChange={(event) => setOutcome(event.target.value)} />
        <div className="create__props">
          <PickChip label="Status" icon={<StatusGlyph status={status} size={14} />} shown={STATUS_LABEL[status]} value={status} onChange={(value) => setStatus(value as WorkStatus)}>
            {WORK_STATUSES.filter((s) => s !== 'not_pursued').map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
          </PickChip>
          <PickChip label="Owner" icon={<Icon name="person" size={14} />} shown={ownerLabel} value={owner} onChange={setOwner}>
            <option value="">No owner</option>
            <optgroup label="People">{people.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}</optgroup>
            {agents.length ? <optgroup label="Agents">{agents.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}</optgroup> : null}
          </PickChip>
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
              <button type="button" className="create__chip create__chip--add" aria-expanded={linking} onClick={() => setLinking((open) => !open)}>+ Link a message or thought</button>
            </div>
          </div>
        </div>
        {status === 'blocked' ? <label className="create__blocker">What is it waiting for?
          <input className="ui-input" value={blocker} maxLength={WORK_LIMITS.blocker} onChange={(event) => setBlocker(event.target.value)} /></label> : null}
        {linking && projectId ? <LinkPicker projectId={projectId} taken={sources.map((s) => s.ref)} onPick={(ref, label) => { setSources([...sources, { ref, label }]); setLinking(false); }} onDone={() => setLinking(false)} /> : null}
        {viewer ? <p className="create__error" role="alert">You can read this project but not add tasks.</p> : null}
        {error ? <p className="create__error" role="alert">{error}</p> : null}
        {!prefilled && (draft.text || draft.storage === 'visit') ? <p id={noteId} className="create__draft" role="status">
          {draft.storage === 'visit' || (pending.text && pending.storage === 'visit')
            ? draft.text ? 'Draft kept for this visit. Reloading may lose it.' : 'Draft changes are kept for this visit. Reloading may restore older text.'
            : 'Draft kept on this device'}</p> : null}
        {!phone ? <OtherCreates onProject={() => elsewhere(() => go('/projects/new'))} onMessage={() => elsewhere(() => go('/dm/new'))} onNote={() => elsewhere(() => startCapture(go))} /> : null}
      </div>
      <div className="create__foot">
        <p className="create__note">Goes to Tasks · Conversation gets a one-line note</p>
        <label className="create__another"><input type="checkbox" role="switch" checked={another} onChange={(event) => setAnother(event.target.checked)} /><span className="create__sw" aria-hidden="true" />Create another{phone ? ' after this' : ''}</label>
        <Button type="submit" variant="primary" size="lg" busy={busy} disabled={!ready} className="create__go">Create task{phone ? null : <kbd aria-hidden="true">{mac ? '⌘↵' : 'Ctrl ↵'}</kbd>}</Button>
      </div>
      {phone ? <OtherCreates onProject={() => elsewhere(() => go('/projects/new'))} onMessage={() => elsewhere(() => go('/dm/new'))} onNote={() => elsewhere(() => startCapture(go))} /> : null}
    </form>
  );
}

/** Project, Message and Private note stay one step away from the same window (the New menu's other entries). */
function OtherCreates({ onProject, onMessage, onNote }: { onProject: () => void; onMessage: () => void; onNote: () => void }) {
  return (
    <div className="create__other" role="group" aria-label="Create something else">
      <span>Or create</span>
      <button type="button" onClick={onProject}>Project</button>
      <button type="button" onClick={onMessage}>Message</button>
      <button type="button" onClick={onNote}>Private note</button>
    </div>
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
