import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import { WORKSPACE_AI_POLICY_CHANGED_EVENT, type SetWorkspaceAiPolicyResult, type Workspace, type WorkspaceMember, type WorkspaceRole } from '@flux/contracts';
import { ApiError } from '../api/client';
import { whenPageLive } from '../api/pageLeaving';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { Avatar, Button, Icon, Input, Spinner, useRowMotion, useToast, Select, Option } from '../ui';
import { isEncryptionEvent, type EncryptedWorkspace } from '../encryption/api';
import { EncryptionSection } from '../encryption/EncryptionSection';
import { ROLE_HINT, ROLE_LABEL, addMember, attemptKeys, changeRole, firstName, getWorkspace, isManagerRole, listMembers, problemText, removeMember, setWorkspaceAi } from './api';
import './people.css';

const ROLES: WorkspaceRole[] = ['member', 'guest', 'admin', 'owner'];
/** Roles the caller may hand out: only an owner grants or changes the owner role (#29). */
const assignable = (mine: WorkspaceRole) => ROLES.filter((role) => role !== 'owner' || mine === 'owner');

type Roster = { workspace: EncryptedWorkspace; members: WorkspaceMember[] | null };

async function fetchRoster(workspaceId: string, signal: AbortSignal): Promise<Roster> {
  const workspace: EncryptedWorkspace = await getWorkspace(workspaceId, signal);
  // Guests may not read the roster (`workspace.read_members`): they see their own place only.
  const members = await listMembers(workspaceId, signal).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 403) return null;
    throw error;
  });
  return { workspace, members };
}

/**
 * People in one workspace (#188, AC-1). Everyone sees who is here and their role (guests see only
 * their own place, as the access policy allows). Owners and admins add an existing account by
 * email, change roles and remove people; anyone can leave. Being here never opens a restricted
 * project: that takes access given in the project itself (#44).
 */
export function WorkspacePeople({ workspaceId, onBack }: { workspaceId: string; onBack: () => void }) {
  const { me } = useShellData();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const rosterRef = useRef<HTMLHeadingElement>(null);
  const [reload, setReload] = useState(0);
  const revalidator = useRevalidator();

  useEffect(() => {
    const controller = new AbortController();
    // A page being left starts no read (#471); one whose navigation was cancelled reads once it is live.
    const waiting = whenPageLive(() => {
      fetchRoster(workspaceId, controller.signal).then((next) => { setRoster(next); setFailed(''); }, (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setFailed(error instanceof ApiError && error.status === 404 ? 'You’re no longer in this workspace.' : 'The people here couldn’t be loaded. Try again.');
      });
    });
    return () => { waiting(); controller.abort(); };
  }, [workspaceId, reload]);
  const load = () => setReload((n) => n + 1);
  // Someone turned AI off or on here (F-029, #614), or unlocked, locked or gave an unlock password (F-030, #655): the rows show the state as it is now.
  useStreamEvents(me.user.id, (event) => { if ((event.kind === WORKSPACE_AI_POLICY_CHANGED_EVENT || isEncryptionEvent(event.kind)) && event.objectId === workspaceId) load(); }, load);

  // F-030 (#655): after an owner removes or demotes an owner or admin of an encrypted space, the old recovery code has stopped
  // working, and the group that makes a new one opens in the Encryption section, where focus goes.
  const [offerCode, setOfferCode] = useState(0);
  const changed = (message: string, editorClosed: boolean, holderLeft = false) => {
    setDone(message); setEditing(null);
    load();
    const offering = holderLeft && roster?.workspace.encryption?.state === 'unlocked' && roster.workspace.role === 'owner';
    if (offering) setOfferCode((count) => count + 1);
    // A member's editor that had focus is gone: focus the roster, whose status line says what changed.
    // Adding someone leaves focus where it is, in the form the person may fill again at once: a focus
    // move one frame later took the keystrokes of the next address (#491).
    if (editorClosed && !offering) requestAnimationFrame(() => rosterRef.current?.focus({ preventScroll: true }));
    // Roles change what the sidebar may list for the caller.
    revalidator.revalidate();
  };

  // People who join or leave grow in and collapse where they stood (#593 AC-4).
  const listRef = useRef<HTMLUListElement>(null);
  useRowMotion(listRef, '.people__item[data-row-key]', (el) => el.dataset.rowKey, `${workspaceId}|${roster ? 'ready' : 'loading'}`);
  const back = <button type="button" className="details__back" aria-label="Back to Details" onClick={onBack}><Icon name="chevron-left" size={14} />Details</button>;
  if (!roster) {
    return (
      <div className="details people">
        {back}
        <p className="details__eyebrow">Workspace</p>
        <h3 className="details__title">People</h3>
        {failed ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{failed}<button type="button" onClick={load}>Try again</button></p>
          : <div className="people__loading"><Spinner label="Loading people" /></div>}
      </div>
    );
  }

  const { workspace, members } = roster;
  const myRole = workspace.role ?? 'guest';
  const manager = isManagerRole(myRole);
  const owners = members?.filter((member) => member.role === 'owner').length ?? 0;
  const ordered = members ? [...members.filter((member) => member.userId === me.user.id), ...members.filter((member) => member.userId !== me.user.id)] : null;

  return (
    <div className="details people">
      {back}
      <p className="details__eyebrow">{workspace.name}</p>
      <h3 className="details__title">People</h3>
      <p className="details__lead">Being in {workspace.name} doesn’t open every project. Restricted projects show only to the people given access in the project itself.</p>

      {manager && members ? <AddPerson workspace={workspace} members={members} myRole={myRole} onAdded={(member) => changed(`${member.name} joined ${workspace.name} as ${ROLE_LABEL[member.role].toLowerCase()}.`, false)} /> : null}

      <section className="details__sec" aria-labelledby="people-here">
        <h4 id="people-here" ref={rosterRef} tabIndex={-1}>{ordered ? `In ${workspace.name} · ${ordered.length}` : `You in ${workspace.name}`}</h4>
        {ordered ? (
          <ul className="people__list" ref={listRef} aria-label={`People in ${workspace.name}`}>
            {ordered.map((member) => (
              <MemberRow key={member.userId} member={member} self={member.userId === me.user.id} workspace={workspace} myRole={myRole}
                editable={manager && (member.role !== 'owner' || myRole === 'owner')}
                editing={editing === member.userId} onEdit={(open) => { setDone(''); setEditing(open ? member.userId : null); }}
                onChanged={(message, holderLeft) => changed(message, true, holderLeft)} />
            ))}
          </ul>
        ) : (
          <ul className="people__list">
            <li className="people__item"><div className="people__row"><Avatar name={me.user.name} size="md" tone="me" /><span className="people__who"><b>{me.user.name} (you)</b><span>{me.user.email}</span></span><span className="people__role">{ROLE_LABEL[myRole]}</span></div></li>
          </ul>
        )}
        <p className="people__done" role="status">{done ? <><Icon name="check" size={13} />{done}</> : null}</p>
        {!manager ? (
          <p className="ov-note">{members
            ? `Only owners and admins add people or change roles in ${workspace.name}.`
            : `Guests see only the projects given to them, not everyone in ${workspace.name}.`}</p>
        ) : null}
      </section>

      {/* Encrypted spaces (F-030, #655): Encryption comes before AI and keeps its place in every state; AI is off for good and has no switch. */}
      {workspace.encryption ? <EncryptionSection workspace={workspace} members={members} meId={me.user.id} myRole={myRole} offerCode={offerCode} onChanged={() => { load(); revalidator.revalidate(); }} /> : null}

      <AiRow workspace={workspace} manager={manager} onChanged={() => { load(); revalidator.revalidate(); }} />

      <Leave workspace={workspace} soleOwner={myRole === 'owner' && owners <= 1} holder={manager} onLeft={onBack} meId={me.user.id} />
      <p className="details__keys"><kbd>]</kbd> toggles this panel · <kbd>Esc</kbd> closes it</p>
    </div>
  );
}

function AddPerson({ workspace, members, myRole, onAdded }: { workspace: Workspace; members: WorkspaceMember[]; myRole: WorkspaceRole; onAdded: (member: WorkspaceMember) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('member');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const emailRef = useRef<HTMLInputElement>(null);
  const roleId = useId();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+$/.test(address)) { setProblem('Enter the email address of their Flux account.'); emailRef.current?.focus(); return; }
    setBusy(true); setProblem('');
    try {
      const member = await addMember(workspace.id, address, role, keys.current.for(`${address}:${role}`));
      keys.current.done();
      setEmail(''); setRole('member');
      onAdded(member);
    } catch (error) {
      const known = error instanceof ApiError && error.code === 'ALREADY_MEMBER' ? members.find((member) => member.email.toLowerCase() === address)?.name : undefined;
      setProblem(problemText(error, { workspace: workspace.name, email: address, who: known }));
      emailRef.current?.focus();
    } finally { setBusy(false); }
  }

  return (
    <section className="details__sec" aria-labelledby="people-add">
      <h4 id="people-add">Add someone</h4>
      <form className="people__add" onSubmit={(event) => void submit(event)} noValidate>
        <Input ref={emailRef} id="people-add-email" label="Email" type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="name@example.com" value={email}
          aria-invalid={problem ? true : undefined} aria-describedby={problem ? 'people-add-problem people-add-email-hint' : 'people-add-email-hint'}
          onChange={(event) => { setEmail(event.target.value); if (problem) setProblem(''); }}
          hint="They need an account at this Flux address first. Flux doesn’t send invitations." />
        <div className="people__field">
          <label htmlFor={roleId}>Role</label>
          <Select id={roleId} value={role} onChange={(next) => setRole(next as WorkspaceRole)} aria-describedby={`${roleId}-hint`}>
            {assignable(myRole).map((option) => <Option key={option} value={option}>{ROLE_LABEL[option]}</Option>)}
          </Select>
          <p className="people__hint" id={`${roleId}-hint`}>{ROLE_HINT[role]}</p>
        </div>
        {problem ? <p className="people__notice" id="people-add-problem" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
        <div className="details__actions"><Button type="submit" variant="primary" busy={busy}>Add to {workspace.name}</Button></div>
      </form>
    </section>
  );
}

function MemberRow({ member, self, workspace, myRole, editable, editing, onEdit, onChanged }: {
  member: WorkspaceMember; self: boolean; workspace: EncryptedWorkspace; myRole: WorkspaceRole; editable: boolean;
  editing: boolean; onEdit: (open: boolean) => void; onChanged: (message: string, holderLeft?: boolean) => void;
}) {
  const editId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const close = () => { onEdit(false); changeRef.current?.focus(); };
  return (
    <li className={`people__item${editing ? ' is-editing' : ''}`} data-row-key={member.userId}>
      <div className="people__row">
        <Avatar name={member.name} size="md" tone={self ? 'me' : 'neutral'} />
        <span className="people__who"><b>{member.name}{self ? ' (you)' : ''}</b><span>{member.email}</span></span>
        <span className="people__role">{ROLE_LABEL[member.role]}</span>
        {editable ? (
          <Button ref={changeRef} variant="quiet" className="people__change" aria-expanded={editing} aria-controls={editing ? editId : undefined} onClick={() => onEdit(!editing)}>
            Change<span className="ui-vh"> {self ? 'your role' : member.name}</span>
          </Button>
        ) : null}
      </div>
      {editing ? <MemberEditor id={editId} member={member} self={self} workspace={workspace} myRole={myRole} onClose={close} onChanged={onChanged} /> : null}
    </li>
  );
}

/** One member's role and removal; mounted fresh each time it opens, so nothing stale carries over. */
function MemberEditor({ id, member, self, workspace, myRole, onClose, onChanged }: {
  id: string; member: WorkspaceMember; self: boolean; workspace: EncryptedWorkspace; myRole: WorkspaceRole;
  onClose: () => void; onChanged: (message: string, holderLeft?: boolean) => void;
}) {
  const [role, setRole] = useState<WorkspaceRole>(member.role);
  const [confirm, setConfirm] = useState<'remove' | 'demote' | null>(null);
  const [busy, setBusy] = useState<'role' | 'remove' | null>(null);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const selectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { selectRef.current?.focus(); }, []);
  const article = (value: WorkspaceRole) => (value === 'admin' || value === 'owner' ? 'an' : 'a');
  // F-030 (#655): an owner or admin who stops being one (removed, demoted, leaving) changes the key of an encrypted space: its content
  // is encrypted again in the background, and what that person may have kept (a backup) still opens with their old password.
  const holder = !!workspace.encryption && isManagerRole(member.role);
  const demoting = holder && !isManagerRole(role);
  const first = firstName(member.name);
  const rotationText = `${workspace.name} gets a new key, and everything in it is encrypted again in the background. When that finishes, ${first}’s unlock password opens nothing made from then on. The recovery code stops working, and an owner makes a new one. A copy ${first} may already have, such as an old backup, still opens with their old password.`;

  async function saveRole() {
    if (busy || role === member.role) return;
    setConfirm(null);
    setBusy('role'); setProblem('');
    try {
      await changeRole(workspace.id, member.userId, role, keys.current.for(`${member.userId}:${role}`));
      keys.current.done();
      onChanged(self ? `You’re now ${article(role)} ${ROLE_LABEL[role].toLowerCase()} of ${workspace.name}.` : `${member.name} is now ${article(role)} ${ROLE_LABEL[role].toLowerCase()}.`, demoting);
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name, who: self ? 'You' : member.name }));
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy('remove'); setProblem('');
    try {
      await removeMember(workspace.id, member.userId);
      onChanged(`${member.name} is no longer in ${workspace.name}.`, holder);
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name, who: member.name }));
      setBusy(null);
    }
  }

  return (
    <div className="people__edit" id={id} role="group" aria-label={self ? 'Change your role' : `Change ${member.name}`}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <div className="people__field">
        <label htmlFor={`${id}-role`}>Role</label>
        <Select ref={selectRef} id={`${id}-role`} value={role} onChange={(next) => setRole(next as WorkspaceRole)} aria-describedby={`${id}-hint`}>
          {assignable(myRole).map((option) => <Option key={option} value={option}>{ROLE_LABEL[option]}</Option>)}
        </Select>
        <p className="people__hint" id={`${id}-hint`}>{ROLE_HINT[role]}</p>
      </div>
      <div className="details__actions">
        <Button variant="primary" busy={busy === 'role'} disabled={role === member.role} onClick={() => (demoting ? setConfirm('demote') : void saveRole())}>Save role</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
      {confirm === 'demote' ? (
        <div className="details__confirm people__confirm" role="group" aria-label={`Make ${first} ${article(role)} ${ROLE_LABEL[role].toLowerCase()}`} data-rotation-confirm="demote">
          <p><b>Make {first} {article(role)} {ROLE_LABEL[role].toLowerCase()}?</b></p>
          <p>{rotationText}</p>
          <div className="details__actions">
            <Button variant="primary" busy={busy === 'role'} onClick={() => void saveRole()}>Make {first} {article(role)} {ROLE_LABEL[role].toLowerCase()}</Button>
            <Button variant="quiet" onClick={() => setConfirm(null)}>Keep {first} {article(member.role)} {ROLE_LABEL[member.role].toLowerCase()}</Button>
          </div>
        </div>
      ) : null}
      {!self ? (confirm === 'remove' ? (
        holder ? (
          <div className="details__confirm people__confirm" role="group" aria-label={`Remove ${member.name}`} data-rotation-confirm="remove">
            <p><b>Remove {first} from {workspace.name}?</b></p>
            <p>{rotationText}</p>
            <div className="details__actions">
              <Button variant="primary" busy={busy === 'remove'} onClick={() => void remove()}>Remove {first}</Button>
              <Button variant="quiet" onClick={() => setConfirm(null)}>Keep {first}</Button>
            </div>
          </div>
        ) : (
          <div className="details__confirm people__confirm" role="group" aria-label={`Remove ${member.name}`}>
            <p>{first} loses access to {workspace.name} at once: its projects, and any access given to them there.</p>
            <div className="details__actions">
              <Button variant="danger" busy={busy === 'remove'} onClick={() => void remove()}>Remove {first}</Button>
              <Button variant="secondary" onClick={() => setConfirm(null)}>Keep</Button>
            </div>
          </div>
        )
      ) : <Button variant="quiet" className="details__leave people__remove" onClick={() => setConfirm('remove')}>Remove from {workspace.name}</Button>) : null}
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
    </div>
  );
}

/** Leaving ends access at once, so it asks first; the last owner is told what to do instead. */
function Leave({ workspace, soleOwner, holder, onLeft, meId }: { workspace: EncryptedWorkspace; soleOwner: boolean; holder: boolean; onLeft: () => void; meId: string }) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  async function leave() {
    setBusy(true); setProblem('');
    try {
      await removeMember(workspace.id, meId);
      onLeft();
      navigate('/', { replace: true });
      revalidator.revalidate();
      toast({ message: `You left ${workspace.name}.` });
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name, who: 'You' }));
      setBusy(false);
    }
  }
  return (
    <section className="details__sec" aria-label={`Leave ${workspace.name}`}>
      {soleOwner ? <p className="ov-note">You’re the only owner of {workspace.name}. To leave, make someone else an owner first.</p>
        : confirm ? (
          <div role="group" aria-label={`Leave ${workspace.name}`} className="details__confirm">
            <p>You lose access to {workspace.name} and its projects at once. Someone has to add you again to come back.</p>
            {/* F-030 (#655): an owner or admin who leaves an encrypted space changes its key. */}
            {holder && workspace.encryption ? <p data-rotation-confirm="leave">{workspace.name} gets a new key when you leave. Your unlock password stops opening anything made after that.</p> : null}
            <div className="details__actions">
              <Button variant="danger" busy={busy} onClick={() => void leave()}>Leave</Button>
              <Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button>
            </div>
          </div>
        ) : <Button variant="quiet" className="details__leave" onClick={() => setConfirm(true)}>Leave {workspace.name}</Button>}
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
    </section>
  );
}

const turnedOffOn = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** "2 runs stopped." for the status line after AI is turned off (the work that was stopped at once); nothing when none was running. */
function stoppedLine(stopped: SetWorkspaceAiPolicyResult['stopped']) {
  if (!stopped) return '';
  const total = stopped.runs + stopped.comparisons + stopped.requests + stopped.units + stopped.sessions;
  return total ? ` ${total} ${total === 1 ? 'run' : 'runs'} stopped.` : '';
}

/**
 * AI in this workspace (F-029, #614): one row after the people and before Leave. Owners and admins see the state and one
 * quiet button; it asks first, in place, like Remove and Leave, because turning AI off stops work that cannot be restored.
 * Only the line and the button's label change between states, so the control never moves (Spokój rule 7). Everyone else
 * sees one read-only line while AI is off, and nothing while it is on.
 */
function AiRow({ workspace, manager, onChanged }: { workspace: EncryptedWorkspace; manager: boolean; onChanged: () => void }) {
  const ai = workspace.ai;
  const blocked = ai?.state === 'blocked';
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [stopped, setStopped] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const trigger = useRef<HTMLButtonElement>(null);
  const confirmFirst = useRef<HTMLButtonElement>(null);
  const lineId = useId();
  const confirmId = useId();
  useEffect(() => { if (confirming) confirmFirst.current?.focus(); }, [confirming]);
  // Another person's change (or this tab's own, once read again) ends a question about the old state.
  const seen = useRef(ai?.version);
  useEffect(() => { if (seen.current !== ai?.version) { seen.current = ai?.version; setConfirming(false); } }, [ai?.version]);
  if (!ai) return null;

  // An encrypted space is always without AI (F-030, #655): everyone reads the same fixed line, in the row's place, and nobody has a switch.
  if (workspace.encryption || ai.fixed === 'encrypted') {
    return (
      <section className="details__sec people__ai" aria-labelledby={`${lineId}-h`} data-ai-row="fixed">
        <h4 id={`${lineId}-h`}>AI in {workspace.name}</h4>
        <p className="people__ai-line" id={lineId}>Off · {workspace.name} is encrypted, so AI can never be turned on here.</p>
      </section>
    );
  }

  if (!manager) {
    return blocked ? (
      <section className="details__sec people__ai" aria-label={`AI in ${workspace.name}`} data-ai-row="readonly">
        <p className="ov-note">AI is off in {workspace.name}. Its owners and admins turned it off.</p>
      </section>
    ) : null;
  }

  const target = blocked ? 'allowed' : 'blocked';
  const when = turnedOffOn.format(new Date(ai.changedAt));
  const line = blocked
    ? `Off · turned off${ai.changedBy ? ` by ${ai.changedBy.name}` : ''} on ${when}. No agent or assistant can read or change anything here.`
    : 'On · agents and assistants can work here.';
  const closeConfirm = () => { setConfirming(false); requestAnimationFrame(() => trigger.current?.focus({ preventScroll: true })); };

  async function change() {
    if (busy) return;
    setBusy(true); setProblem(''); setStatus(''); setStopped(false);
    try {
      const result = await setWorkspaceAi(workspace.id, target, ai!.version, keys.current.for(`${target}:${ai!.version}`));
      keys.current.done();
      setStatus(target === 'blocked' ? `AI is off in ${workspace.name}.${stoppedLine(result.stopped)}` : `AI is on in ${workspace.name}.`);
      setStopped(target === 'blocked' && stoppedLine(result.stopped) !== '');
      closeConfirm();
      onChanged();
    } catch (error) {
      keys.current.done();
      if (error instanceof ApiError && error.code === 'VERSION_CONFLICT') setProblem('Someone changed this just now.');
      else if (error instanceof ApiError && error.status === 403) setProblem('Only owners and admins can change this.');
      else setProblem(problemText(error, { workspace: workspace.name }));
      closeConfirm();
      onChanged();
    } finally { setBusy(false); }
  }

  return (
    <section className="details__sec people__ai" aria-labelledby={`${lineId}-h`} data-ai-row={blocked ? 'off' : 'on'}>
      <h4 id={`${lineId}-h`}>AI in {workspace.name}</h4>
      <div className="people__ai-row">
        <p className="people__ai-line" id={lineId}>{line}</p>
        <Button ref={trigger} variant="secondary" className="people__ai-button" aria-describedby={lineId} aria-expanded={confirming} aria-controls={confirming ? confirmId : undefined}
          onClick={() => { setStatus(''); setStopped(false); setProblem(''); setConfirming(!confirming); }}>{blocked ? 'Turn on AI' : 'Turn off AI'}</Button>
      </div>
      {confirming ? (
        <div className="details__confirm people__confirm" id={confirmId} role="group" aria-label={blocked ? `Turn on AI in ${workspace.name}` : `Turn off AI in ${workspace.name}`}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); closeConfirm(); } }}>
          <p>{blocked
            ? 'People’s assistants and connected agents can work here again, with the access they had. Nothing that was stopped starts again.'
            : `No agent or assistant, including each person’s own, can read or change anything in ${workspace.name}. Work they are doing now stops and is not posted. Nothing is deleted.`}</p>
          <div className="details__actions">
            <Button ref={confirmFirst} variant="primary" busy={busy} onClick={() => void change()}>{blocked ? 'Turn on AI here' : 'Turn off AI here'}</Button>
            <Button variant="quiet" onClick={closeConfirm}>{blocked ? 'Keep AI off' : 'Keep AI on'}</Button>
          </div>
        </div>
      ) : null}
      {/* Announced to everyone; shown only when it says something the row's own line does not (what was stopped). */}
      <p className={stopped ? 'people__ai-status' : 'ui-vh'} role="status">{status}</p>
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
    </section>
  );
}
