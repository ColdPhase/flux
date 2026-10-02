import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import type { Project, ProjectAccess as Access, ProjectGrant, ProjectGrantRole, ProjectPerson, WorkspaceMember } from '@flux/contracts';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { ACCESS_LABEL } from '../project/data';
import { Avatar, Button, Icon } from '../ui';
import { ROLE_LABEL, attemptKeys, firstName, grantPerson, isManagerRole, levelFor, listGrants, listMembers, problemText, revokeGrant } from './api';
import './people.css';

/** A change to one person's access: set a grant, or remove it. */
type Change = { kind: 'grant'; role: ProjectGrantRole } | { kind: 'revoke' };
interface Option { id: string; label: string; change: Change; confirm: string; preview: string; danger?: boolean }

interface Roster { members: WorkspaceMember[]; grants: ProjectGrant[] }

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * "Who can see this" for a project (#188, AC-2): exactly who can open it now, read from the server's
 * access policy, and why. Owners and admins of the workspace (the project's managers) give a
 * workspace member access as a writer or reader, change or remove it, or keep someone out with an
 * explicit deny. Each change names its exact consequence before it is confirmed; nothing is
 * granted implicitly. Everyone else sees the same list read-only.
 */
export function ProjectAccess({ project, people, focusToken }: { project: Project; people: ProjectPerson[] | null; focusToken?: object | null }) {
  const { me, workspaces } = useShellData();
  const { openDetails } = useShellActions();
  const revalidator = useRevalidator();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [roster, setRoster] = useState<Roster | null>(null);
  const [rosterFailed, setRosterFailed] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const manager = project.access === 'manager';
  const workspaceName = workspaces.find((space) => space.id === project.workspaceId)?.name ?? 'this workspace';

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!manager) return;
    try {
      const [members, grants] = await Promise.all([listMembers(project.workspaceId, signal), listGrants(project.id, signal)]);
      setRoster({ members, grants }); setRosterFailed(false);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setRosterFailed(true);
    }
  }, [manager, project.id, project.workspaceId]);
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // The header's audience line (and a new project) lead here: bring the section into view.
  useEffect(() => {
    if (!focusToken) return;
    const frame = requestAnimationFrame(() => {
      headingRef.current?.scrollIntoView({ block: 'start', behavior: reduced() ? 'auto' : 'smooth' });
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusToken]);

  const changed = (message: string) => {
    setDone(message); setEditing(null);
    void load();
    revalidator.revalidate();
  };

  const myRole = roster?.members.find((member) => member.userId === me.user.id)?.role ?? null;
  const memberOf = (id: string) => roster?.members.find((member) => member.userId === id) ?? null;
  const grantOf = (id: string) => roster?.grants.find((grant) => grant.principal.kind === 'human' && grant.principal.id === id) ?? null;
  const others = (people ?? []).filter((person) => !(person.kind === 'human' && person.id === me.user.id));
  const keptOut = roster ? roster.grants.filter((grant) => grant.role === 'denied' && grant.principal.kind === 'human').map((grant) => ({ grant, member: memberOf(grant.principal.id) })).filter((row): row is { grant: ProjectGrant; member: WorkspaceMember } => !!row.member) : [];
  const candidates = roster ? roster.members.filter((member) => member.userId !== me.user.id && grantOf(member.userId)?.role !== 'denied'
    && levelFor(member.role, project.visibility, grantOf(member.userId)?.role ?? null) === null) : [];

  /** Why someone can open it, in words, when the manager's roster is known. */
  const why = (person: ProjectPerson): string | null => {
    if (person.kind === 'agent') return null;
    const member = memberOf(person.id);
    if (!member) return null;
    if (isManagerRole(member.role)) return `${ROLE_LABEL[member.role]} of ${workspaceName}`;
    if (grantOf(person.id)) return 'Given access here';
    return `Everyone in ${workspaceName}`;
  };

  const optionsFor = (member: WorkspaceMember): Option[] => {
    const grant = grantOf(member.userId);
    const current = grant?.role ?? null;
    if (member.userId === me.user.id || (member.role === 'owner' && myRole !== 'owner')) return [];
    const name = member.name;
    const first = firstName(name);
    const fallback = levelFor(member.role, project.visibility, null);
    const options: Option[] = [];
    if (!isManagerRole(member.role)) {
      if (current !== 'contributor' && !(current === null && fallback === 'contributor')) {
        options.push({ id: 'contributor', label: 'Can write', change: { kind: 'grant', role: 'contributor' }, confirm: 'Change access', preview: `${name} will be able to read and write in ${project.name}: its conversations, tasks, map and wiki.` });
      }
      if (current !== 'viewer') {
        options.push({ id: 'viewer', label: 'Can read', change: { kind: 'grant', role: 'viewer' }, confirm: 'Change access', preview: `${name} will be able to read ${project.name} but not write in it.` });
      }
    }
    if (current && current !== 'denied') {
      options.push(fallback
        ? { id: 'revoke', label: 'Back to the workspace default', change: { kind: 'revoke' }, confirm: 'Change access', preview: `${name} can ${fallback === 'manager' ? 'manage' : 'write in'} ${project.name} like every ${member.role} of ${workspaceName}.` }
        : { id: 'revoke', label: 'Remove access', change: { kind: 'revoke' }, confirm: 'Remove access', danger: true, preview: `${name} loses access to ${project.name} at once. ${project.visibility === 'restricted' ? 'They won’t see it at all, not even its name.' : ''}`.trim() });
    }
    if (current === 'denied') {
      options.push({ id: 'revoke', label: 'Let back in', change: { kind: 'revoke' }, confirm: `Let ${first} back in`, preview: fallback
        ? `${name} can ${fallback === 'manager' ? 'manage' : 'write in'} ${project.name} again as ${member.role === 'admin' || member.role === 'owner' ? 'an' : 'a'} ${ROLE_LABEL[member.role].toLowerCase()} of ${workspaceName}.`
        : `${name} is no longer kept out, but still can’t open ${project.name} until someone gives them access.` });
    } else {
      options.push({ id: 'denied', label: 'Keep out of this project', change: { kind: 'grant', role: 'denied' }, confirm: `Keep ${first} out`, danger: true, preview: `${name} is kept out of ${project.name} at once, whatever their role in ${workspaceName}.${isManagerRole(member.role) ? ' Only another owner or admin can let them back in.' : ''}` });
    }
    return options;
  };

  const apply = async (member: WorkspaceMember, option: Option, key: string) => {
    const grant = grantOf(member.userId);
    if (option.change.kind === 'revoke') {
      if (grant) await revokeGrant(project.id, grant.id);
    } else {
      await grantPerson(project.id, member.userId, option.change.role, key);
    }
    const first = firstName(member.name);
    changed(option.id === 'denied' ? `${first} is kept out of ${project.name}.`
      : option.id === 'revoke' ? (grant?.role === 'denied' ? `${first} is no longer kept out.` : `${first}’s access was removed.`)
        : `${first} ${option.id === 'contributor' ? 'can now write in' : 'can now read'} ${project.name}.`);
  };

  const meRow = <li className="people__item"><div className="people__row"><Avatar name={me.user.name} size="md" tone="me" /><span className="people__who"><b>{me.user.name} (you)</b><span>{ACCESS_LABEL[project.access]}</span></span></div></li>;

  return (
    <section className="details__sec access" aria-labelledby="ov-people">
      <h4 id="ov-people" ref={headingRef} tabIndex={-1}>Who can see this</h4>
      <p className="access__mode"><Icon name="lock" size={13} />
        {project.visibility === 'restricted'
          ? <span><b>Restricted.</b> Only the people listed here can open it; others in {workspaceName} don’t see it at all.</span>
          : <span><b>Open to {workspaceName}.</b> Every member can write here; guests only with access given here.</span>}
      </p>
      {people ? (
        <ul className="people__list" aria-label={`People who can see ${project.name}`}>
          {meRow}
          {others.map((person) => {
            const member = person.kind === 'human' ? memberOf(person.id) : null;
            const options = member && manager ? optionsFor(member) : [];
            const reason = manager ? why(person) : null;
            return (
              <AccessRow key={`${person.kind}:${person.id}`} name={`${person.name}${person.kind === 'agent' ? ' (agent)' : ''}`}
                label={`${ACCESS_LABEL[person.access]}${reason ? ` · ${reason}` : ''}`} access={person.access}
                options={options} editing={editing === person.id} onEdit={(open) => { setDone(''); setEditing(open ? person.id : null); }}
                onApply={member ? (option, key) => apply(member, option, key) : undefined} workspaceName={workspaceName} />
            );
          })}
        </ul>
      ) : <p>Everyone with access to {project.name}.</p>}

      {manager && keptOut.length ? (
        <>
          <h4 className="access__sub" id="ov-kept-out">Kept out</h4>
          <ul className="people__list" aria-labelledby="ov-kept-out">
            {keptOut.map(({ member }) => (
              <AccessRow key={member.userId} name={member.name} label={`Kept out · ${ROLE_LABEL[member.role]} of ${workspaceName}`} access={null}
                options={optionsFor(member)} editing={editing === member.userId} onEdit={(open) => { setDone(''); setEditing(open ? member.userId : null); }}
                onApply={(option, key) => apply(member, option, key)} workspaceName={workspaceName} />
            ))}
          </ul>
        </>
      ) : null}

      <p className="people__done" role="status">{done ? <><Icon name="check" size={13} />{done}</> : null}</p>

      {manager ? (
        roster ? (
          <GiveAccess project={project} candidates={candidates} workspaceName={workspaceName} onlyMe={roster.members.length <= 1}
            onGranted={(member, role) => changed(`${firstName(member.name)} ${role === 'contributor' ? 'can now write in' : 'can now read'} ${project.name}.`)}
            onAddPeople={() => openDetails({ kind: 'people', workspaceId: project.workspaceId })} />
        ) : rosterFailed ? (
          <p className="people__notice" role="alert"><Icon name="alert" size={13} />Who could be given access couldn’t be loaded.<button type="button" onClick={() => void load()}>Try again</button></p>
        ) : null
      ) : <p className="ov-note">Only owners and admins of {workspaceName} change who can see this.</p>}
      <p className="ov-note">Direct messages with these people stay private; nothing in them is shared with this project.</p>
    </section>
  );
}

function AccessRow({ name, label, access, options, editing, onEdit, onApply, workspaceName }: {
  name: string; label: string; access: Access | null; options: Option[]; editing: boolean;
  onEdit: (open: boolean) => void; onApply?: (option: Option, key: string) => Promise<void>; workspaceName: string;
}) {
  const editId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const close = () => { onEdit(false); changeRef.current?.focus(); };
  return (
    <li className={`people__item${editing ? ' is-editing' : ''}`}>
      <div className="people__row">
        <Avatar name={name} size="md" />
        <span className="people__who"><b>{name}</b><span className={access === null ? 'access__out' : undefined}>{label}</span></span>
        {options.length && onApply ? (
          <Button ref={changeRef} variant="quiet" className="people__change" aria-expanded={editing} aria-controls={editing ? editId : undefined} onClick={() => onEdit(!editing)}>
            Change<span className="ui-vh"> access for {name}</span>
          </Button>
        ) : null}
      </div>
      {editing && options.length && onApply
        ? <AccessEditor id={editId} name={name} options={options} onApply={onApply} onClose={close} workspaceName={workspaceName} />
        : null}
    </li>
  );
}

/**
 * One person's access: the possible changes, the exact consequence of the chosen one, then
 * confirm. Mounted fresh each time it opens, starting from the first possible change.
 */
function AccessEditor({ id, name, options, onApply, onClose, workspaceName }: {
  id: string; name: string; options: Option[]; onApply: (option: Option, key: string) => Promise<void>; onClose: () => void; workspaceName: string;
}) {
  const [choice, setChoice] = useState(options[0]!.id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const selectRef = useRef<HTMLSelectElement>(null);
  useEffect(() => { selectRef.current?.focus(); }, []);
  const option = options.find((item) => item.id === choice) ?? options[0]!;

  async function confirm() {
    if (busy) return;
    setBusy(true); setProblem('');
    try {
      await onApply(option, keys.current.for(`${name}:${option.id}`));
      keys.current.done();
    } catch (error) {
      setProblem(problemText(error, { workspace: workspaceName, who: name }));
      setBusy(false);
    }
  }

  return (
    <div className="people__edit" id={id} role="group" aria-label={`Change access for ${name}`}
      onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
      <div className="people__field">
        <label htmlFor={`${id}-to`}>Access</label>
        <select ref={selectRef} id={`${id}-to`} value={option.id} onChange={(event) => setChoice(event.target.value)} aria-describedby={`${id}-preview`}>
          {options.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </div>
      <p className="access__preview" id={`${id}-preview`}>{option.preview}</p>
      <div className="details__actions">
        <Button variant={option.danger ? 'danger' : 'primary'} busy={busy} onClick={() => void confirm()}>{option.confirm}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </div>
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
    </div>
  );
}

/** Give one workspace member access, after naming exactly who gains it and what they can do. */
function GiveAccess({ project, candidates, workspaceName, onlyMe, onGranted, onAddPeople }: {
  project: Project; candidates: WorkspaceMember[]; workspaceName: string; onlyMe: boolean;
  onGranted: (member: WorkspaceMember, role: 'contributor' | 'viewer') => void; onAddPeople: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [personId, setPersonId] = useState('');
  const [role, setRole] = useState<'contributor' | 'viewer'>('contributor');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const formId = useId();
  const selectRef = useRef<HTMLSelectElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const person = candidates.find((member) => member.userId === personId) ?? null;

  useEffect(() => { if (open) selectRef.current?.focus(); }, [open]);
  const close = () => { setOpen(false); setPersonId(''); setRole('contributor'); setProblem(''); requestAnimationFrame(() => openRef.current?.focus()); };

  async function give() {
    if (!person || busy) return;
    setBusy(true); setProblem('');
    try {
      await grantPerson(project.id, person.userId, role, keys.current.for(`${person.userId}:${role}`));
      keys.current.done();
      setOpen(false); setPersonId(''); setRole('contributor');
      onGranted(person, role);
    } catch (error) {
      setProblem(problemText(error, { workspace: workspaceName, who: person.name }));
    } finally { setBusy(false); }
  }

  const addPeople = <Button variant="link" className="access__link" onClick={onAddPeople}>{onlyMe ? `Add people to ${workspaceName}` : `Someone new? Add them to ${workspaceName} first`}</Button>;
  if (!candidates.length) {
    return (
      <div className="access__give">
        <p className="ov-note">{onlyMe ? `Nobody else is in ${workspaceName} yet.` : `Everyone in ${workspaceName} can already see this, or is kept out.`}</p>
        {addPeople}
      </div>
    );
  }
  if (!open) {
    return (
      <div className="access__give">
        <Button ref={openRef} variant="secondary" icon="plus" onClick={() => setOpen(true)}>Give someone access</Button>
      </div>
    );
  }
  return (
    <div className="access__give people__edit" role="group" aria-labelledby={`${formId}-h`} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <h4 id={`${formId}-h`} className="access__sub">Give someone access</h4>
      <div className="people__field">
        <label htmlFor={`${formId}-who`}>Person</label>
        <select ref={selectRef} id={`${formId}-who`} value={personId} onChange={(event) => { setPersonId(event.target.value); setProblem(''); }}>
          <option value="">Choose someone in {workspaceName}</option>
          {candidates.map((member) => <option key={member.userId} value={member.userId}>{member.name}{member.role === 'guest' ? ' (guest)' : ''} · {member.email}</option>)}
        </select>
      </div>
      <fieldset className="access__seg">
        <legend>Access</legend>
        <label className="access__seg-b"><input type="radio" name={`${formId}-role`} value="contributor" checked={role === 'contributor'} onChange={() => setRole('contributor')} />Can write</label>
        <label className="access__seg-b"><input type="radio" name={`${formId}-role`} value="viewer" checked={role === 'viewer'} onChange={() => setRole('viewer')} />Can read</label>
      </fieldset>
      <p className="access__preview" aria-live="polite">
        {person
          ? <><b>Only {person.name} gains access.</b> {firstName(person.name)} will be able to {role === 'contributor' ? 'read and write in' : 'read'} {project.name}{role === 'contributor' ? ': its conversations, tasks, map and wiki' : ', but not write in it'}. Nobody else is added.</>
          : 'Choose who to give access. Only that person is added.'}
      </p>
      <div className="details__actions">
        <Button variant="primary" busy={busy} disabled={!person} onClick={() => void give()}>{person ? `Give ${firstName(person.name)} access` : 'Give access'}</Button>
        <Button variant="secondary" onClick={close}>Cancel</Button>
      </div>
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
      {addPeople}
    </div>
  );
}
