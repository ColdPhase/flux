import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { EncryptedSpaceRef, IdentityCapabilities, RemovedPerson } from '@flux/contracts';
import { getCapabilities } from '../api/auth';
import { Link, useNavigate, useRevalidator, useSearchParams } from 'react-router';
import { INVITE_CREATED_EVENT, INVITE_DEFAULT_EXPIRY_DAYS, INVITE_REVOKED_EVENT, type InviteExpiryDays, type InviteRole,
  type Workspace, type WorkspaceInvite, type WorkspaceMember, type WorkspaceRole } from '@flux/contracts';
import { ApiError } from '../api/client';
import { whenPageLive } from '../api/pageLeaving';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { Avatar, Button, Icon, Input, Spinner, useFocusBack, useRowMotion, useToast, Select, Option } from '../ui';
import { SpaceFace } from '../ui/SpaceFace';
import { isEncryptionEvent, type EncryptedWorkspace } from '../encryption/api';
import { EncryptionSection } from '../encryption/EncryptionSection';
import { listCompanyEncryptedSpaces } from '../encryption/api';
import { ROLE_HINT, ROLE_LABEL, addMember, attemptKeys, changeRole, createInvite, firstName, getWorkspace, grantPerson, isManagerRole, listRemovedPeople, restorePerson, listInvites, listMembers, makeResetLink, problemText, removeMember, renameCompany,
  keepPlaces, peopleOrder, revokeInvite } from './api';
import { DeleteSpaceDialog, type DeletableSpace } from './DeleteSpace';
import { PersonLine } from './LastActive';
import './people.css';
import { awaitField, focusField } from '../ui/keys';

// Roles from the most to the least (personas-27): Owner, Admin, Member, Guest, in every menu of roles.
const ROLES: WorkspaceRole[] = ['owner', 'admin', 'member', 'guest'];
/** Roles the caller may hand out: only an owner grants or changes the owner role (#29). */
const assignable = (mine: WorkspaceRole) => ROLES.filter((role) => role !== 'owner' || mine === 'owner');
const article = (value: WorkspaceRole) => (value === 'admin' || value === 'owner' ? 'an' : 'a');

type Roster = { workspace: EncryptedWorkspace; members: WorkspaceMember[] | null };
/** An owner or admin who reads the company's people (and so may make and list its links). */
const canInvite = (roster: Roster | null) => !!roster?.members && isManagerRole(roster.workspace.role ?? 'guest');

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
  // The order the rows were drawn in: a row keeps its place while the page is open (personas-33: Admin chosen for someone moved their row
  // under the pointer). Someone who joins meanwhile comes after them; the next visit sorts by role again.
  const [drawn, setDrawn] = useState<{ members: WorkspaceMember[] | null; order: string[] }>({ members: null, order: [] });
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [done, setDone] = useState('');
  const rosterRef = useRef<HTMLHeadingElement>(null);
  const [reload, setReload] = useState(0);
  const revalidator = useRevalidator();
  // Home's first steps lead here with `?invite=1` (Invite people) or `?name=1` (Name your company), #1438.
  const [params, setParams] = useSearchParams();
  const [inviting, setInviting] = useState(() => params.get('invite') === '1');
  const inviteRef = useRef<HTMLButtonElement>(null);
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
  // The company's links waiting to be used, listed under its people whether or not Invite is open (#1424, persona B-5).
  const links = useInviteLinks(workspaceId, page && canInvite(roster) && sso === null, invitesSeen, load);
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
  // Where focus goes once the roster is read again after a change (F-026 §4): the changed person's row, or the row after the one that went.
  const focusAfter = useRef<{ userId: string; order: string[] } | null>(null);
  const changed = (message: string, editorClosed: boolean, holderLeft = false, userId: string | null = editing) => {
    setDone(message); setEditing(null);
    load();
    const offering = holderLeft && roster?.workspace.encryption?.state === 'unlocked' && roster.workspace.role === 'owner';
    if (offering) setOfferCode((count) => count + 1);
    // A member's editor that had focus is gone: focus goes to that person's row, or, when they left the list, to the next row's control,
    // in view (persona round 28: the roster's heading was off screen after Restore). Adding someone leaves focus where it is, in the form the
    // person may fill again at once: a focus move one frame later took the keystrokes of the next address (#491).
    if (editorClosed && !offering && userId) focusAfter.current = { userId, order: [...document.querySelectorAll<HTMLElement>('.people__list [data-person]')].map((row) => row.dataset.person!) };
    else if (editorClosed && !offering) requestAnimationFrame(() => rosterRef.current?.focus({ preventScroll: true }));
    // Roles change what the sidebar may list for the caller.
    revalidator.revalidate();
  };

  useEffect(() => {
    const wanted = focusAfter.current;
    if (!wanted || !roster) return;
    focusAfter.current = null;
    requestAnimationFrame(() => {
      // A person still listed whose row has the focus (a role changed in place) keeps it there.
      if (document.activeElement?.closest(`.people__list [data-person="${CSS.escape(wanted.userId)}"]`)) return;
      // The row's first control (its role, or Change, Reset link, Remove), in view (persona round 29: Company rows have no Change any more).
      const control = (id: string) => [...document.querySelectorAll<HTMLElement>(`.people__list [data-person="${CSS.escape(id)}"] :is(select, button, [role="combobox"])`)]
        .find((element) => !(element as HTMLButtonElement).disabled && element.getClientRects().length > 0) ?? null;
      const at = wanted.order.indexOf(wanted.userId);
      const next = [wanted.userId, ...wanted.order.slice(at + 1), ...wanted.order.slice(0, Math.max(0, at)).reverse()].map(control).find(Boolean);
      if (next) next.focus(); else rosterRef.current?.focus();
    });
  }, [roster]);

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
  const ordered = members ? keepPlaces(drawn.order, [...members].sort(peopleOrder(me.user.id, (member: WorkspaceMember) => ROLE_LABEL[member.role]))) : null;
  if (members && ordered && drawn.members !== members) setDrawn({ members, order: ordered.map((member) => member.userId) });

  const guests = ordered?.filter((member) => member.role === 'guest') ?? [];
  // On the company's page the people come first, as drawn: one Invite above them, or with single sign-on one line saying who
  // joins. An encrypted space's panel keeps its form open above its people.
  const canAdd = !(page && sso) && sso !== undefined && manager && !!members;
  // Close puts the form away with what it said: the new link stays listed under Waiting to be used, without its sentence (#1424).
  const closeInvite = () => {
    setInviting(false); links.setFresh(null); links.setStatus(''); requestAnimationFrame(() => inviteRef.current?.focus());
    // Home's "Invite people" (`?invite=1`) is done with once the form closes: the address no longer opens it (persona round 29).
    if (params.has('invite')) setParams((current) => { const next = new URLSearchParams(current); next.delete('invite'); return next; }, { replace: true });
  };
  const onAdded = (member: WorkspaceMember) => changed(`${member.name} joined ${workspace.name} as ${ROLE_LABEL[member.role].toLowerCase()}.`, false);
  // #1438: the company's page has one invite form; an encrypted space's panel adds people of the company by email, never by a link (C-24).
  const addPerson = canAdd && members ? (page
    ? <InviteForm workspace={workspace} members={members} myRole={myRole} links={links} onAdded={onAdded} onClose={closeInvite} />
    : <AddPerson workspace={workspace} members={members} myRole={myRole} onAdded={onAdded} />) : null;
  return (
    <div className={`details people${page ? ' people--page' : ''}`}>
      {back}
      {page ? (
        <>
          <p className="details__lead">Everyone in {workspace.name} works in this one Flux. Only admins can change this page.</p>
          <CompanyName workspace={workspace} manager={manager} startEditing={params.get('name') === '1'} onChanged={() => { load(); revalidator.revalidate(); }}
            onClosed={() => { if (params.has('name')) setParams((current) => { const next = new URLSearchParams(current); next.delete('name'); return next; }, { replace: true }); }} />
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
          <h4 id="people-here" ref={rosterRef} tabIndex={-1}>{ordered ? (page ? <>People <span className="people__count">{ordered.length}</span></> : `In ${workspace.name} · ${ordered.length}`) : `You in ${workspace.name}`}</h4>
          {page && canAdd ? <Button ref={inviteRef} variant="quiet" icon="plus" className="access__invite" aria-expanded={inviting} onClick={() => { if (inviting) { closeInvite(); return; } if (!window.matchMedia('(hover: none)').matches) awaitField(); setInviting(true); }}>Invite</Button> : null}
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
              <MemberRow key={member.userId} member={member} self={member.userId === me.user.id} workspace={workspace} myRole={myRole} page={page} column={ordered.length > 1}
                editable={manager && (member.role !== 'owner' || myRole === 'owner')}
                // #1471: an owner makes a reset link for anyone else, an admin for members and guests; never with single sign-on.
                resettable={page && sso === null && member.userId !== me.user.id && (myRole === 'owner' || (myRole === 'admin' && (member.role === 'member' || member.role === 'guest')))}
                editing={editing === member.userId} onEdit={(open) => { setDone(''); setEditing(open ? member.userId : null); }}
                onChanged={(message, holderLeft, editorClosed = true) => changed(message, editorClosed, holderLeft, member.userId)} />
            ))}
          </ul>
        ) : (
          <ul className="people__list">
            <li className="people__item"><div className="people__row"><Avatar name={me.user.name} id={me.user.id} size="md" tone="me" /><span className="people__who"><b>{me.user.name} (you)</b><span>{me.user.email}</span></span><span className="people__role">{ROLE_LABEL[myRole]}</span></div></li>
          </ul>
        )}
        </div>
        <p className="people__done" role="status">{done ? <><Icon name="check" size={13} />{done}</> : null}</p>
        {/* The company's page already says "Only admins can change this page" at its top: a member is told once. */}
        {!manager && !(page && members) ? (
          <p className="ov-note">{members
            ? `Only owners and admins add people or change roles in ${workspace.name}.`
            : `Guests see only the spaces they’re added to, not everyone in ${workspace.name}.`}</p>
        ) : null}
        {page && members ? (
          <p className="ov-note people__guests"><Icon name="person" size={13} />
            <span>{guests.length ? `Guests: ${guests.map((guest) => `${guest.name} (${guest.email})`).join(', ')}. ` : ''}Guests see only the spaces they’re added to and never have AI.</span></p>
        ) : null}
      </section>

      {page && canAdd ? <WaitingLinks workspace={workspace} myRole={myRole} links={links} /> : null}
      {page && manager ? <RemovedPeople workspaceId={workspace.id} myRole={myRole} reload={reload}
        onRestored={(person, more) => changed(`${person.name} is back in ${workspace.name} as ${ROLE_LABEL[person.role]}, in ${spacesWord(person)}.`, !more, false, person.userId)} /> : null}
      {page && manager ? <CompanySpaces workspaceId={workspace.id} /> : null}

      {/* Encrypted spaces (F-030, #655): Encryption comes before AI and keeps its place in every state; AI is off for good and has no switch. */}
      {workspace.encryption ? <EncryptionSection workspace={workspace} members={members} meId={me.user.id} myRole={myRole} offerCode={offerCode} onChanged={() => { load(); revalidator.revalidate(); }} /> : null}

      {/* An encrypted space never has AI and says so in place; the company has no AI switch (F-037: AI is per space). */}

      <Leave workspace={workspace} soleOwner={myRole === 'owner' && owners <= 1} holder={manager} onLeft={onBack} meId={me.user.id} />
      {page ? null : <p className="details__keys"><kbd>]</kbd> toggles this panel · <kbd>Esc</kbd> closes it</p>}
    </div>
  );
}

/** How many spaces, Everyone counted, as the sidebar counts them (personas-30): the server's `spaces` are those besides Everyone. */
const spacesWord = (person: Pick<RemovedPerson, 'spaces'>) => (person.spaces + 1 === 1 ? '1 space' : `${person.spaces + 1} spaces`);

/**
 * Who left or was removed: Restore brings them back as they were (founder decision, #1424 F, 2026-11-15): the role they had, the spaces they
 * were in and their direct messages. Each row says the role and how many spaces, Everyone counted. Only an owner gives back the owner role.
 * `more`: another Restore took the focus (the next one in the list), so the restored person's row does not.
 */
function RemovedPeople({ workspaceId, myRole, reload, onRestored }: { workspaceId: string; myRole: WorkspaceRole; reload: number; onRestored: (person: RemovedPerson, more: boolean) => void }) {
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
      // Focus goes to the next Restore in the list (else the one before), in view; with none left, to the restored person's row.
      const at = people.findIndex((entry) => entry.userId === person.userId);
      const after = people[at + 1] ?? people[at - 1] ?? null;
      setPeople((current) => current.filter((entry) => entry.userId !== person.userId));
      if (after) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-removed="${CSS.escape(after.userId)}"] button`)?.focus());
      onRestored(person, !!after);
    } catch { toast({ message: `${person.name} couldn’t be restored. Try again.` }); }
    setBusy(null);
  };
  return (
    <section className="details__sec" aria-labelledby="people-removed">
      <h4 id="people-removed">Removed <span className="people__count">{people.length}</span></h4>
      <ul className="people__list sset-card" aria-label="People who were removed">
        {people.map((person) => (
          <li className="people__item" key={person.userId} data-removed={person.userId}><div className="people__row">
            <Avatar name={person.name} id={person.userId} size="md" />
            <span className="people__who"><b>{person.name}</b><span>{[person.email, ROLE_LABEL[person.role], spacesWord(person)].filter(Boolean).join(' · ')}</span></span>
            {person.role === 'owner' && myRole !== 'owner'
              ? <span className="people__removed-note">An owner can restore them</span>
              : <Button variant="quiet" size="sm" className="access__invite" busy={busy === person.userId} onClick={() => void restore(person)}>Restore</Button>}
          </div></li>
        ))}
      </ul>
      <p className="ov-note">Restore brings someone back with the role, spaces and direct messages they had.</p>
    </section>
  );
}

/**
 * Every space, for the company's owners and admins: the sidebar lists only their own, and here they open any of them or add themselves to the others, as its
 * admin (#903). It has no Delete for a space they can open: Space settings › Delete space… is the one way (#1424). Only an encrypted space they cannot open
 * has one here, since it has no settings for them.
 */
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
      <h4 id="company-spaces">Spaces <span className="people__count">{spaces.length + sealed.length}</span></h4>
      <ul className="people__list sset-card" aria-label="Every space in the company">
        {spaces.map((space) => (
          <li className="people__item" key={space.id}>
            {/* A space is its tile wherever it is named (F-040): the letter, emoji or picture of the sidebar's row. A space the reader is in is
                a row that opens it, as Settings' rows open (L203–204: rows, never underlined links); one they are not in has Add me. A space
                is deleted in its own settings, the one way (Space settings › Delete space…, #1424). */}
            {space.member === false ? (
              <div className="people__row">
                <span className="side__pj" style={{ width: 20, height: 20 }} aria-hidden="true"><SpaceFace name={space.name} icon={space.icon} size={20} /></span>
                <span className="people__who"><b>{space.name}</b></span>
                <Button variant="quiet" size="sm" className="access__invite" busy={busy === space.id} aria-label={`Add me to ${space.name}`} onClick={() => void join(space.id, space.name)}>Add me</Button>
              </div>
            ) : (
              <Link className="people__row people__row--link" to={`/projects/${space.id}`}>
                <span className="side__pj" style={{ width: 20, height: 20 }} aria-hidden="true"><SpaceFace name={space.name} icon={space.icon} size={20} /></span>
                <span className="people__who"><b>{space.name}</b></span>
                <Icon name="chevron-right" size={14} className="people__go" />
              </Link>
            )}
          </li>
        ))}
        {sealed.map((entry) => (
          <li className="people__item" key={entry.id} data-encrypted-space={entry.id}><div className="people__row">
            <span className="side__pj side__pj--lock" style={{ width: 20, height: 20 }} aria-hidden="true"><Icon name="lock" size={12} /></span>
            <span className="people__who"><b>{entry.name}</b><span>Encrypted · made {madeOn.format(new Date(entry.createdAt))} · you can delete it, not open it</span></span>
            <Button variant="quiet" size="sm" className="access__invite" aria-label={`Delete ${entry.name}`} onClick={() => setDeleting({ id: entry.id, name: entry.name, encrypted: true })}>Delete…</Button>
          </div></li>
        ))}
      </ul>
      <DeleteSpaceDialog space={deleting} onClose={() => setDeleting(null)} onDeleted={(_id, name) => { setDeleting(null); toast({ message: `${name} was deleted.` }); revalidator.revalidate(); }} />
    </section>
  );
}

/** The company's name (Settings › Company): shown on the sign-in page and in emails; owners and admins change it in place. */
/** `onClosed`: the field closed (saved or cancelled), so an address that opened it (`?name=1`) no longer says so (personas-30). */
function CompanyName({ workspace, manager, startEditing = false, onChanged, onClosed }: { workspace: Workspace; manager: boolean; startEditing?: boolean; onChanged: () => void; onClosed?: () => void }) {
  const [editing, setEditing] = useState(() => startEditing && manager);
  const [value, setValue] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const changeRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const close = () => { setEditing(false); setProblem(''); onClosed?.(); };
  useFocusBack(changeRef, editing);
  // The name opens selected (#1424 persona P2): typing replaces it, so a first run's "Company" never becomes "CompanyNowak Bakery".
  useLayoutEffect(() => { if (editing) fieldRef.current?.select(); }, [editing]);
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
          <Input ref={fieldRef} id="company-name-input" label="Company name" value={value} maxLength={200} autoFocus onChange={(event) => { setValue(event.target.value); setProblem(''); }}
            error={problem || undefined} hint="Shown on the sign-in page and in emails." />
          <div className="details__actions">
            <Button type="submit" variant="primary" busy={busy}>Save name</Button>
            <Button variant="secondary" onClick={close}>Cancel</Button>
          </div>
        </form>
      ) : (
        <div className="sset-card"><div className="people__row people__name">
          <span className="people__who"><b>{workspace.name}</b><span>Shown on the sign-in page and in emails.</span></span>
          {manager ? <Button ref={changeRef} variant="quiet" size="sm" className="people__change" onClick={() => { setValue(workspace.name); setEditing(true); }}>Change<span className="ui-vh"> the company name</span></Button> : null}
        </div></div>
      )}
    </section>
  );
}

/** An encrypted space's panel (C-24): someone of the company is added by the address of their account; nobody joins it by a link. */
function AddPerson({ workspace, members, myRole, onAdded }: { workspace: Workspace; members: WorkspaceMember[]; myRole: WorkspaceRole;
  onAdded: (member: WorkspaceMember) => void }) {
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
          hint="The address of their Flux account in the company." />
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

function MemberRow({ member, self, workspace, myRole, page, column = false, editable, resettable, editing, onEdit, onChanged }: {
  member: WorkspaceMember; self: boolean; workspace: EncryptedWorkspace; myRole: WorkspaceRole; page: boolean; editable: boolean; resettable: boolean;
  /** Other rows carry Reset link and Remove: a row without them keeps their column, so every role's chevron is at one place (personas-27). */
  column?: boolean;
  editing: boolean; onEdit: (open: boolean) => void; onChanged: (message: string, holderLeft?: boolean, editorClosed?: boolean) => void;
}) {
  const editId = useId();
  const changeRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const resetRef = useRef<HTMLButtonElement>(null);
  const close = () => { onEdit(false); changeRef.current?.focus(); };
  // On the company's page Reset link and Remove are on the row (founder decision 2026-11-14, #1424), as Space settings shows Remove; the role
  // button opens only the role. An encrypted space's panel keeps its one Change, whose editor holds Remove.
  const [open, setOpen] = useState<'reset' | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const confirmRef = useRef<HTMLDivElement>(null);
  const removable = page && editable && !self;
  const holder = !!workspace.encryption && isManagerRole(member.role);
  const first = firstName(member.name);
  // On the company's page the role is a menu, as in Space settings (#1424: the look matches what it does): a role chosen is saved at once, and
  // only an owner or admin of an encrypted company who stops being one is asked first (F-030), in the line under the row.
  const roleRef = useRef<HTMLButtonElement>(null);
  const roleKeys = useRef(attemptKeys());
  const toast = useToast();
  const [demoteTo, setDemoteTo] = useState<WorkspaceRole | null>(null);
  const roles = assignable(myRole).includes(member.role) ? assignable(myRole) : [member.role, ...assignable(myRole)];
  async function applyRole(next: WorkspaceRole) {
    if (busy || next === member.role) return;
    const was = member.role;
    const confirmed = holder && !isManagerRole(next);
    setBusy(true); setProblem(''); setOpen(null);
    try {
      await changeRole(workspace.id, member.userId, next, roleKeys.current.for(`${member.userId}:${next}`));
      roleKeys.current.done();
      setDemoteTo(null);
      // The menu stays where it was, so focus does too; from the confirm (which goes) it returns to the menu.
      // Someone else's role is changed at once with a 10 s Undo, as everything else in the app (coordinator decision, personas-35): Undo
      // gives the role back, and with it what the change took away (a guest's space admin roles come back with the role). Your own role
      // and an encrypted company's key change keep their line: after them you may not be able to change roles back.
      if (self || confirmed) {
        onChanged(self ? `You’re now ${article(next)} ${ROLE_LABEL[next].toLowerCase()} of ${workspace.name}.` : `${member.name} is now ${article(next)} ${ROLE_LABEL[next].toLowerCase()}.`,
          confirmed, false);
      } else {
        onChanged('', false, false);
        toast({ message: `${first} is ${article(next)} ${ROLE_LABEL[next].toLowerCase()} now`, tone: 'success', action: { label: 'Undo', key: 'Z', onClick: () => {
          void changeRole(workspace.id, member.userId, was, crypto.randomUUID()).then(() => onChanged('', false, false), (error: unknown) => {
            toast({ message: problemText(error, { workspace: workspace.name, who: member.name }), tone: 'danger' });
            onChanged('', false, false);
          });
        } } });
      }
      requestAnimationFrame(() => { const now = document.activeElement; if (!now || now === document.body) roleRef.current?.focus({ preventScroll: true }); });
    } catch (error) {
      setDemoteTo(null);
      setProblem(problemText(error, { workspace: workspace.name, who: self ? 'You' : member.name }));
      requestAnimationFrame(() => roleRef.current?.focus());
    } finally { setBusy(false); }
  }
  const pickRole = (next: WorkspaceRole) => {
    if (next === member.role) { setDemoteTo(null); return; }
    if (holder && !isManagerRole(next)) { setOpen(null); setProblem(''); setDemoteTo(next); return; }
    void applyRole(next);
  };
  const keepRole = () => { setDemoteTo(null); requestAnimationFrame(() => roleRef.current?.focus()); };
  useEffect(() => { if (open === 'remove') confirmRef.current?.querySelector<HTMLButtonElement>('button:last-child')?.focus(); }, [open]);
  const shut = (back: RefObject<HTMLButtonElement | null>) => { setOpen(null); setProblem(''); requestAnimationFrame(() => back.current?.focus()); };
  const toggle = (what: 'reset' | 'remove') => { setProblem(''); onEdit(false); setDemoteTo(null); setOpen((current) => (current === what ? null : what)); };
  async function remove() {
    if (busy) return;
    setBusy(true); setProblem('');
    try {
      await removeMember(workspace.id, member.userId);
      onChanged(`${member.name} is no longer in ${workspace.name}.`, holder);
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name, who: member.name }));
      setBusy(false);
    }
  }
  return (
    <li className={`people__item${editing || open ? ' is-editing' : ''}`} data-row-key={member.userId} data-person={member.userId}>
      <div className="people__row">
        <Avatar name={member.name} id={member.userId} size="md" tone={self ? 'me' : 'neutral'} />
        <span className="people__who"><b>{member.name}{self ? <span className="people__you"> (you)</span> : null}</b><PersonLine email={member.email} lastActiveAt={self ? undefined : member.lastActiveAt} /></span>
        {/* On the company's page the role is the control: "Admin ▾" is the menu of roles, and choosing one changes it (#1424). */}
        {page && editable ? (
          <span className="people__rolecell">
            <Select ref={roleRef} className="people__rolesel" aria-label={self ? 'Your role' : `Role of ${member.name}`} value={demoteTo ?? member.role} disabled={busy}
              onChange={(next) => pickRole(next as WorkspaceRole)}>
              {roles.map((option) => <Option key={option} value={option}>{ROLE_LABEL[option]}</Option>)}
            </Select>
          </span>
        ) : <span className="people__role">{ROLE_LABEL[member.role]}</span>}
        {!page && editable ? (
          <Button ref={changeRef} variant="quiet" size="sm" className="people__change" aria-expanded={editing} aria-controls={editing ? editId : undefined} onClick={() => onEdit(!editing)}>
            Change<span className="ui-vh"> {self ? 'your role' : member.name}</span>
          </Button>
        ) : null}
        {page && (resettable || removable) ? (
          <span className="people__acts">
            {resettable ? <Button ref={resetRef} variant="quiet" size="sm" className="people__act" aria-expanded={open === 'reset'} aria-label={`Reset link for ${member.name}`}
              onClick={() => toggle('reset')}>Reset link</Button> : null}
            {removable ? (open === 'remove' && !holder ? (
              <span className="people__confirmrow" role="group" aria-label={`Remove ${member.name}`} ref={confirmRef}
                onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(removeRef); } }}>
                <Button variant="danger" size="sm" busy={busy} onClick={() => void remove()}>Remove</Button>
                <Button variant="quiet" size="sm" onClick={() => shut(removeRef)}>Keep</Button>
              </span>
            ) : <Button ref={removeRef} variant="quiet" size="sm" className="people__act" aria-expanded={open === 'remove'} aria-label={`Remove ${member.name} from ${workspace.name}`}
              onClick={() => toggle('remove')}>Remove</Button>) : null}
          </span>
        ) : page && column ? <span className="people__acts" aria-hidden="true" /> : null}
      </div>
      {/* F-030 (#655): an owner or admin of an encrypted company who stops being one changes its key, which is said before it happens. */}
      {demoteTo ? (
        <div className="details__confirm people__confirm" role="group" aria-label={`Make ${first} ${article(demoteTo)} ${ROLE_LABEL[demoteTo].toLowerCase()}`} data-rotation-confirm="demote"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); keepRole(); } }}>
          <p><b>Make {first} {article(demoteTo)} {ROLE_LABEL[demoteTo].toLowerCase()}?</b></p>
          <p>{rotationText(workspace, first)}</p>
          <div className="details__actions">
            <Button variant="primary" busy={busy} onClick={() => void applyRole(demoteTo)}>Make {first} {article(demoteTo)} {ROLE_LABEL[demoteTo].toLowerCase()}</Button>
            <Button variant="quiet" onClick={keepRole}>Keep {first} {article(member.role)} {ROLE_LABEL[member.role].toLowerCase()}</Button>
          </div>
        </div>
      ) : null}
      {open === 'remove' && !holder ? <p className="people__removing" role="status">{removalWords(first, workspace.name)}</p> : null}
      {/* F-030 (#655): removing an owner or admin of an encrypted workspace changes its key, which is said before it happens. */}
      {open === 'remove' && holder ? (
        <div className="details__confirm people__confirm" role="group" aria-label={`Remove ${member.name}`} data-rotation-confirm="remove" ref={confirmRef}
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(removeRef); } }}>
          <p><b>Remove {first} from {workspace.name}?</b></p>
          <p>{rotationText(workspace, first)}</p>
          <div className="details__actions">
            <Button variant="danger" busy={busy} onClick={() => void remove()}>Remove {first}</Button>
            <Button variant="quiet" onClick={() => shut(removeRef)}>Keep {first}</Button>
          </div>
        </div>
      ) : null}
      {problem ? <p className="people__notice people__rownote" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
      {open === 'reset' ? (
        <div className="people__edit" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); shut(resetRef); } }}>
          <ResetLinkGroup id={editId} member={member} workspace={workspace} onClose={() => shut(resetRef)} />
        </div>
      ) : null}
      {editing && !page ? <MemberEditor id={editId} member={member} self={self} workspace={workspace} myRole={myRole} withRemove={!page} onClose={close} onChanged={onChanged} /> : null}
    </li>
  );
}

/**
 * What Remove does, in plain words for that person (personas-33/34): what they lose, what stays, and that Restore undoes it all. Their tasks
 * keep them as owner, marked "(removed)", until someone gives them to another person.
 */
const removalWords = (first: string, company: string) =>
  `${first} loses access to ${company} and its spaces at once. Tasks given to ${first} stay; you can give them to someone else. Restore brings everything back.`;

/** What removing or demoting an owner or admin of an encrypted workspace does to its key (F-030, #655). */
const rotationText = (workspace: Workspace, first: string) => `${workspace.name} gets a new key, and everything in it is encrypted again in the background. When that finishes, ${first}’s unlock password opens nothing made from then on. The recovery code stops working, and an owner makes a new one. A copy ${first} may already have, such as an old backup, still opens with their old password.`;

/** One member's role and removal; mounted fresh each time it opens, so nothing stale carries over. */
function MemberEditor({ id, member, self, workspace, myRole, withRemove, onClose, onChanged }: {
  id: string; member: WorkspaceMember; self: boolean; workspace: EncryptedWorkspace; myRole: WorkspaceRole; withRemove: boolean;
  onClose: () => void; onChanged: (message: string, holderLeft?: boolean) => void;
}) {
  const [role, setRole] = useState<WorkspaceRole>(member.role);
  const [confirm, setConfirm] = useState<'remove' | 'demote' | null>(null);
  const [busy, setBusy] = useState<'role' | 'remove' | null>(null);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const selectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { selectRef.current?.focus(); }, []);
  // F-030 (#655): an owner or admin who stops being one (removed, demoted, leaving) changes the key of an encrypted space: its content
  // is encrypted again in the background, and what that person may have kept (a backup) still opens with their old password.
  const holder = !!workspace.encryption && isManagerRole(member.role);
  const demoting = holder && !isManagerRole(role);
  const first = firstName(member.name);

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
          <p>{rotationText(workspace, first)}</p>
          <div className="details__actions">
            <Button variant="primary" busy={busy === 'role'} onClick={() => void saveRole()}>Make {first} {article(role)} {ROLE_LABEL[role].toLowerCase()}</Button>
            <Button variant="quiet" onClick={() => setConfirm(null)}>Keep {first} {article(member.role)} {ROLE_LABEL[member.role].toLowerCase()}</Button>
          </div>
        </div>
      ) : null}
      {withRemove && !self ? (confirm === 'remove' ? (
        holder ? (
          <div className="details__confirm people__confirm" role="group" aria-label={`Remove ${member.name}`} data-rotation-confirm="remove">
            <p><b>Remove {first} from {workspace.name}?</b></p>
            <p>{rotationText(workspace, first)}</p>
            <div className="details__actions">
              <Button variant="danger" busy={busy === 'remove'} onClick={() => void remove()}>Remove {first}</Button>
              <Button variant="quiet" onClick={() => setConfirm(null)}>Keep {first}</Button>
            </div>
          </div>
        ) : (
          <div className="details__confirm people__confirm" role="group" aria-label={`Remove ${member.name}`}>
            <p>{removalWords(first, workspace.name)}</p>
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

/**
 * A one-time password reset link for this person (#1471), made and copied as a new invite link is: Flux sends it nowhere. It is shown
 * only here, once; making another stops the earlier one. What happened is said once, in the line under it, and Close puts it away (#1424).
 */
function ResetLinkGroup({ id, member, workspace, onClose }: { id: string; member: WorkspaceMember; workspace: EncryptedWorkspace; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState('');
  const linkRef = useRef<HTMLInputElement>(null);
  const first = firstName(member.name);
  async function make() {
    if (busy) return;
    setBusy(true); setProblem(''); setStatus('');
    try {
      const made = await makeResetLink(member.userId);
      setLink(made.link);
      const minutes = Math.max(1, Math.round((new Date(made.expiresAt).getTime() - Date.now()) / 60_000));
      const lasts = minutes >= 60 ? `${Math.round(minutes / 60)} hour${Math.round(minutes / 60) === 1 ? '' : 's'}` : `${minutes} minutes`;
      setStatus(await copyText(made.link) ? `Reset link made and copied: paste it into your message to ${first}. It works once, for ${lasts}.`
        : `Reset link made. Copy it and paste it into your message to ${first}. It works once, for ${lasts}.`);
      requestAnimationFrame(() => linkRef.current?.select());
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name, who: member.name }));
    } finally { setBusy(false); }
  }
  return (
    <div className="people__field people__reset" role="group" aria-labelledby={`${id}-reset`}>
      <label id={`${id}-reset`}>Password</label>
      <p className="people__hint">Make a one-time link that lets {first} choose a new password.</p>
      {link ? (
        <div className="people__link">
          <Input ref={linkRef} id={`${id}-reset-link`} label={`Reset link for ${member.name}`} readOnly value={link}
            onFocus={(event) => event.currentTarget.select()} />
          <div className="details__actions">
            <Button variant="secondary" onClick={() => void copyText(link).then((copied) => setStatus(copied ? 'Link copied.' : 'Copying isn’t allowed here. Select the link and copy it.'))}><Icon name="copy" size={14} />Copy link</Button>
            <Button variant="quiet" onClick={onClose}>Close</Button>
          </div>
        </div>
      ) : <div className="details__actions">
        <Button variant="secondary" busy={busy} onClick={() => void make()}><Icon name="link" size={14} />Make reset link</Button>
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
      </div>}
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
      <p className="people__invite-status" role="status">{status ? <><Icon name="check" size={13} />{status}</> : null}</p>
    </div>
  );
}

const expiryLabel: Record<InviteExpiryDays, string> = { 1: '1 day', 7: '7 days', 30: '30 days' };
const until = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const madeOn = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const inviteRoles = (mine: WorkspaceRole): InviteRole[] => (mine === 'owner' ? ['admin', 'member', 'guest'] : ['member', 'guest']);

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** The company's links waiting to be used, and the one just made (shown once, in its own row), shared by the invite form and the list (#1424). */
type InviteLinks = {
  invites: WorkspaceInvite[] | null; setInvites: (update: (list: WorkspaceInvite[] | null) => WorkspaceInvite[] | null) => void;
  fresh: WorkspaceInvite | null; setFresh: (invite: WorkspaceInvite | null) => void;
  status: string; setStatus: (status: string) => void; linkRef: RefObject<HTMLInputElement | null>;
};

/** Reads the links once there is someone to show them to, and again when someone joined or a link was made or revoked elsewhere (`seen`). */
function useInviteLinks(workspaceId: string, enabled: boolean, seen: number, onJoined: () => void): InviteLinks {
  const [invites, setInvites] = useState<WorkspaceInvite[] | null>(null);
  const [fresh, setFresh] = useState<WorkspaceInvite | null>(null);
  const [status, setStatus] = useState('');
  const linkRef = useRef<HTMLInputElement>(null);
  const freshRef = useRef(fresh);
  useEffect(() => { freshRef.current = fresh; });
  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    listInvites(workspaceId, controller.signal).then((list) => {
      setInvites(list);
      // The link just made was used (or revoked elsewhere): its row and its sentence go with it, so no sentence is left about a link no longer listed.
      const made = freshRef.current;
      if (made && !list.some((invite) => invite.id === made.id)) { setFresh(null); setStatus(''); }
    }, (error: unknown) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setInvites([]);
    });
    if (seen) onJoined();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `seen` is the trigger; `onJoined` reloads the roster.
  }, [workspaceId, enabled, seen]);
  return { invites, setInvites, fresh, setFresh, status, setStatus, linkRef };
}

/**
 * The sentence under a new link: what happened and what to do, said once (#1424, persona B-4), in the same words as Add people's "Someone new?"
 * with how long it works (personas-28): "It works once, for 7 days".
 */
const madeSentence = (copied: boolean, days: number) => {
  const lasts = `${days} ${days === 1 ? 'day' : 'days'}`;
  return copied ? `Invite link created and copied. It works once, for ${lasts}: paste it into your message to them.`
    : `Invite link created. Copy it and paste it into your message to them. It works once, for ${lasts}.`;
};

/**
 * One invite form (F-035, #763 PE-2; founder decision 2026-11-13, #1438): an optional email and "Create invite link"; the role and how long
 * the link works are under More (Member and 7 days by default). An address with a Flux account outside the company is added at once; any other
 * address, or none, makes a one-time link, copied at once, that the owner or admin sends themselves (Flux sends no email). The new link shows
 * once, in its own row of the list of links waiting to be used (`WaitingLinks`), which keeps Copy and Revoke for every link (#1424).
 */
function InviteForm({ workspace, members, myRole, links, onAdded, onClose }: { workspace: Workspace; members: WorkspaceMember[]; myRole: WorkspaceRole;
  links: InviteLinks; onAdded: (member: WorkspaceMember) => void; onClose: () => void }) {
  const [role, setRole] = useState<InviteRole>('member');
  const [email, setEmail] = useState('');
  const [days, setDays] = useState<InviteExpiryDays>(INVITE_DEFAULT_EXPIRY_DAYS);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const roleId = useId();
  const daysId = useId();
  const moreId = useId();
  const emailRef = useRef<HTMLInputElement>(null);
  // A form opens on its first field (F-026 §4, persona round 28 P2 1): an address typed at once is the address, never G I or C. At 200 % the
  // form comes into view with it.
  useLayoutEffect(() => {
    if (window.matchMedia('(hover: none)').matches) return undefined;
    const stop = focusField('people-invite-email');
    const frame = requestAnimationFrame(() => emailRef.current?.scrollIntoView({ block: 'nearest' }));
    return () => { stop(); cancelAnimationFrame(frame); };
  }, []);

  async function makeLink(address: string) {
    const invite = await createInvite(workspace.id, { role, email: address || null, expiresInDays: days }, keys.current.for(`${role}:${address}:${days}`));
    keys.current.done();
    links.setFresh(invite);
    links.setInvites((list) => [invite, ...(list ?? []).filter((item) => item.id !== invite.id)]);
    setEmail('');
    links.setStatus(madeSentence(await copyText(invite.link), days));
    // The link is in its row of the list under the people: bring it into view.
    requestAnimationFrame(() => { links.linkRef.current?.scrollIntoView({ block: 'nearest' }); links.linkRef.current?.select(); });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const address = email.trim().toLowerCase();
    if (address && !/^[^\s@]+@[^\s@]+$/.test(address)) { setProblem('Enter an email address, or leave it empty for anyone with the link.'); emailRef.current?.focus(); return; }
    const known = address ? members.find((member) => member.email.toLowerCase() === address) : undefined;
    if (known) { setProblem(`${known.name} is already in ${workspace.name}.`); emailRef.current?.focus(); return; }
    setBusy(true); setProblem(''); links.setStatus('');
    try {
      if (address) {
        // Someone who already has a Flux account joins at once; anyone else gets a link locked to their address.
        try {
          const member = await addMember(workspace.id, address, role, keys.current.for(`add:${address}:${role}`));
          keys.current.done();
          setEmail(''); setRole('member');
          onAdded(member);
          return;
        } catch (error) {
          keys.current.done();
          if (!(error instanceof ApiError && error.code === 'ACCOUNT_NOT_FOUND')) throw error;
        }
      }
      await makeLink(address);
    } catch (error) {
      setProblem(problemText(error, { workspace: workspace.name, email: address }));
    } finally { setBusy(false); }
  }

  return (
    <section className="details__sec" aria-labelledby="people-invite">
      <h4 id="people-invite">Invite people</h4>
      {/* Esc in its fields closes the form and gives focus back to Invite (F-026 §4). */}
      <form className="people__add" onSubmit={(event) => void submit(event)} noValidate aria-label="Invite people"
        onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
        <Input ref={emailRef} id="people-invite-email" label="Email (optional)" type="email" inputMode="email" autoComplete="off" spellCheck={false} placeholder="name@example.com" value={email}
          onChange={(event) => { setEmail(event.target.value); if (problem) setProblem(''); }}
          hint="Empty: anyone who opens the link first can join." />
        <Button variant="quiet" size="sm" className="people__more" aria-expanded={more} aria-controls={more ? moreId : undefined} onClick={() => setMore((open) => !open)}>
          More<Icon name={more ? 'chevron-up' : 'chevron-down'} size={14} />
        </Button>
        {more ? (
          <div id={moreId} className="people__more-fields">
            <div className="people__field">
              <label htmlFor={roleId}>Joins as</label>
              <Select id={roleId} value={role} onChange={(next) => setRole(next as InviteRole)} aria-describedby={`${roleId}-hint`}>
                {inviteRoles(myRole).map((option) => <Option key={option} value={option}>{ROLE_LABEL[option]}</Option>)}
              </Select>
              <p className="people__hint" id={`${roleId}-hint`}>{ROLE_HINT[role]}</p>
            </div>
            <div className="people__field">
              <label htmlFor={daysId}>Works for</label>
              <Select id={daysId} value={String(days)} onChange={(next) => setDays(Number(next) as InviteExpiryDays)}>
                {([1, 7, 30] as const).map((option) => <Option key={option} value={String(option)}>{expiryLabel[option]}</Option>)}
              </Select>
            </div>
          </div>
        ) : null}
        {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
        <div className="details__actions">
          <Button type="submit" variant="primary" busy={busy}><Icon name="link" size={14} />Create invite link</Button>
          <Button variant="secondary" onClick={onClose}>Close</Button>
        </div>
      </form>
    </section>
  );
}

/**
 * The company's links waiting to be used (#1424, persona B-5): listed under its people at all times, not only while Invite is open, each with
 * Copy and Revoke. The link just made shows once, in its own row, with the one sentence about it.
 */
function WaitingLinks({ workspace, myRole, links }: { workspace: Workspace; myRole: WorkspaceRole; links: InviteLinks }) {
  const { invites, setInvites, fresh, setFresh, status, setStatus, linkRef } = links;
  const [revoking, setRevoking] = useState<string | null>(null);
  const [problem, setProblem] = useState('');

  async function copy(invite: WorkspaceInvite) {
    const copied = await copyText(invite.link);
    setStatus(copied ? 'Link copied.' : 'Copying isn’t allowed here. Select the link and copy it.');
    // Where the browser refuses, the link is shown in its row to be selected by hand.
    if (!copied) setFresh(invite);
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
  const where = (invite: WorkspaceInvite) => (invite.space ? ` · ${invite.space.name}` : '');
  /** The link just made, to read and select: shown once, in its own row, whose Copy is the only one (#1424). */
  const newLink = (invite: WorkspaceInvite) => (
    <div className="people__link" role="group" aria-label="New invite link">
      <Input ref={linkRef} id="people-invite-link" label={`Link for ${invite.email ?? 'anyone'}`} readOnly value={invite.link}
        onFocus={(event) => event.currentTarget.select()} />
    </div>
  );
  const statusLine = <p className="people__invite-status" role="status">{status ? <><Icon name="check" size={13} />{status}</> : null}</p>;
  // With nothing waiting, only what just happened stays (the last link revoked).
  if (!invites?.length) return <div className="people__waiting-none">{statusLine}{problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}</div>;
  return (
    <section className="details__sec" aria-labelledby="people-invites-pending">
      <h4 id="people-invites-pending">Waiting to be used <span className="people__count">{invites.length}</span></h4>
      <ul className="people__list sset-card people__waiting" aria-label={`Waiting to be used · ${invites.length}`}>
        {invites.map((invite) => (
          <li className="people__item" key={invite.id}>
            <div className="people__row">
              <span className="people__who"><b>{who(invite)}</b><span>{ROLE_LABEL[invite.role]}{where(invite)} · until {until.format(new Date(invite.expiresAt))} · by {invite.createdBy.name}</span></span>
              <Button variant="quiet" size="sm" className="people__change" onClick={() => void copy(invite)}>Copy<span className="ui-vh"> link for {who(invite)}</span></Button>
              {invite.role !== 'admin' || myRole === 'owner'
                ? <Button variant="quiet" size="sm" className="people__change" aria-expanded={revoking === invite.id} onClick={() => setRevoking(revoking === invite.id ? null : invite.id)}>Revoke<span className="ui-vh"> link for {who(invite)}</span></Button> : null}
            </div>
            {fresh?.id === invite.id ? newLink(invite) : null}
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
      {statusLine}
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
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
