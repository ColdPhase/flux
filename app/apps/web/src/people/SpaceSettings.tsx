import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import type { Project, ProjectGrant, ProjectGrantRole, ProjectPerson, WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { whenPageLive } from '../api/pageLeaving';
import { useShellData } from '../app/data';
import { useProjectShell } from '../project/data';
import { leaveProject, renameProject, setSpaceAi } from '../project/api';
import { useWorkspaceEncryption } from '../encryption/state';
import { Avatar, Button, Icon, Input, Option, Select, useToast } from '../ui';
import { SwitchRow } from '../ui/SwitchRow';
import { attemptKeys, firstName, grantPerson, isManagerRole, listGrants, listMembers, problemText, revokeGrant } from './api';
import { DeleteSpaceDialog } from './DeleteSpace';
import { PeoplePicker } from './PeoplePicker';
import '../app/settings.css';
import './space.css';

/** What a person is in a space: its admin (a company owner or admin always is), or a member. */
const roleWord = (role: ProjectGrantRole | 'manager') => (role === 'manager' ? 'Admin' : 'Member');

/** The last admin of a space cannot leave, step down or be removed: the words the server's refusal gets (C-16). */
const lastAdmin = (error: unknown) => (error instanceof ApiError && error.code === 'LAST_SPACE_ADMIN' ? 'Add another admin first: a space always keeps one.' : null);

interface Row { userId: string; name: string; email: string | null; role: 'manager' | 'contributor'; company: boolean; guest: boolean; grantId: string | null }

/**
 * A space's settings (F-037, #874; ⋯ › Settings): its name, its people with their roles, the AI switch, Leave space and, for its admins,
 * Delete space. A space's admins and the company's owners and admins change it; everyone else who can open it reads it. The server
 * decides every change again. People are read from the server's grants after each change, never guessed.
 */
export function SpaceSettings() {
  const shell = useProjectShell();
  const { me, workspace } = useShellData();
  if (!shell) return null;
  return <SpaceSettingsPage project={shell.project} people={shell.people} meId={me.user.id} meName={me.user.name} companyName={workspace?.name ?? 'the company'} />;
}

function SpaceSettingsPage({ project, people, meId, meName, companyName }: {
  project: Project; people: ProjectPerson[] | null; meId: string; meName: string; companyName: string;
}) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const toast = useToast();
  const manager = project.access === 'manager';
  // A space open to the whole company (Everyone) has no list to add to, and it cannot be left or deleted.
  const everyone = project.visibility === 'workspace';
  const encrypted = !!useWorkspaceEncryption(project.workspaceId);
  const [roster, setRoster] = useState<{ members: WorkspaceMember[]; grants: ProjectGrant[] } | null>(null);
  const [rosterFailed, setRosterFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState(false);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const load = () => setReload((n) => n + 1);
  // Focus stays on the control the person used: a row that moves (its role changed) or a confirmation that closes hands it back.
  const focusOn = (selector: string, onlyIfLost = false) => requestAnimationFrame(() => {
    const active = document.activeElement;
    if (onlyIfLost && active && active !== document.body && active.isConnected) return;
    document.querySelector('[data-space-settings]')?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  });
  const closeRemoving = (userId: string) => { setRemoving(null); focusOn(`[data-person="${userId}"] .spset__remove`); };
  const closeLeaving = () => { setLeaving(false); focusOn('.spset__leave'); };
  const onEscape = (close: () => void) => (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
  useEffect(() => { if (removing) focusOn(`[data-person="${removing}"] .spset__confirm button:last-child`); }, [removing]);
  useEffect(() => { if (leaving) focusOn('.spset__leaving button:last-child'); }, [leaving]);
  useEffect(() => { if (adding) focusOn('.spset__add input[type="checkbox"], .spset__add input[type="search"]'); }, [adding]);
  const changed = (message: string) => { setStatus(message); setProblem(''); load(); void revalidator.revalidate(); };

  // A space's admins read the company's people and the space's grants: who is in it, and who could be added.
  useEffect(() => {
    if (!manager) return undefined;
    const controller = new AbortController();
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

  const memberOf = (id: string) => roster?.members.find((member) => member.userId === id) ?? null;
  const grantOf = (id: string) => roster?.grants.find((grant) => grant.principal.kind === 'human' && grant.principal.id === id) ?? null;
  const myGrant = manager ? grantOf(meId) : null;
  // "Leave space" is for someone added to the space; a company admin who only reaches it, or anyone in Everyone, has nothing to leave.
  const canLeave = !everyone && (manager ? !!myGrant && myGrant.role !== 'denied' : true);

  const rows: Row[] = (() => {
    if (manager && roster) {
      const fromMember = (member: WorkspaceMember, grant: ProjectGrant | null): Row => ({
        userId: member.userId, name: member.name, email: member.email, role: grant?.role === 'manager' || isManagerRole(member.role) ? 'manager' : 'contributor',
        company: isManagerRole(member.role), guest: member.role === 'guest', grantId: grant?.id ?? null,
      });
      const list = everyone
        ? roster.members.filter((member) => member.role !== 'guest' || grantOf(member.userId)).map((member) => fromMember(member, grantOf(member.userId)))
        : roster.grants.flatMap((grant) => {
          const member = grant.principal.kind === 'human' ? memberOf(grant.principal.id) : null;
          return member && grant.role !== 'denied' ? [fromMember(member, grant)] : [];
        });
      return list.sort((a, b) => (a.userId === meId ? -1 : b.userId === meId ? 1 : a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'manager' ? -1 : 1));
    }
    return (people ?? []).filter((person) => person.kind === 'human')
      .map((person): Row => ({ userId: person.id, name: person.name, email: null, role: person.access === 'manager' ? 'manager' : 'contributor', company: false, guest: false, grantId: null }))
      .sort((a, b) => (a.userId === meId ? -1 : b.userId === meId ? 1 : a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'manager' ? -1 : 1));
  })();

  // Any company person, the owner too (F-037 "chosen from the company"; the same list New space offers, #905).
  const candidates = (roster?.members ?? []).filter((member) => member.userId !== meId && !grantOf(member.userId));

  async function setRole(row: Row, role: 'manager' | 'contributor') {
    if (busy) return;
    setBusy(row.userId); setProblem('');
    try {
      // In Everyone a member has no grant: "Member" takes the admin grant away; "Admin" is the one grant it has.
      if (everyone && role === 'contributor') { if (row.grantId) await revokeGrant(project.id, row.grantId); }
      else await grantPerson(project.id, row.userId, role, keys.current.for(`${row.userId}:${role}`));
      keys.current.done();
      changed(`${firstName(row.name)} is now ${role === 'manager' ? 'an admin' : 'a member'} of ${project.name}.`);
      focusOn(`[data-person="${row.userId}"] [role="combobox"]`, true);
    } catch (error) {
      keys.current.done();
      if (error instanceof ApiError && (error.code === 'GRANT_NOT_FOUND' || error.code === 'GRANT_CONFLICT')) load();
      setProblem(lastAdmin(error) ?? problemText(error, { workspace: companyName, who: row.name }));
    } finally { setBusy(null); }
  }
  async function remove(row: Row) {
    if (busy || !row.grantId) return;
    setBusy(row.userId); setProblem('');
    try {
      await revokeGrant(project.id, row.grantId);
      setRemoving(null);
      changed(`${firstName(row.name)} was removed from ${project.name}.`);
      focusOn('.spset__seclead button, .spset__leave', true);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'GRANT_NOT_FOUND') { setRemoving(null); load(); }
      setProblem(lastAdmin(error) ?? problemText(error, { workspace: companyName, who: row.name }));
    } finally { setBusy(null); }
  }
  async function addChosen() {
    if (busy || !chosen.length) return;
    setBusy('add'); setProblem('');
    const added: string[] = [];
    try {
      for (const id of chosen) {
        await grantPerson(project.id, id, 'contributor', keys.current.for(`${id}:contributor`));
        keys.current.done();
        added.push(firstName(memberOf(id)?.name ?? 'Someone'));
      }
      setChosen([]); setAdding(false);
      changed(`${added.join(', ')} ${added.length === 1 ? 'is' : 'are'} now in ${project.name}.`);
    } catch (error) {
      keys.current.done();
      if (added.length) changed(`${added.join(', ')} ${added.length === 1 ? 'was' : 'were'} added.`);
      setProblem(problemText(error, { workspace: companyName }));
    } finally { setBusy(null); }
  }
  async function leave() {
    if (busy) return;
    setBusy('leave'); setProblem('');
    try {
      await leaveProject(project.id);
      toast({ message: `You left ${project.name}.` });
      void navigate('/', { replace: true });
      void revalidator.revalidate();
    } catch (error) {
      setProblem(lastAdmin(error) ?? problemText(error, { workspace: companyName }));
      setBusy(null);
    }
  }

  return (
    <div className="pane-scroll">
      <div className="pane-in sset-in spset" data-space-settings="">
        <div className="sset-head">
          <h2>Space settings</h2>
          <p>{everyone ? `Everyone in ${companyName} is in this space. Admins of the space and of the company can change this page.`
            : 'Only people added here see this space. Admins of the space and of the company can change this page.'}</p>
        </div>

        <h3 className="sset-sec">Name</h3>
        <NameCard project={project} manager={manager} companyName={companyName} onRenamed={(name) => changed(`Renamed to ${name}.`)} />

        <div className="spset__seclead">
          <h3 className="sset-sec" id="space-people">People{!everyone ? <span className="spset__count">{rows.length}</span> : null}</h3>
          {manager && !everyone ? <Button variant="secondary" size="sm" icon="plus" aria-expanded={adding} disabled={!roster} onClick={() => { setAdding((open) => !open); setChosen([]); }}>Add people</Button> : null}
        </div>
        {manager && adding && roster ? (
          <div className="spset__add" role="group" aria-label="Add people" onKeyDown={onEscape(() => { setAdding(false); setChosen([]); focusOn('.spset__seclead button'); })}>
            <PeoplePicker listOnly candidates={candidates} value={chosen} onChange={setChosen} disabled={busy === 'add'} companyName={companyName} />
            <div className="newspace__foot">
              <Button variant="primary" busy={busy === 'add'} disabled={!chosen.length} onClick={() => void addChosen()}>{chosen.length ? `Add ${chosen.length === 1 ? '1 person' : `${chosen.length} people`}` : 'Add'}</Button>
              <Button variant="secondary" onClick={() => { setAdding(false); setChosen([]); focusOn('.spset__seclead button'); }}>Cancel</Button>
            </div>
          </div>
        ) : null}
        {manager && rosterFailed && !roster ? (
          <p className="people__notice" role="alert"><Icon name="alert" size={13} />Who is in this space couldn’t be loaded.<button type="button" onClick={load}>Try again</button></p>
        ) : null}
        {everyone && !manager ? (
          <ul className="sset-card" aria-label="People of this space"><li className="sset-row"><span className="sset-row__b"><span className="sset-row__t">Everyone in {companyName}</span>
            <span className="sset-row__s">Whoever joins the company is in this space.</span></span></li></ul>
        ) : (
          <ul className="sset-card" aria-label={`People in ${project.name}`} aria-busy={manager && !roster ? true : undefined}>
            {rows.map((row) => (
              <li className="sset-row" key={row.userId} data-person={row.userId}>
                <Avatar name={row.name} size="md" tone={row.userId === meId ? 'me' : 'neutral'} />
                <span className="spset__who"><b>{row.userId === meId ? meName : row.name}{row.userId === meId ? <span className="spset__you"> · you</span> : null}</b>{row.email ? <span>{row.email}</span> : null}</span>
                {manager && row.userId !== meId && !row.company ? (
                  <span className="spset__rolecell">
                    <Select aria-label={`Role of ${row.name}`} value={row.role} onChange={(next) => void setRole(row, next as 'manager' | 'contributor')}>
                      {row.guest ? null : <Option value="manager">Admin</Option>}
                      <Option value="contributor">Member</Option>
                    </Select>
                  </span>
                ) : <span className="spset__role">{row.company ? 'Admin' : roleWord(row.role)}</span>}
                {manager && !everyone ? (row.userId !== meId && row.grantId ? (
                  removing === row.userId ? (
                    <span className="spset__confirm" role="group" aria-label={`Remove ${row.name}`} onKeyDown={onEscape(() => closeRemoving(row.userId))}>
                      <Button variant="danger" size="sm" busy={busy === row.userId} onClick={() => void remove(row)}>Remove</Button>
                      <Button variant="quiet" size="sm" onClick={() => closeRemoving(row.userId)}>Keep</Button>
                    </span>
                  ) : <Button variant="quiet" className="spset__remove" aria-label={`Remove ${row.name} from ${project.name}`} onClick={() => { setProblem(''); setRemoving(row.userId); }}>Remove</Button>
                ) : <span className="spset__remove-gap" aria-hidden="true" />) : null}
              </li>
            ))}
            {manager && removing ? <li className="sset-row spset__removing" role="status"><span className="sset-row__s">{firstName(rows.find((row) => row.userId === removing)?.name ?? 'They')} stops seeing {project.name} at once, not even its name.</span></li> : null}
          </ul>
        )}
        <p className="spset__status" role="status">{status}</p>
        {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}

        <h3 className="sset-sec">AI</h3>
        {encrypted
          ? <ul className="sset-card" data-encrypted-line=""><li className="sset-row"><Icon name="lock" size={16} /><span className="sset-row__b"><span className="sset-row__t">No AI in encrypted spaces</span>
            <span className="sset-row__s">Only people work here.</span></span></li></ul>
          : <AiCard project={project} manager={manager} onChanged={changed} />}

        <div className="spset__actions">
          {canLeave ? (leaving ? (
            <div className="details__confirm spset__leaving" role="group" aria-label={`Leave ${project.name}`} onKeyDown={onEscape(closeLeaving)}>
              <p className="sset-note">You stop seeing {project.name} at once. An admin has to add you again to come back.</p>
              <div className="details__actions">
                <Button variant="danger" busy={busy === 'leave'} onClick={() => void leave()}>Leave {project.name}</Button>
                <Button variant="secondary" onClick={closeLeaving}>Cancel</Button>
              </div>
            </div>
          ) : <Button variant="secondary" className="spset__leave" onClick={() => { setProblem(''); setLeaving(true); }}>Leave space</Button>) : null}
          {manager && !everyone ? <Button variant="danger" className="spset__delete" onClick={() => setDeleting(true)}>Delete space…</Button> : null}
        </div>
        {everyone ? <p className="spset__note">Everyone holds the whole company, so nobody leaves it and it can’t be deleted.</p> : null}
        <DeleteSpaceDialog space={deleting ? { id: project.id, name: project.name } : null} onClose={() => setDeleting(false)}
          onDeleted={(_id, name) => { setDeleting(false); toast({ message: `${name} was deleted.` }); void navigate('/', { replace: true }); void revalidator.revalidate(); }} />
      </div>
    </div>
  );
}

/** The space's name, with Change for its admins. */
function NameCard({ project, manager, companyName, onRenamed }: { project: Project; manager: boolean; companyName: string; onRenamed: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.name);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  const changeRef = useRef<HTMLButtonElement>(null);
  const close = () => { setEditing(false); setProblem(''); requestAnimationFrame(() => changeRef.current?.focus({ preventScroll: true })); };
  async function save(event: FormEvent) {
    event.preventDefault();
    const next = value.trim();
    if (!next) { setProblem('Give the space a name.'); return; }
    if (busy) return;
    if (next === project.name) { close(); return; }
    setBusy(true); setProblem('');
    try {
      const renamed = await renameProject(project.id, next, keys.current.for(next));
      keys.current.done();
      close();
      onRenamed(renamed.name);
    } catch (error) {
      setProblem(problemText(error, { workspace: companyName }));
    } finally { setBusy(false); }
  }
  return (
    <div className="sset-card">
      <div className="sset-row spset__name">
        {editing ? (
          <form onSubmit={(event) => void save(event)} noValidate onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
            <Input label="Space name" value={value} maxLength={200} autoFocus error={problem || undefined} onChange={(event) => { setValue(event.target.value); setProblem(''); }} />
            <Button type="submit" variant="primary" busy={busy}>Save</Button>
            <Button variant="secondary" onClick={close}>Cancel</Button>
          </form>
        ) : <>
          <b>{project.name}</b>
          {manager ? <Button ref={changeRef} variant="quiet" aria-label={`Change the name of ${project.name}`} onClick={() => { setValue(project.name); setEditing(true); }}>Change</Button> : null}
        </>}
      </div>
    </div>
  );
}

/** The space's AI switch (AG-10): on by default; its admins turn it off, which stops what agents were doing here at once. */
function AiCard({ project, manager, onChanged }: { project: Project; manager: boolean; onChanged: (message: string) => void }) {
  const on = project.ai === 'allowed';
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const keys = useRef(attemptKeys());
  async function change(next: boolean) {
    if (busy) return;
    setBusy(true); setProblem('');
    try {
      const result = await setSpaceAi(project.id, next ? 'allowed' : 'blocked', keys.current.for(String(next)));
      keys.current.done();
      const stopped = result.stopped ? result.stopped.runs + result.stopped.comparisons + result.stopped.requests + result.stopped.units : 0;
      onChanged(next ? 'AI is on in this space.' : `AI is off in this space.${stopped ? ` ${stopped} ${stopped === 1 ? 'run' : 'runs'} stopped.` : ''}`);
    } catch (error) {
      keys.current.done();
      setProblem(error instanceof ApiError && error.status === 403 ? 'Only admins of this space or of the company can change this.' : 'That didn’t work. Nothing changed; try again.');
    } finally { setBusy(false); }
  }
  return (
    <>
      <div className="sset-card" data-ai-switch={on ? 'on' : 'off'}>
        <SwitchRow label="AI" detail="Agents can work here. Each person uses their own AI." checked={on} disabled={!manager} onChange={(next) => void change(next)} />
      </div>
      {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
    </>
  );
}
