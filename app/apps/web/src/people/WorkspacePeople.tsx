import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import type { Workspace, WorkspaceMember, WorkspaceRole } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { Avatar, Button, Icon, Input, Spinner, useToast } from '../ui';
import { ROLE_HINT, ROLE_LABEL, addMember, attemptKeys, changeRole, firstName, getWorkspace, isManagerRole, listMembers, problemText, removeMember } from './api';
import './people.css';

const ROLES: WorkspaceRole[] = ['member', 'guest', 'admin', 'owner'];
/** Roles the caller may hand out: only an owner grants or changes the owner role (#29). */
const assignable = (mine: WorkspaceRole) => ROLES.filter((role) => role !== 'owner' || mine === 'owner');

type Roster = { workspace: Workspace; members: WorkspaceMember[] | null };

async function fetchRoster(workspaceId: string, signal: AbortSignal): Promise<Roster> {
  const workspace = await getWorkspace(workspaceId, signal);
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
    fetchRoster(workspaceId, controller.signal).then((next) => { setRoster(next); setFailed(''); }, (error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setFailed(error instanceof ApiError && error.status === 404 ? 'You’re no longer in this workspace.' : 'The people here couldn’t be loaded. Try again.');
    });
    return () => controller.abort();
  }, [workspaceId, reload]);
  const load = () => setReload((n) => n + 1);

  const changed = (message: string) => {
    setDone(message); setEditing(null);
    load();
    // The editor that had focus is gone: focus the roster, whose status line says what changed.
    requestAnimationFrame(() => rosterRef.current?.focus({ preventScroll: true }));
    // Roles change what the sidebar may list for the caller.
    revalidator.revalidate();
  };

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

      {manager && members ? <AddPerson workspace={workspace} members={members} myRole={myRole} onAdded={(member) => changed(`${member.name} joined ${workspace.name} as ${ROLE_LABEL[member.role].toLowerCase()}.`)} /> : null}

      <section className="details__sec" aria-labelledby="people-here">
        <h4 id="people-here" ref={rosterRef} tabIndex={-1}>{ordered ? `In ${workspace.name} · ${ordered.length}` : `You in ${workspace.name}`}</h4>
        {ordered ? (
          <ul className="people__list" aria-label={`People in ${workspace.name}`}>
            {ordered.map((member) => (
              <MemberRow key={member.userId} member={member} self={member.userId === me.user.id} workspace={workspace} myRole={myRole}
                editable={manager && (member.role !== 'owner' || myRole === 'owner')}
                editing={editing === member.userId} onEdit={(open) => { setDone(''); setEditing(open ? member.userId : null); }}
                onChanged={changed} />
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

      <Leave workspace={workspace} soleOwner={myRole === 'owner' && owners <= 1} onLeft={onBack} meId={me.user.id} />
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
          <select id={roleId} value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)} aria-describedby={`${roleId}-hint`}>
            {assignable(myRole).map((option) => <option key={option} value={option}>{ROLE_LABEL[option]}</option>)}
          </select>
          <p className="people__hint" id={`${roleId}-hint`}>{ROLE_HINT[role]}</p>
        </div>
        {problem ? <p className="people__notice" id="people-add-problem" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
        <div className="details__actions"><Button type="submit" variant="primary" busy={busy}>Add to {workspace.name}</Button></div>
      </form>
    </section>
  );
}

function MemberRow({ member, self, workspace, myRole, editable, editing, onEdit, onChanged }: {
  member: WorkspaceMember; self: boolean; workspace: Workspace; myRole: WorkspaceRole; editable: boolean;
  editing: boolean; onEdit: (open: boolean) => void; onChanged: (message: string) => void;
}) {
  const editId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const close = () => { onEdit(false); changeRef.current?.focus(); };
  return (
    <li className={`people__item${editing ? ' is-editing' : ''}`}>
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
  id: string; member: WorkspaceMember; self: boolean; workspace: Workspace; myRole: WorkspaceRole;
  onClose: () => void; onChanged: (message: string) => void;
}) {
  const [role, setRole] = useState<WorkspaceRole>(member.role);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState<'role' | 'remove' | null>(null);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { selectRef.current?.focus(); }, []);
  const article = (value: WorkspaceRole) => (value === 'admin' || value === 'owner' ? 'an' : 'a');

  async function saveRole() {
    if (busy || role === member.role) return;
    setBusy('role'); setProblem('');
    try {
      await changeRole(workspace.id, member.userId, role, keys.current.for(`${member.userId}:${role}`));
      keys.current.done();
      onChanged(self ? `You’re now ${article(role)} ${ROLE_LABEL[role].toLowerCase()} of ${workspace.name}.` : `${member.name} is now ${article(role)} ${ROLE_LABEL[role].toLowerCase()}.`);
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
      onChanged(`${member.name} is no longer in ${workspace.name}.`);
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
        <select ref={selectRef} id={`${id}-role`} value={role} onChange={(event) => setRole(event.target.value as WorkspaceRole)} aria-describedby={`${id}-hint`}>
          {assignable(myRole).map((option) => <option key={option} value={option}>{ROLE_LABEL[option]}</option>)}
        </select>
        <p className="people__hint" id={`${id}-hint`}>{ROLE_HINT[role]}</p>
      </div>
      <div className="details__actions">
        <Button variant="primary" busy={busy === 'role'} disabled={role === member.role} onClick={() => void saveRole()}>Save role</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
      {!self ? (confirmRemove ? (
        <div className="details__confirm people__confirm" role="group" aria-label={`Remove ${member.name}`}>
          <p>{firstName(member.name)} loses access to {workspace.name} at once: its projects, and any access given to them there.</p>
          <div className="details__actions">
            <Button variant="danger" busy={busy === 'remove'} onClick={() => void remove()}>Remove {firstName(member.name)}</Button>
            <Button variant="secondary" onClick={() => setConfirmRemove(false)}>Keep</Button>
          </div>
        </div>
      ) : <Button variant="quiet" className="details__leave people__remove" onClick={() => setConfirmRemove(true)}>Remove from {workspace.name}</Button>) : null}
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
    </div>
  );
}

/** Leaving ends access at once, so it asks first; the last owner is told what to do instead. */
function Leave({ workspace, soleOwner, onLeft, meId }: { workspace: Workspace; soleOwner: boolean; onLeft: () => void; meId: string }) {
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
