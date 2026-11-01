import { useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { whenPageLive } from '../api/pageLeaving';
import { useRevalidator } from 'react-router';
import type { Project, ProjectAccess as Access, ProjectGrant, ProjectGrantRole, ProjectPerson, WorkspaceMember } from '@flux/contracts';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { AgentTag, Avatar, Button, Icon, Kreska, prefersReducedMotion, useRowMotion, Select, Option } from '../ui';
import { ROLE_LABEL, attemptKeys, firstName, grantPerson, isManagerRole, levelFor, listGrants, listMembers, problemText, revokeGrant } from './api';
import { AgentRequests } from './AgentRequests';
import './people.css';
import { useWorkspaceEncryption } from '../encryption/state';

/** Each person's role in one or two words. */
const ROLE_SHORT: Record<Access, string> = { manager: 'Manages', contributor: 'Can write', viewer: 'Can read' };

/** A change to one person's access: set a grant, or remove it. */
type Change = { kind: 'grant'; role: ProjectGrantRole } | { kind: 'revoke' };
interface Option { id: string; label: string; change: Change; confirm: string; preview: string; danger?: boolean }

interface Roster { members: WorkspaceMember[]; grants: ProjectGrant[] }

/**
 * "People" for a project (#188, AC-2; #512, AC-5): exactly who can open it now, read from the server's
 * access policy, each with their role, and in one sentence who else can. Owners and admins of the workspace (the project's managers) give a
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
  const [managing, setManaging] = useState(false);
  const [giving, setGiving] = useState(false);
  const inviteRef = useRef<HTMLButtonElement>(null);
  const [done, setDone] = useState('');
  const manager = project.access === 'manager';
  const workspaceName = workspaces.find((space) => space.id === project.workspaceId)?.name ?? 'this workspace';

  // Managers also read the workspace's members and the project's grants: who could be given access.
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!manager) return;
    const controller = new AbortController();
    // A page being left starts no read (#471); one whose navigation was cancelled reads once it is live.
    const waiting = whenPageLive(() => {
      Promise.all([listMembers(project.workspaceId, controller.signal), listGrants(project.id, controller.signal)]).then(([members, grants]) => {
        setRoster({ members, grants }); setRosterFailed(false);
      }, (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRosterFailed(true);
      });
    });
    return () => { waiting(); controller.abort(); };
  }, [manager, project.id, project.workspaceId, reload]);
  const load = () => setReload((n) => n + 1);

  // The header's audience line (and a new project) lead here: bring the section into view.
  useEffect(() => {
    if (!focusToken) return;
    const frame = requestAnimationFrame(() => {
      headingRef.current?.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusToken]);

  const changed = (message: string) => {
    setDone(message); setEditing(null);
    load();
    revalidator.revalidate();
    // The editor that had focus is gone: focus the section, whose status line says what changed.
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  };

  const myRole = roster?.members.find((member) => member.userId === me.user.id)?.role ?? null;
  const memberOf = (id: string) => roster?.members.find((member) => member.userId === id) ?? null;
  const grantOf = (id: string) => roster?.grants.find((grant) => grant.principal.kind === 'human' && grant.principal.id === id) ?? null;
  const others = (people ?? []).filter((person) => !(person.kind === 'human' && person.id === me.user.id));
  const listRef = useRef<HTMLUListElement>(null);
  // Access given or taken back grows or collapses the row where it stands (#593 AC-4).
  useRowMotion(listRef, '.people__item[data-row-key]', (el) => el.dataset.rowKey, `${project.id}|${people ? 'ready' : 'loading'}`);
  const keptOut = roster ? roster.grants.filter((grant) => grant.role === 'denied' && grant.principal.kind === 'human').map((grant) => ({ grant, member: memberOf(grant.principal.id) })).filter((row): row is { grant: ProjectGrant; member: WorkspaceMember } => !!row.member) : [];
  const candidates = roster ? roster.members.filter((member) => member.userId !== me.user.id && grantOf(member.userId)?.role !== 'denied'
    && levelFor(member.role, project.visibility, grantOf(member.userId)?.role ?? null) === null) : [];

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
    // For someone kept out, the safe first choice is letting them back in, not granting write access.
    return current === 'denied' ? [options[options.length - 1]!, ...options.slice(0, -1)] : options;
  };

  const apply = async (member: WorkspaceMember, option: Option, key: string) => {
    const grant = grantOf(member.userId);
    try {
      if (option.change.kind === 'revoke') {
        if (grant) await revokeGrant(project.id, grant.id);
      } else {
        await grantPerson(project.id, member.userId, option.change.role, key);
      }
    } catch (error) {
      // Someone changed this access meanwhile: the list shows it as it is now, as the message says.
      if (error instanceof ApiError && (error.code === 'GRANT_NOT_FOUND' || error.code === 'GRANT_CONFLICT')) load();
      throw error;
    }
    const first = firstName(member.name);
    changed(option.id === 'denied' ? `${first} is kept out of ${project.name}.`
      : option.id === 'revoke' ? (grant?.role === 'denied' ? `${first} is no longer kept out.` : `${first}’s access was removed.`)
        : `${first} ${option.id === 'contributor' ? 'can now write in' : 'can now read'} ${project.name}.`);
  };

  const restricted = project.visibility === 'restricted';
  const encrypted = !!useWorkspaceEncryption(project.workspaceId);
  const meRow = <li className="people__item"><div className="people__row"><Avatar name={me.user.name} size="md" tone="me" /><span className="people__who"><b>{me.user.name} <span className="people__you">· you</span></b></span><span className="people__role">{ROLE_SHORT[project.access]}</span></div></li>;
  // Invite: someone already in the space is given access here; someone new is first added to the space.
  const invite = () => {
    if (!roster) return;
    if (!candidates.length) { openDetails({ kind: 'people', workspaceId: project.workspaceId, project: { id: project.id, name: project.name } }); return; }
    setGiving((open) => !open);
  };

  return (
    <section className="details__sec access" aria-labelledby="ov-people">
      <div className="access__head">
        <h4 id="ov-people" ref={headingRef} tabIndex={-1}>People</h4>
        {manager ? <Button ref={inviteRef} variant="quiet" icon="plus" className="access__invite" disabled={!roster} aria-expanded={giving} onClick={invite}>Invite</Button> : null}
      </div>
      {people ? (
        <ul className="people__list" ref={listRef} aria-label={`People who can see ${project.name}`}>
          {meRow}
          {others.map((person) => {
            const member = person.kind === 'human' ? memberOf(person.id) : null;
            const options = member && manager && managing ? optionsFor(member) : [];
            return (
              <AccessRow key={`${person.kind}:${person.id}`} rowKey={`${person.kind}:${person.id}`} name={person.name} agent={person.kind === 'agent'}
                label={ROLE_SHORT[person.access]} access={person.access}
                options={options} editing={editing === person.id} onEdit={(open) => { setDone(''); setEditing(open ? person.id : null); }}
                onApply={member ? (option, key) => apply(member, option, key) : undefined} workspaceName={workspaceName} />
            );
          })}
        </ul>
      ) : <p>Everyone with access to {project.name}.</p>}

      {/* #763 FT-1: agents whose owners asked to bring them in; managers answer here. */}
      <AgentRequests project={project} onChanged={changed} />

      {manager && managing && keptOut.length ? (
        <>
          <h4 className="access__sub" id="ov-kept-out">Kept out</h4>
          <ul className="people__list" aria-labelledby="ov-kept-out">
            {keptOut.map(({ member }) => (
              <AccessRow key={member.userId} name={member.name} label="Kept out" note={`${ROLE_LABEL[member.role]} of ${workspaceName}`} access={null}
                options={optionsFor(member)} editing={editing === member.userId} onEdit={(open) => { setDone(''); setEditing(open ? member.userId : null); }}
                onApply={(option, key) => apply(member, option, key)} workspaceName={workspaceName} />
            ))}
          </ul>
        </>
      ) : null}

      {/* #763 FT-7: Change access with nobody else here says so and offers Invite, instead of doing nothing. */}
      {manager && managing && roster && !others.length && !keptOut.length ? (
        <p className="access__alone">Nobody else can open {project.name} yet. <Button variant="link" onClick={invite}>Invite someone</Button></p>
      ) : null}
      <p className="people__done" role="status">{done ? <><Icon name="check" size={13} />{done}</> : null}</p>

      {manager && rosterFailed && !roster ? (
        <p className="people__notice" role="alert"><Icon name="alert" size={13} />Who could be given access couldn’t be loaded.<button type="button" onClick={load}>Try again</button></p>
      ) : null}
      {manager && roster ? (
        <GiveAccess project={project} candidates={candidates} workspaceName={workspaceName} open={giving}
          onClose={() => { setGiving(false); requestAnimationFrame(() => inviteRef.current?.focus()); }}
          onGranted={(member, role) => { setGiving(false); changed(`${firstName(member.name)} ${role === 'contributor' ? 'can now write in' : 'can now read'} ${project.name}.`); }}
          onAddPeople={() => openDetails({ kind: 'people', workspaceId: project.workspaceId, project: { id: project.id, name: project.name } })} />
      ) : null}

      {/* Who can open it, in one sentence; its managers change it from here. */}
      <p className="access__line">
        <Icon name={restricted ? 'lock' : 'people'} size={13} />
        <span>{restricted ? 'Only the people listed here can open it.' : `Everyone in ${workspaceName} can open it; guests only by invitation.`}
          {manager ? <> <Button variant="link" className="access__change" aria-expanded={managing} onClick={() => { setManaging((on) => !on); setEditing(null); setDone(''); }}>Change access</Button></> : null}</span>
      </p>
      {/* F-030 (#655): an encrypted space says so in the audience section, in one line. */}
      {encrypted ? <p className="access__line" data-encrypted-line=""><Icon name="lock" size={13} /><span>Encrypted space · only people work here, no AI.</span></p> : null}
    </section>
  );
}

function AccessRow({ rowKey, name, agent = false, label, note, access, options, editing, onEdit, onApply, workspaceName }: {
  rowKey?: string; name: string; agent?: boolean; label: string; note?: string; access: Access | null; options: Option[]; editing: boolean;
  onEdit: (open: boolean) => void; onApply?: (option: Option, key: string) => Promise<void>; workspaceName: string;
}) {
  const editId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const close = () => { onEdit(false); changeRef.current?.focus(); };
  return (
    <li className={`people__item${editing ? ' is-editing' : ''}`} data-row-key={rowKey}>
      <div className="people__row">
        {agent ? <Kreska size={26} /> : <Avatar name={name} size="md" />}
        <span className="people__who"><b>{name}{agent ? <> <AgentTag /></> : null}</b>{note ? <span>{note}</span> : null}</span>
        <span className={`people__role${access === null ? ' access__out' : ''}`}>{label}</span>
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
  const selectRef = useRef<HTMLButtonElement>(null);
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
        <Select ref={selectRef} id={`${id}-to`} value={option.id} onChange={(next) => setChoice(next)} aria-describedby={`${id}-preview`}>
          {options.map((item) => <Option key={item.id} value={item.id}>{item.label}</Option>)}
        </Select>
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

/** Give one workspace member access, after naming exactly who gains it and what they can do. Invite opens it. */
function GiveAccess({ project, candidates, workspaceName, open, onClose, onGranted, onAddPeople }: {
  project: Project; candidates: WorkspaceMember[]; workspaceName: string; open: boolean; onClose: () => void;
  onGranted: (member: WorkspaceMember, role: 'contributor' | 'viewer') => void; onAddPeople: () => void;
}) {
  const [personId, setPersonId] = useState('');
  const [role, setRole] = useState<'contributor' | 'viewer'>('contributor');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const formId = useId();
  const selectRef = useRef<HTMLButtonElement>(null);
  const person = candidates.find((member) => member.userId === personId) ?? null;

  useEffect(() => { if (open) selectRef.current?.focus(); }, [open]);
  const reset = () => { setPersonId(''); setRole('contributor'); setProblem(''); };
  const close = () => { reset(); onClose(); };

  async function give() {
    if (!person || busy) return;
    setBusy(true); setProblem('');
    try {
      await grantPerson(project.id, person.userId, role, keys.current.for(`${person.userId}:${role}`));
      keys.current.done();
      reset();
      onGranted(person, role);
    } catch (error) {
      setProblem(problemText(error, { workspace: workspaceName, who: person.name }));
    } finally { setBusy(false); }
  }

  if (!open) return null;
  return (
    <div className="access__give people__edit" role="group" aria-labelledby={`${formId}-h`} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
      <h4 id={`${formId}-h`} className="access__sub">Give someone access</h4>
      <div className="people__field">
        <label htmlFor={`${formId}-who`}>Person</label>
        <Select ref={selectRef} id={`${formId}-who`} value={personId} onChange={(next) => { setPersonId(next); setProblem(''); }}>
          <Option value="">Choose someone in {workspaceName}</Option>
          {candidates.map((member) => <Option key={member.userId} value={member.userId}>{member.name}{member.role === 'guest' ? ' (guest)' : ''} · {member.email}</Option>)}
        </Select>
      </div>
      <fieldset className="access__seg">
        <legend>Access</legend>
        <div className="access__seg-track">
          <label className="access__seg-b"><input type="radio" name={`${formId}-role`} value="contributor" checked={role === 'contributor'} onChange={() => setRole('contributor')} />Can write</label>
          <label className="access__seg-b"><input type="radio" name={`${formId}-role`} value="viewer" checked={role === 'viewer'} onChange={() => setRole('viewer')} />Can read</label>
        </div>
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
      <Button variant="link" className="access__link" onClick={onAddPeople}>Someone new? Add them to {workspaceName} first</Button>
    </div>
  );
}
