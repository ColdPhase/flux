import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { EncryptedSpaceRef, IdentityCapabilities, RemovedPerson } from '@flux/contracts';
import { getCapabilities } from '../api/auth';
import { Link, useNavigate, useRevalidator, useSearchParams } from 'react-router';
import { INVITE_CREATED_EVENT, INVITE_DEFAULT_EXPIRY_DAYS, INVITE_REVOKED_EVENT, type InviteExpiryDays, type InviteRole,
  type Workspace, type WorkspaceInvite, type WorkspaceMember, type WorkspaceRole } from '@flux/contracts';
import { ApiError } from '../api/client';
import { whenPageLive } from '../api/pageLeaving';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { Avatar, Button, Icon, Input, Spinner, useRowMotion, useToast, Select, Option } from '../ui';
import { isEncryptionEvent, type EncryptedWorkspace } from '../encryption/api';
import { EncryptionSection } from '../encryption/EncryptionSection';
import { listCompanyEncryptedSpaces } from '../encryption/api';
import { ROLE_HINT, ROLE_LABEL, addMember, attemptKeys, changeRole, createInvite, firstName, getWorkspace, grantPerson, isManagerRole, listRemovedPeople, restorePerson, listInvites, listMembers, problemText, removeMember, renameCompany,
  revokeInvite } from './api';
import { DeleteSpaceDialog, type DeletableSpace } from './DeleteSpace';
import { PersonLine } from './LastActive';
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
 * The company's people (F-037, #874; #188, AC-1), as Settings › Company shows them (`page`), and, in the Details panel, the
 * people and keys of an encrypted space, which stays its own internal workspace until per-space encryption lands (F-030).
 * Everyone sees who is here and their role (guests see only their own place, as the access policy allows). Owners and
 * admins rename the company, add an existing account by email, invite with a link (only without single sign-on: with it,
 * whoever the identity provider lets in joins on their first sign-in), change roles and remove people; anyone can leave.
 * Being in the company opens Everyone; other spaces show only to the people added to them (#44).
 */
export function WorkspacePeople({ workspaceId, onBack, page = false }: { workspaceId: string; onBack: () => void; page?: boolean }) {
  const { me } = useShellData();
  const [roster, setRoster] = useState<Roster | null>(null);
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const rosterRef = useRef<HTMLHeadingElement>(null);
  const [reload, setReload] = useState(0);
  const revalidator = useRevalidator();
  // Add people in a space leads here with `?invite=1` when the person they want is not in the company yet.
  const [params] = useSearchParams();
  const [inviting, setInviting] = useState(() => params.get('invite') === '1');
  // With single sign-on as the way in, people join on their first sign-in and nobody is invited (F-037). While the provider
  // is only being prepared, password accounts still need an invite, so it counts as no provider. Undefined until it is known;
  // a failed read counts as no provider, so an admin can still add people (the server decides who may join).
  const [sso, setSso] = useState<IdentityCapabilities['sso'] | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    getCapabilities(controller.signal).then((capabilities) => setSso(capabilities.ssoOnly ? capabilities.sso : null), () => { if (!controller.signal.aborted) setSso(null); });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // A page being left starts no read (#471); one whose navigation was cancelled reads once it is live.
    const waiting = whenPageLive(() => {
      fetchRoster(workspaceId, controller.signal).then((next) => { setRoster(next); setFailed(''); }, (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setFailed(error instanceof ApiError && error.status === 404 ? 'You’re no longer in the company.' : 'The people here couldn’t be loaded. Try again.');
      });
    });
    return () => { waiting(); controller.abort(); };
  }, [workspaceId, reload]);
  const load = () => setReload((n) => n + 1);
  // F-030 (#655): a key rotation's progress has no event of its own; while one runs (or is about to) in an unlocked space, the
  // section reads it again every few seconds. It stops when the rotation finishes, pauses, stalls or the panel closes.
  const rotation = roster?.workspace.encryption?.rotation;
  // Unlocked, `paused` only means pending: the worker starts it within seconds.
  const moving = roster?.workspace.encryption?.state === 'unlocked' && !!rotation && !rotation.stalled;
  useEffect(() => {
    if (!moving) return undefined;
    const timer = window.setTimeout(() => setReload((n) => n + 1), 4000);
    return () => window.clearTimeout(timer);
  }, [moving, roster]);
  const [invitesSeen, setInvitesSeen] = useState(0);
  // Someone unlocked, locked, gave an unlock password or changed the key (F-030, #655), or added, removed or changed someone (whose
  // removal starts a key change): the rows show the state as it is now.
  useStreamEvents(me.user.id, (event) => {
    if (event.objectId !== workspaceId) return;
    if (isEncryptionEvent(event.kind) || event.kind.startsWith('workspace.member_')) load();
    // Someone joined through a link, or a link was made or revoked elsewhere (F-035).
    if (event.kind === 'workspace.member_added.v1' || event.kind === INVITE_CREATED_EVENT || event.kind === INVITE_REVOKED_EVENT) setInvitesSeen((n) => n + 1);
  }, load);

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
  // In Settings → People (#763 PE-1) the page is its own place: no way back to a panel and no panel keys.
  const back = page ? null : <button type="button" className="details__back" aria-label="Back" onClick={onBack}><Icon name="chevron-left" size={14} />Back</button>;
  if (!roster) {
    return (
      <div className={`details people${page ? ' people--page' : ''}`}>
        {back}
        <p className="details__eyebrow">{page ? 'Company' : 'Encrypted space'}</p>
        <h3 className="details__title">People</h3>
        {failed ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{failed}<Button variant="link" size="sm" onClick={load}>Try again</Button></p>
          : <div className="people__loading"><Spinner label="Loading people" /></div>}
      </div>
    );
  }

  const { workspace, members } = roster;
  const myRole = workspace.role ?? 'guest';
  const manager = isManagerRole(myRole);
  const owners = members?.filter((member) => member.role === 'owner').length ?? 0;
  const ordered = members ? [...members.filter((member) => member.userId === me.user.id), ...members.filter((member) => member.userId !== me.user.id)] : null;

  const guests = ordered?.filter((member) => member.role === 'guest') ?? [];
  // On the company's page the people come first, as drawn: one Invite above them, or with single sign-on one line saying who
  // joins. An encrypted space's panel keeps its form open above its people.
  const canAdd = !(page && sso) && sso !== undefined && manager && !!members;
  const addPerson = canAdd && members ? <AddPerson workspace={workspace} members={members} myRole={myRole} invitesSeen={invitesSeen} onJoined={load} onAdded={(member) => changed(`${member.name} joined ${workspace.name} as ${ROLE_LABEL[member.role].toLowerCase()}.`, false)} /> : null;
  return (
    <div className={`details people${page ? ' people--page' : ''}`}>
      {back}
      {page ? (
        <>
          <p className="details__lead">Everyone in {workspace.name} works in this one Flux. Only admins can change this page.</p>
          <CompanyName workspace={workspace} manager={manager} onChanged={() => { load(); revalidator.revalidate(); }} />
        </>
      ) : (
        <>
          <p className="details__eyebrow">{workspace.name}</p>
          <h3 className="details__title">People</h3>
        </>
      )}

      {!page && canAdd ? addPerson : null}

      <section className="details__sec" aria-labelledby="people-here">
        <div className="access__head">
          <h4 id="people-here" ref={rosterRef} tabIndex={-1}>{ordered ? (page ? <>People<span className="people__count"> · {ordered.length}</span></> : `In ${workspace.name} · ${ordered.length}`) : `You in ${workspace.name}`}</h4>
          {page && canAdd ? <Button variant="quiet" icon="plus" className="access__invite" aria-expanded={inviting} onClick={() => setInviting((open) => !open)}>Invite</Button> : null}
        </div>
        {page && inviting ? addPerson : null}
        {/* On the company's page the people are one card, as Settings draws its cards: the single sign-on line first, then each person. */}
        <div className={page ? 'sset-card people__card' : undefined}>
        {page && sso ? (
          <p className="people__sso" data-people-sso>
            <Icon name="key" size={14} /><span><b>Everyone who signs in with {sso.label} joins automatically</b><span>Who can sign in is managed in your identity provider.</span></span>
          </p>
        ) : null}
        {ordered ? (
          <ul className="people__list" ref={listRef} aria-label={`People in ${workspace.name}`}>
            {ordered.map((member) => (
              <MemberRow key={member.userId} member={member} self={member.userId === me.user.id} workspace={workspace} myRole={myRole} page={page}
                editable={manager && (member.role !== 'owner' || myRole === 'owner')}
                editing={editing === member.userId} onEdit={(open) => { setDone(''); setEditing(open ? member.userId : null); }}
                onChanged={(message, holderLeft) => changed(message, true, holderLeft)} />
            ))}
          </ul>
        ) : (
          <ul className="people__list">
            <li className="people__item"><div className="people__row"><Avatar name={me.user.name} id={me.user.id} size="md" tone="me" /><span className="people__who"><b>{me.user.name} (you)</b><span>{me.user.email}</span></span><span className="people__role">{ROLE_LABEL[myRole]}</span></div></li>
          </ul>
        )}
        </div>
        <p className="people__done" role="status">{done ? <><Icon name="check" size={13} />{done}</> : null}</p>
        {!manager ? (
          <p className="ov-note">{members
            ? `Only owners and admins add people or change roles in ${workspace.name}.`
            : `Guests see only the spaces they’re added to, not everyone in ${workspace.name}.`}</p>
        ) : null}
        {page && members ? (
          <p className="ov-note people__guests"><Icon name="person" size={13} />
            <span>{guests.length ? `Guests: ${guests.map((guest) => `${guest.name} (${guest.email})`).join(', ')}. ` : ''}Guests see only the spaces they’re added to and never have AI.</span></p>
        ) : null}
      </section>

      {page && manager ? <RemovedPeople workspaceId={workspace.id} reload={reload} onRestored={(name) => changed(`${name} is back in ${workspace.name}`, true)} /> : null}
      {page && manager ? <CompanySpaces workspaceId={workspace.id} /> : null}

      {/* Encrypted spaces (F-030, #655): Encryption comes before AI and keeps its place in every state; AI is off for good and has no switch. */}
      {workspace.encryption ? <EncryptionSection workspace={workspace} members={members} meId={me.user.id} myRole={myRole} offerCode={offerCode} onChanged={() => { load(); revalidator.revalidate(); }} /> : null}

      {/* An encrypted space never has AI and says so in place; the company has no AI switch (F-037: AI is per space). */}

      <Leave workspace={workspace} soleOwner={myRole === 'owner' && owners <= 1} holder={manager} onLeft={onBack} meId={me.user.id} />
      {page ? null : <p className="details__keys"><kbd>]</kbd> toggles this panel · <kbd>Esc</kbd> closes it</p>}
    </div>
  );
}

/** Who left or was removed: Restore brings them back as a member, in Everyone; other spaces are added by hand (Hubert, 2026-11-05). */
function RemovedPeople({ workspaceId, reload, onRestored }: { workspaceId: string; reload: number; onRestored: (name: string) => void }) {
  const [people, setPeople] = useState<RemovedPerson[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    const controller = new AbortController();
    listRemovedPeople(workspaceId, controller.signal).then(setPeople, () => undefined);
    return () => controller.abort();
  }, [workspaceId, reload]);
  if (!people.length) return null;
  const restore = async (person: RemovedPerson) => {
    setBusy(person.userId);
    try {
      await restorePerson(workspaceId, person.userId);
      setPeople((current) => current.filter((entry) => entry.userId !== person.userId));
      onRestored(person.name);
    } catch { toast({ message: `${person.name} couldn’t be restored. Try again.` }); }
    setBusy(null);
  };
  return (
    <section className="details__sec" aria-labelledby="people-removed">
      <h4 id="people-removed">Removed<span className="people__count"> · {people.length}</span></h4>
      <ul className="people__list sset-card" aria-label="People who were removed">
        {people.map((person) => (
          <li className="people__item" key={person.userId}><div className="people__row">
            <Avatar name={person.name} id={person.userId} size="md" /><span className="people__who"><b>{person.name}</b><span>{person.email}</span></span>
            <Button variant="quiet" className="access__invite" busy={busy === person.userId} onClick={() => void restore(person)}>Restore</Button>
          </div></li>
        ))}
      </ul>
      <p className="ov-note">Restored people sign in as usual and are in Everyone again. Add them to other spaces by hand.</p>
    </section>
  );
}

/** Every space, for the company's owners and admins: the sidebar lists only their own, and here they add themselves to the others, as its admin (#903). */
function CompanySpaces({ workspaceId }: { workspaceId: string }) {
  const { me, reachableSpaces } = useShellData();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string | null>(null);
  const toast = useToast();
  const spaces = reachableSpaces.filter((space) => space.workspaceId === workspaceId);
  const [deleting, setDeleting] = useState<DeletableSpace | null>(null);
  // The company's encrypted spaces (F-030, C-24): its owners and admins hold no key and are not in them, so a name and Delete are all
  // they get, no Add me. One they are also in is already in their own list above.
  const [sealed, setSealed] = useState<EncryptedSpaceRef[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    listCompanyEncryptedSpaces(workspaceId, controller.signal).then((list) => setSealed(list.filter((entry) => !entry.member)), () => undefined);
    return () => controller.abort();
  }, [workspaceId, reachableSpaces]);
  const join = async (spaceId: string, spaceName: string) => {
    setBusy(spaceId);
    try {
      await grantPerson(spaceId, me.user.id, 'manager', crypto.randomUUID());
      revalidator.revalidate();
    } catch { toast({ message: `You couldn’t be added to ${spaceName}. Try again.` }); }
    setBusy(null);
  };
  return (
    <section className="details__sec" aria-labelledby="company-spaces">
      <h4 id="company-spaces">Spaces<span className="people__count"> · {spaces.length + sealed.length}</span></h4>
      <ul className="people__list sset-card" aria-label="Every space in the company">
        {spaces.map((space) => (
          <li className="people__item" key={space.id}><div className="people__row">
            <span className="people__who"><b>{space.member === false ? space.name : <Link to={`/projects/${space.id}`}>{space.name}</Link>}</b></span>
            {space.member === false ? <Button variant="quiet" className="access__invite" busy={busy === space.id} aria-label={`Add me to ${space.name}`} onClick={() => void join(space.id, space.name)}>Add me</Button> : null}
            {/* Everyone holds the whole company and cannot be deleted; any other space can be, with a confirmation that names it (F-037). */}
            {space.visibility === 'workspace' ? null : <Button variant="quiet" className="access__invite" aria-label={`Delete ${space.name}`} onClick={() => setDeleting({ id: space.id, name: space.name })}>Delete…</Button>}
          </div></li>
        ))}
        {sealed.map((entry) => (
          <li className="people__item" key={entry.id} data-encrypted-space={entry.id}><div className="people__row">
            <span className="people__who"><b><Icon name="lock" size={13} /> {entry.name}</b><span>Encrypted · made {madeOn.format(new Date(entry.createdAt))} · you can delete it, not open it</span></span>
            <Button variant="quiet" className="access__invite" aria-label={`Delete ${entry.name}`} onClick={() => setDeleting({ id: entry.id, name: entry.name, encrypted: true })}>Delete…</Button>
          </div></li>
        ))}
      </ul>
      <DeleteSpaceDialog space={deleting} onClose={() => setDeleting(null)} onDeleted={(_id, name) => { setDeleting(null); toast({ message: `${name} was deleted.` }); revalidator.revalidate(); }} />
    </section>
  );
}

/** The company's name (Settings › Company): shown on the sign-in page and in emails; owners and admins change it in place. */
function CompanyName({ workspace, manager, onChanged }: { workspace: Workspace; manager: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const changeRef = useRef<HTMLButtonElement>(null);
  const close = () => { setEditing(false); setProblem(''); requestAnimationFrame(() => changeRef.current?.focus({ preventScroll: true })); };
  async function save(event: FormEvent) {
    event.preventDefault();
    const next = value.trim();
    if (!next) { setProblem('Give the company a name.'); return; }
    if (busy) return;
    if (next === workspace.name) { close(); return; }
    setBusy(true); setProblem('');
    try {
      await renameCompany(workspace.id, next, keys.current.for(next));
      keys.current.done();
      close();
      onChanged();
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name }));
    } finally { setBusy(false); }
  }
  return (
    <section className="details__sec" aria-labelledby="company-name">
      <h4 id="company-name">Name</h4>
      {editing ? (
        <form className="people__add sset-card people__nameform" onSubmit={(event) => void save(event)} noValidate aria-label="Change the company name"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
          <Input id="company-name-input" label="Company name" value={value} maxLength={200} autoFocus onChange={(event) => { setValue(event.target.value); setProblem(''); }}
            error={problem || undefined} hint="Shown on the sign-in page and in emails." />
          <div className="details__actions">
            <Button type="submit" variant="primary" busy={busy}>Save name</Button>
            <Button variant="secondary" onClick={close}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="sset-card"><div className="people__row people__name">
          <span className="people__who"><b>{workspace.name}</b><span>Shown on the sign-in page and in emails</span></span>
          {manager ? <Button ref={changeRef} variant="quiet" size="sm" className="people__change" onClick={() => { setValue(workspace.name); setEditing(true); }}>Change<span className="ui-vh"> the company name</span></Button> : null}
        </div></div>
      )}
    </section>
  );
}

function AddPerson({ workspace, members, myRole, invitesSeen, onJoined, onAdded }: { workspace: Workspace; members: WorkspaceMember[]; myRole: WorkspaceRole;
  invitesSeen: number; onJoined: () => void; onAdded: (member: WorkspaceMember) => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('member');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [newcomer, setNewcomer] = useState('');
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
      if (error instanceof ApiError && error.code === 'ACCOUNT_NOT_FOUND') setNewcomer(address);
      const known = error instanceof ApiError && error.code === 'ALREADY_MEMBER' ? members.find((member) => member.email.toLowerCase() === address)?.name : undefined;
      setProblem(problemText(error, { workspace: workspace.name, email: address, who: known }));
      emailRef.current?.focus();
    } finally { setBusy(false); }
  }

  return (
    <>
    <section className="details__sec" aria-labelledby="people-add">
      <h4 id="people-add">Add someone</h4>
      <form className="people__add" onSubmit={(event) => void submit(event)} noValidate>
        <Input ref={emailRef} id="people-add-email" label="Email" type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="name@example.com" value={email}
          aria-invalid={problem ? true : undefined} aria-describedby={problem ? 'people-add-problem people-add-email-hint' : 'people-add-email-hint'}
          onChange={(event) => { setEmail(event.target.value); if (problem) setProblem(''); }}
          hint="Their Flux account’s address. Someone new? Create an invite link below." />
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
      {/* Someone without an account (#763 PE-2): the address Flux could not find is filled into the invite link (F-035). */}
      {/* An encrypted space takes only the company's people, never a link (C-24). */}
      {workspace.spaceOf ? null : <InviteLinks key={newcomer} prefill={newcomer} workspace={workspace} myRole={myRole} seen={invitesSeen} onJoined={onJoined} />}
    </>
  );
}

function MemberRow({ member, self, workspace, myRole, page, editable, editing, onEdit, onChanged }: {
  member: WorkspaceMember; self: boolean; workspace: EncryptedWorkspace; myRole: WorkspaceRole; page: boolean; editable: boolean;
  editing: boolean; onEdit: (open: boolean) => void; onChanged: (message: string, holderLeft?: boolean) => void;
}) {
  const editId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const close = () => { onEdit(false); changeRef.current?.focus(); };
  return (
    <li className={`people__item${editing ? ' is-editing' : ''}`} data-row-key={member.userId}>
      <div className="people__row">
        <Avatar name={member.name} id={member.userId} size="md" tone={self ? 'me' : 'neutral'} />
        <span className="people__who"><b>{member.name}{self ? ' (you)' : ''}</b><PersonLine email={member.email} lastActiveAt={self ? undefined : member.lastActiveAt} /></span>
        {/* On the company's page the role is the control: "Admin ▾" opens the same editor under the row. */}
        {page && editable ? (
          <Button ref={changeRef} variant="quiet" className="people__rolebtn" aria-expanded={editing} aria-controls={editing ? editId : undefined} aria-label={`Change ${self ? 'your role' : member.name}, ${ROLE_LABEL[member.role]}`}
            onClick={() => onEdit(!editing)}>{ROLE_LABEL[member.role]}<Icon name="chevron-down" size={14} /></Button>
        ) : <span className="people__role">{ROLE_LABEL[member.role]}</span>}
        {!page && editable ? (
          <Button ref={changeRef} variant="quiet" size="sm" className="people__change" aria-expanded={editing} aria-controls={editing ? editId : undefined} onClick={() => onEdit(!editing)}>
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
        <Button variant={confirm === 'demote' ? 'secondary' : 'primary'} busy={busy === 'role'} disabled={role === member.role} onClick={() => (demoting ? setConfirm('demote') : void saveRole())}>Save role</Button>
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
              <Button variant="danger" busy={busy === 'remove'} onClick={() => void remove()}>Remove {first}</Button>
              <Button variant="quiet" onClick={() => setConfirm(null)}>Keep {first}</Button>
            </div>
          </div>
        ) : (
          <div className="details__confirm people__confirm" role="group" aria-label={`Remove ${member.name}`}>
            <p>{first} loses access to {workspace.name} at once: its spaces, and anything given to them there.</p>
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

const expiryLabel: Record<InviteExpiryDays, string> = { 1: '1 day', 7: '7 days', 30: '30 days' };
const until = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const madeOn = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const inviteRoles = (mine: WorkspaceRole): InviteRole[] => (mine === 'owner' ? ['member', 'guest', 'admin'] : ['member', 'guest']);

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/**
 * Invite links (F-035, #763 PE-2): an owner or admin makes a one-time link with a role, optionally for one address,
 * and sends it themselves (Flux sends no email). The new link shows once at the top, ready to copy; every pending link
 * stays listed with Copy and Revoke. Whoever opens it signs in or creates an account and joins with that role.
 */
function InviteLinks({ prefill, workspace, myRole, seen, onJoined }: { prefill: string; workspace: Workspace; myRole: WorkspaceRole; seen: number; onJoined: () => void }) {
  const [revoking, setRevoking] = useState<string | null>(null);
  const [invites, setInvites] = useState<WorkspaceInvite[] | null>(null);
  const [role, setRole] = useState<InviteRole>('member');
  const [email, setEmail] = useState(prefill);
  const [days, setDays] = useState<InviteExpiryDays>(INVITE_DEFAULT_EXPIRY_DAYS);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [fresh, setFresh] = useState<WorkspaceInvite | null>(null);
  const [status, setStatus] = useState('');
  const keys = useRef(attemptKeys());
  const roleId = useId();
  const daysId = useId();
  const linkRef = useRef<HTMLInputElement>(null);
  const encrypted = workspace.encryption !== null && workspace.encryption !== undefined;

  useEffect(() => {
    const controller = new AbortController();
    listInvites(workspace.id, controller.signal).then(setInvites, (error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setInvites([]);
    });
    if (seen) onJoined();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `seen` is the trigger; `onJoined` reloads the roster.
  }, [workspace.id, seen]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    if (address && !/^[^\s@]+@[^\s@]+$/.test(address)) { setProblem('Enter an email address, or leave it empty for anyone with the link.'); return; }
    setBusy(true); setProblem(''); setStatus('');
    try {
      const invite = await createInvite(workspace.id, { role, email: address || null, expiresInDays: days }, keys.current.for(`${role}:${address}:${days}`));
      keys.current.done();
      setFresh(invite);
      setInvites((list) => [invite, ...(list ?? []).filter((item) => item.id !== invite.id)]);
      setEmail('');
      const copied = await copyText(invite.link);
      setStatus(copied ? 'Invite link created and copied. Send it to them yourself.' : 'Invite link created. Copy it and send it to them yourself.');
      requestAnimationFrame(() => linkRef.current?.select());
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name, email: address }));
    } finally { setBusy(false); }
  }

  async function copy(invite: WorkspaceInvite) {
    setStatus(await copyText(invite.link) ? 'Link copied.' : 'Copying isn’t allowed here. Select the link and copy it.');
    if (fresh?.id !== invite.id) setFresh(invite);
  }

  async function revoke(invite: WorkspaceInvite) {
    setProblem(''); setStatus('');
    try {
      await revokeInvite(workspace.id, invite.id);
      setStatus('Invite link revoked. It no longer works.');
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name }));
    }
    if (fresh?.id === invite.id) setFresh(null);
    setInvites((list) => (list ?? []).filter((item) => item.id !== invite.id));
  }

  const who = (invite: WorkspaceInvite) => invite.email ?? 'Anyone with the link';
  return (
    <section className="details__sec" aria-labelledby="people-invite">
      <h4 id="people-invite">Invite with a link</h4>
      <form className="people__add" onSubmit={(event) => void create(event)} noValidate aria-label="Create an invite link">
        <div className="people__field">
          <label htmlFor={roleId}>Joins as</label>
          <Select id={roleId} value={role} onChange={(next) => setRole(next as InviteRole)} aria-describedby={`${roleId}-hint`}>
            {inviteRoles(myRole).map((option) => <Option key={option} value={option}>{ROLE_LABEL[option]}</Option>)}
          </Select>
          <p className="people__hint" id={`${roleId}-hint`}>{ROLE_HINT[role]}{encrypted && role === 'admin' ? ' To unlock this encrypted space, they also need an unlock password from someone who has one.' : ''}</p>
        </div>
        <Input id="people-invite-email" label="Only for (optional)" type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="name@example.com" value={email}
          onChange={(event) => { setEmail(event.target.value); if (problem) setProblem(''); }}
          hint="Leave empty and anyone who opens the link first can join." />
        <div className="people__field">
          <label htmlFor={daysId}>Works for</label>
          <Select id={daysId} value={String(days)} onChange={(next) => setDays(Number(next) as InviteExpiryDays)}>
            {([1, 7, 30] as const).map((option) => <Option key={option} value={String(option)}>{expiryLabel[option]}</Option>)}
          </Select>
        </div>
        {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
        <div className="details__actions"><Button type="submit" variant="secondary" busy={busy}><Icon name="link" size={14} />Create invite link</Button></div>
      </form>
      {fresh ? (
        <div className="people__link" role="group" aria-label="New invite link">
          <Input ref={linkRef} id="people-invite-link" label={`Link for ${fresh.email ?? 'anyone'} · ${ROLE_LABEL[fresh.role].toLowerCase()}`} readOnly value={fresh.link}
            onFocus={(event) => event.currentTarget.select()} hint="It works once. Flux doesn’t send it: paste it into your message to them." />
          <div className="details__actions"><Button variant="secondary" onClick={() => void copy(fresh)}><Icon name="copy" size={14} />Copy link</Button></div>
        </div>
      ) : null}
      <p className="people__invite-status" role="status">{status ? <><Icon name="check" size={13} />{status}</> : null}</p>
      {invites && invites.length ? (
        <>
          <h4 className="people__sub" id="people-invites-pending">Waiting to be used · {invites.length}</h4>
          <ul className="people__list" aria-labelledby="people-invites-pending">
            {invites.map((invite) => (
              <li className="people__item" key={invite.id}>
                <div className="people__row">
                  <span className="people__who"><b>{who(invite)}</b><span>{ROLE_LABEL[invite.role]} · until {until.format(new Date(invite.expiresAt))} · by {invite.createdBy.name}</span></span>
                  <Button variant="quiet" className="people__change" onClick={() => void copy(invite)}>Copy<span className="ui-vh"> link for {who(invite)}</span></Button>
                  {invite.role !== 'admin' || myRole === 'owner'
                    ? <Button variant="quiet" className="people__change" aria-expanded={revoking === invite.id} onClick={() => setRevoking(revoking === invite.id ? null : invite.id)}>Revoke<span className="ui-vh"> link for {who(invite)}</span></Button> : null}
                </div>
                {/* #763 FT-13: a revoked link can't come back, so Revoke asks once, in place. */}
                {revoking === invite.id ? (
                  <div className="people__edit" role="group" aria-label={`Revoke link for ${who(invite)}`} onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); setRevoking(null); } }}>
                    <p className="access__preview">The link stops working at once and can’t be restored. You can make a new one.</p>
                    <div className="details__actions">
                      <Button variant="danger" onClick={() => { setRevoking(null); void revoke(invite); }}>Revoke link</Button>
                      <Button variant="secondary" onClick={() => setRevoking(null)}>Keep it</Button>
                    </div>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
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
            <p>You lose access to {workspace.name} and its spaces at once. Someone has to add you again to come back.</p>
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
