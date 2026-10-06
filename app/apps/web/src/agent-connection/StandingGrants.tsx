import { useId, useRef, useState, type FormEvent } from 'react';
import { AGENT_OPERATION_CLASSES, type AgentConnection, type AgentOperation, type AgentPeerRequestClass, type AgentStandingGrant, type Project } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { Button } from '../ui';
import { createActionGrant, listActionGrants, narrowActionGrant, revokeActionGrant } from './api';

/**
 * The owner's standing grants for one personal connection (#152, CO-1): what the agent may change in each
 * selected project, how many times and until when. Grants can be added, narrowed (fewer uses, earlier end) and
 * revoked here; the agent's next call is checked against the saved grant. Only the connection's owner sees this.
 */

const CLASS_LABEL: Record<AgentPeerRequestClass, string> = { execute: 'Doing the work', plan: 'Planning', review: 'Reviewing' };

/**
 * What an owner can grant here: every native change with a Flux MCP tool. Co-work operations (claims, requests,
 * units) are granted with their units through the API and only listed here, so later operations need no change.
 */
const GRANTABLE: { area: string; operations: [AgentOperation, string][] }[] = [
  { area: 'Tasks', operations: [['work.create', 'Create tasks'], ['work.update', 'Change tasks']] },
  { area: 'Results and decisions', operations: [['result.record', 'Record results'], ['decision.propose', 'Propose decisions']] },
  { area: 'Maps', operations: [['map.create', 'Create maps'], ['map.rename', 'Rename maps'], ['map.thought.create', 'Add thoughts'],
    ['map.thought.update', 'Edit thoughts'], ['map.thought.delete', 'Remove thoughts'], ['map.positions.update', 'Arrange thoughts'],
    ['map.link.create', 'Link thoughts'], ['map.link.delete', 'Unlink thoughts']] },
  { area: 'Wiki', operations: [['doc.create', 'Start docs'], ['doc.update', 'Edit docs']] },
  { area: 'Conversations', operations: [['conversation.create', 'Start conversations'], ['conversation.reply', 'Reply in conversations']] },
];
const LABELS: Partial<Record<AgentOperation, string>> = {
  ...Object.fromEntries(GRANTABLE.flatMap((group) => group.operations)),
  'cowork.claim': 'Take tasks (co-work)', 'cowork.renew': 'Keep a task (co-work)', 'cowork.release': 'Release tasks (co-work)',
  'cowork.request': 'Ask other agents (co-work)',
};
/** An operation added later (for example by co-work) still reads as itself until it has a label. */
const operationLabel = (operation: AgentOperation) => LABELS[operation] ?? operation;
const CLASSES: AgentPeerRequestClass[] = ['execute', 'plan'];

const HOUR = 3_600_000;
/** The server allows at most 30 days, by its own clock; the longest choice keeps a small margin for clock skew. */
const ENDS = [
  { id: '1d', label: 'In 1 day', ms: 24 * HOUR },
  { id: '7d', label: 'In 7 days', ms: 7 * 24 * HOUR },
  { id: '30d', label: 'In 30 days (the longest)', ms: 30 * 24 * HOUR - 10 * 60_000 },
] as const;
const EARLIER = [{ id: '1h', label: 'In 1 hour', ms: HOUR }, ...ENDS.slice(0, 2)] as const;

const dayTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const when = (iso: string) => dayTime.format(new Date(iso));

type State = 'active' | 'used_up' | 'expired' | 'revoked';
/** The list is history too; whether a grant still works is decided by its saved limits and the time now. */
function stateOf(grant: AgentStandingGrant, now: number): State {
  if (grant.revokedAt) return 'revoked';
  if (Date.parse(grant.expiresAt) <= now) return 'expired';
  return grant.used >= grant.maximumUses ? 'used_up' : 'active';
}

function describe(error: unknown) {
  if (error instanceof NetworkError) return 'Flux cannot be reached. Check your connection and try again.';
  if (error instanceof ApiError) {
    if (error.status === 401) return 'Your session ended. Sign in again to change grants.';
    if (error.code === 'GRANT_NOT_FOUND') return 'This grant has already ended. The list now shows its current state.';
    if (error.code === 'GRANT_NOT_NARROWER') return 'A grant can only get smaller: fewer uses than it has left, or an earlier end.';
    if (error.code === 'GRANT_EXPIRY_INVALID') return 'Choose an end within the next 30 days.';
    if (error.status === 403) return 'Only a manager of this project can add grants here.';
    if (error.status === 404) return 'This connection or project is no longer available to you.';
  }
  return 'Something went wrong. Try again.';
}

interface Props {
  connection: AgentConnection;
  projects: Map<string, Project>;
  /** Null when the grants could not be read. */
  initial: AgentStandingGrant[] | null;
}

export function StandingGrants({ connection, projects, initial }: Props) {
  const id = useId();
  const [grants, setGrants] = useState<AgentStandingGrant[] | null>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  // Whether a grant is current depends on the time; it is read again after every change the owner makes.
  const [now, setNow] = useState(() => Date.now());
  const canAct = connection.scopes.includes('flux.action.execute');
  const name = (projectId: string) => projects.get(projectId)?.name ?? `Project ${projectId.slice(0, 8)}`;

  if (!canAct) {
    return <section className="grants" aria-label={`Standing grants for ${connection.name}`}>
      <h2 className="grants__title">Standing grants <span className="grants__for">for {connection.name}</span></h2>
      <p className="grants__note">This connection can read and suggest only. To let your agent make changes, save a new selection with “Run approved project actions”.</p>
    </section>;
  }

  async function refresh() {
    try { setGrants(await listActionGrants(connection.id)); } catch { /* keep what is shown; the error says why */ }
  }
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await action(); return true; }
    catch (cause) { setError(describe(cause)); await refresh(); return false; }
    finally { setBusy(false); setNow(Date.now()); }
  }
  const replace = (grant: AgentStandingGrant) => setGrants((current) => (current ?? []).map((item) => item.id === grant.id ? grant : item));

  const all = grants ?? [];
  const current = all.filter((grant) => ['active', 'used_up'].includes(stateOf(grant, now)));
  const ended = all.filter((grant) => !current.includes(grant));
  const order = [...connection.selectedProjectIds, ...new Set(current.map((grant) => grant.projectId))];
  const groups = [...new Set(order)].map((projectId) => ({ projectId, items: current.filter((grant) => grant.projectId === projectId) }))
    .filter((group) => group.items.length);

  return <section className="grants" aria-label={`Standing grants for ${connection.name}`} aria-busy={busy || undefined}>
    <div className="grants__head">
      <h2 className="grants__title">Standing grants <span className="grants__for">for {connection.name}</span></h2>
      <span className="grants__count">{grants === null ? 'Not loaded' : current.length ? `${current.length} active` : ended.length ? 'None active' : 'None yet'}</span>
    </div>
    <p className="grants__note">A grant lets this agent make one kind of change in one project, a set number of times, until it ends. Flux checks it on every call.</p>
    {error ? <p className="grants__alert" role="alert">{error}</p> : null}
    {grants === null ? <p className="grants__note">Grants could not be loaded. Reload the page to try again.</p> : null}
    {groups.map((group) => <div className="grants__project" key={group.projectId}>
      <h3 id={`${id}-${group.projectId}`}>{name(group.projectId)}</h3>
      <ul className="grants__list" aria-labelledby={`${id}-${group.projectId}`}>
        {group.items.map((grant) => <GrantRow key={grant.id} grant={grant} now={now} busy={busy}
          onNarrow={(command) => run(async () => replace(await narrowActionGrant(connection.id, grant.id, command)))}
          onRevoke={() => run(async () => {
            await revokeActionGrant(connection.id, grant.id);
            replace({ ...grant, revokedAt: new Date().toISOString() });
          })} />)}
      </ul>
    </div>)}
    {adding
      ? <AddGrant connection={connection} projects={projects} name={name} busy={busy} existing={current}
        onCancel={() => setAdding(false)}
        onCreate={(create) => run(async () => {
          const created = await create((grant) => setGrants((list) => [grant, ...(list ?? []).filter((item) => item.id !== grant.id)]));
          if (created) setAdding(false);
        })} />
      : <Button variant="secondary" icon="plus" className="grants__add-toggle" disabled={busy || grants === null} onClick={() => { setAdding(true); setError(null); }}>Add a grant</Button>}
    {ended.length ? <div className="grants__ended">
      {showEnded ? <>
        <h3>Ended</h3>
        <ul className="grants__list grants__list--ended" aria-label="Ended grants">{ended.map((grant) => <li className="grants__item" key={grant.id} data-state={stateOf(grant, now)}>
          <span className="grants__status">{grant.revokedAt ? `Revoked ${when(grant.revokedAt)}` : `Ended ${when(grant.expiresAt)}`}</span>
          <span className="grants__limits">{operationLabel(grant.operation)} · {CLASS_LABEL[grant.peerRequestClass]} · {name(grant.projectId)} · {grant.used} of {grant.maximumUses} used</span>
        </li>)}</ul>
      </> : null}
      <Button variant="quiet" aria-expanded={showEnded} onClick={() => setShowEnded((value) => !value)}>
        {showEnded ? 'Hide ended grants' : `Show ended grants (${ended.length})`}</Button>
    </div> : null}
  </section>;
}

function GrantRow({ grant, now, busy, onNarrow, onRevoke }: {
  grant: AgentStandingGrant; now: number; busy: boolean;
  onNarrow: (command: { maximumUses?: number; expiresAt?: string }) => Promise<boolean>;
  onRevoke: () => Promise<boolean>;
}) {
  const id = useId();
  const [mode, setMode] = useState<'idle' | 'narrow' | 'revoke'>('idle');
  const left = grant.maximumUses - grant.used;
  // Uses left can go down to none (when some were used: the grant is then used up), never below what was used.
  const minimumLeft = grant.used === 0 ? 1 : 0;
  const [usesLeft, setUsesLeft] = useState(String(left));
  const [end, setEnd] = useState('keep');
  const state = stateOf(grant, now);
  const label = operationLabel(grant.operation);
  const earlier = EARLIER.filter((choice) => now + choice.ms < Date.parse(grant.expiresAt));
  const parsed = Number(usesLeft);
  const validUses = Number.isInteger(parsed) && parsed >= minimumLeft && parsed <= left;

  async function narrow(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!validUses) return;
    const choice = EARLIER.find((item) => item.id === end);
    const command = { ...(parsed < left ? { maximumUses: grant.used + parsed } : {}),
      ...(choice ? { expiresAt: new Date(Date.now() + choice.ms).toISOString() } : {}) };
    if (!Object.keys(command).length) { setMode('idle'); return; }
    if (await onNarrow(command)) setMode('idle');
  }

  return <li className="grants__item" data-state={state}>
    <span className="grants__what"><strong>{label}</strong> · {CLASS_LABEL[grant.peerRequestClass]}{grant.objectId ? ' · one item only' : ''}</span>
    <span className="grants__limits">{state === 'used_up' ? `No uses left of ${grant.maximumUses}` : `${left} of ${grant.maximumUses} uses left`} · Ends {when(grant.expiresAt)}</span>
    {mode === 'idle' ? <span className="grants__actions">
      {state === 'active' ? <Button variant="link" disabled={busy} aria-label={`Narrow ${label}, ${CLASS_LABEL[grant.peerRequestClass]}`} onClick={() => { setUsesLeft(String(left)); setEnd('keep'); setMode('narrow'); }}>Narrow</Button> : null}
      <Button variant="link" disabled={busy} aria-label={`Revoke ${label}, ${CLASS_LABEL[grant.peerRequestClass]}`} onClick={() => setMode('revoke')}>Revoke</Button>
    </span> : null}
    {mode === 'revoke' ? <span className="grants__confirm">
      <span>Revoke this grant now? The agent’s next call with it is refused.</span>
      <Button variant="danger" busy={busy} onClick={() => { void onRevoke().then((done) => { if (done) setMode('idle'); }); }}>Revoke now</Button>
      <Button variant="quiet" disabled={busy} onClick={() => setMode('idle')}>Cancel</Button>
    </span> : null}
    {mode === 'narrow' ? <form className="grants__narrow" aria-label={`Narrow ${label}`} onSubmit={(event) => { void narrow(event); }}>
      <label htmlFor={`${id}-uses`}>Uses left</label>
      <input id={`${id}-uses`} type="number" inputMode="numeric" min={minimumLeft} max={left} step={1} value={usesLeft}
        onChange={(event) => setUsesLeft(event.target.value)} aria-describedby={`${id}-uses-help`} disabled={busy} />
      <small id={`${id}-uses-help`}>{minimumLeft} to {left}</small>
      <label htmlFor={`${id}-end`}>Ends</label>
      <select id={`${id}-end`} value={end} onChange={(event) => setEnd(event.target.value)} disabled={busy}>
        <option value="keep">Keep: {when(grant.expiresAt)}</option>
        {earlier.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
      </select>
      <span className="grants__form-actions">
        <Button type="submit" variant="primary" busy={busy} disabled={!validUses}>Save</Button>
        <Button variant="quiet" disabled={busy} onClick={() => setMode('idle')}>Cancel</Button>
      </span>
    </form> : null}
  </li>;
}

type Create = (added: (grant: AgentStandingGrant) => void) => Promise<boolean>;

function AddGrant({ connection, projects, name, busy, existing, onCancel, onCreate }: {
  connection: AgentConnection; projects: Map<string, Project>; name: (projectId: string) => string; busy: boolean;
  existing: AgentStandingGrant[]; onCancel: () => void; onCreate: (create: Create) => Promise<boolean>;
}) {
  const id = useId();
  // Standing authority comes from project management: only managed projects of this connection are offered.
  const manageable = connection.selectedProjectIds.filter((projectId) => projects.get(projectId)?.access === 'manager');
  const [projectId, setProjectId] = useState(manageable[0] ?? '');
  const [peerRequestClass, setClass] = useState<AgentPeerRequestClass>('execute');
  const [operations, setOperations] = useState<AgentOperation[]>([]);
  const [uses, setUses] = useState('100');
  const [ends, setEnds] = useState<string>('7d');
  // One attempt keeps its command IDs and end time, so retrying after a lost answer never creates a second grant.
  const attempt = useRef<{ key: string; expiresAt: string; ids: Map<AgentOperation, string> } | null>(null);
  const allowed = (operation: AgentOperation) => AGENT_OPERATION_CLASSES[operation].includes(peerRequestClass);
  const parsedUses = Number(uses);
  const validUses = Number.isInteger(parsedUses) && parsedUses >= 1 && parsedUses <= 1000;
  const chosen = operations.filter(allowed);

  if (!manageable.length) {
    return <div className="grants__add">
      <p className="grants__note">Only a project manager can add grants. You don’t manage any of this connection’s projects.</p>
      <Button variant="quiet" onClick={onCancel}>Close</Button>
    </div>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectId || !chosen.length || !validUses) return;
    // Each change keeps its command ID while the other choices stay the same: a retry after a partial failure
    // or a lost answer replays the grants already made instead of adding new ones.
    const key = JSON.stringify([projectId, peerRequestClass, parsedUses, ends]);
    if (attempt.current?.key !== key) {
      const choice = ENDS.find((item) => item.id === ends) ?? ENDS[1];
      attempt.current = { key, expiresAt: new Date(Date.now() + choice.ms).toISOString(), ids: new Map() };
    }
    const current = attempt.current;
    await onCreate(async (added) => {
      for (const operation of chosen) {
        let clientCommandId = current.ids.get(operation);
        if (!clientCommandId) { clientCommandId = crypto.randomUUID(); current.ids.set(operation, clientCommandId); }
        added(await createActionGrant(connection.id, { clientCommandId, projectId, operation, peerRequestClass,
          maximumUses: parsedUses, expiresAt: current.expiresAt }));
        // Granted: a later attempt for what is still selected starts afresh.
        setOperations((list) => list.filter((item) => item !== operation));
      }
      attempt.current = null;
      return true;
    });
  }

  return <form className="grants__add" aria-label={`Add a grant to ${connection.name}`} onSubmit={(event) => { void submit(event); }}>
    <h3>Add a grant</h3>
    <div className="grants__fields">
      <span className="grants__field">
        <label htmlFor={`${id}-project`}>Project</label>
        <select id={`${id}-project`} value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={busy}>
          {manageable.map((item) => <option key={item} value={item}>{name(item)}</option>)}
        </select>
      </span>
      <span className="grants__field">
        <label htmlFor={`${id}-class`}>Acts as</label>
        <select id={`${id}-class`} value={peerRequestClass} onChange={(event) => setClass(event.target.value as AgentPeerRequestClass)} disabled={busy}>
          {CLASSES.map((item) => <option key={item} value={item}>{CLASS_LABEL[item]}</option>)}
        </select>
      </span>
    </div>
    <fieldset className="grants__changes" disabled={busy}>
      <legend>Allowed changes</legend>
      {GRANTABLE.map((group) => {
        const offered = group.operations.filter(([operation]) => allowed(operation));
        return offered.length ? <div className="grants__area" key={group.area} role="group" aria-label={group.area}>
          <span className="grants__area-name">{group.area}</span>
          <span className="grants__area-options">{offered.map(([operation, label]) => {
            const has = existing.some((grant) => grant.projectId === projectId && grant.operation === operation && grant.peerRequestClass === peerRequestClass);
            return <label key={operation}>
              <input type="checkbox" checked={operations.includes(operation)}
                onChange={(event) => setOperations((list) => event.target.checked ? [...list, operation] : list.filter((item) => item !== operation))} />
              <span>{label}{has ? <small> · already granted</small> : null}</span>
            </label>;
          })}</span>
        </div> : null;
      })}
    </fieldset>
    <div className="grants__fields">
      <span className="grants__field">
        <label htmlFor={`${id}-uses`}>Uses for each change</label>
        <input id={`${id}-uses`} type="number" inputMode="numeric" min={1} max={1000} step={1} value={uses}
          onChange={(event) => setUses(event.target.value)} disabled={busy} />
      </span>
      <span className="grants__field">
        <label htmlFor={`${id}-ends`}>Ends</label>
        <select id={`${id}-ends`} value={ends} onChange={(event) => setEnds(event.target.value)} disabled={busy}>
          {ENDS.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        </select>
      </span>
    </div>
    <p className="grants__note">Grants stay inside this connection: its selected projects and the actions it was approved for.</p>
    <span className="grants__form-actions">
      <Button type="submit" variant="primary" busy={busy} disabled={!chosen.length || !validUses || !projectId}>
        {chosen.length > 1 ? `Grant ${chosen.length} changes` : 'Grant'}</Button>
      <Button variant="quiet" disabled={busy} onClick={onCancel}>Cancel</Button>
    </span>
  </form>;
}
