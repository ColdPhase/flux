import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Project, WorkspaceInvite } from '@flux/contracts';
import { PeoplePicker } from '../people/PeoplePicker';
import { SomeoneNew } from '../people/SomeoneNew';
import { isManagerRole, revokeInvite } from '../people/api';
import { useShellData } from '../app/data';
import { getEncryptionAvailability } from '../encryption/api';
import { PasswordLength, passwordRefusal } from '../encryption/PasswordLength';
import { checkPassword, downloadRecoveryCode, generatePassphrase, generateRecoveryCode, loadWords } from '../encryption/passphrase';
import { Button, Icon, Input } from '../ui';
import { SwitchRow } from '../ui/SwitchRow';
import '../app/settings.css';
import '../people/space.css';
import '../encryption/encryption.css';
import { useCompanyCandidates, useNewProject } from './newProject';

/**
 * A new space in one window (F-037, #874, S20): its name, the people (chosen from the company), an AI switch that starts on, an Encrypted
 * switch that starts off, and Create space. You are its admin. There are no templates and no goal: every space starts with Conversation,
 * Tasks, Map and Wiki. Every way in (New › Space, Home, the Spaces list, the phone's plus) opens this one form.
 *
 * Encrypted is chosen here and never later (F-030, C-24). Turned on, the space has no AI, and the window asks for the creator's unlock
 * password (twice) and for the recovery code to be downloaded before Create: the browser makes the code, the person keeps the file, and
 * the server sees it once to wrap the key with it. Nothing typed or made here is kept in the browser.
 */
export function NewSpaceForm({ initialName = '', onCancel, onCreated }: { initialName?: string; onCancel: () => void; onCreated: (project: Project) => void }) {
  const { space, allowed, busy, error, create, createEncrypted } = useNewProject();
  const { candidates, members, loading, companyName } = useCompanyCandidates();
  const { me } = useShellData();
  // #1424: a company owner or admin also invites someone new here, as in Space settings; the links made wait for Create space.
  const inviter = !!space && isManagerRole(space.role ?? 'guest');
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  // A link made here belongs to the space this window makes (#1424): closed without Create (Cancel, ×, Escape), or made encrypted, which takes no
  // link, the window revokes the links it made, so none is left working for the company alone.
  const made = useRef<{ workspaceId: string | null; ids: string[]; tied: boolean }>({ workspaceId: null, ids: [], tied: false });
  useEffect(() => { made.current.workspaceId = space?.id ?? null; made.current.ids = invites.map((invite) => invite.id); });
  useEffect(() => {
    const kept = made.current;
    const revoke = (keepalive: boolean) => {
      if (!kept.workspaceId || kept.tied) return;
      for (const id of kept.ids) void revokeInvite(kept.workspaceId, id, keepalive).catch(() => undefined);
    };
    // A tab closed or reloaded with the window open runs no cleanup: the links go off on the way out, as Cancel turns them off. A page kept
    // for Back (`persisted`) may come back with the window as it was, so it keeps them.
    const leaving = (event: PageTransitionEvent) => { if (!event.persisted) revoke(true); };
    window.addEventListener('pagehide', leaving);
    return () => { window.removeEventListener('pagehide', leaving); revoke(false); };
  }, []);
  const [name, setName] = useState(initialName);
  // The form says what is missing in its own words, like sign-in and sign-up, not with the browser's bubble (#763 FR-9).
  const [missing, setMissing] = useState(false);
  const [people, setPeople] = useState<string[]>([]);
  const [ai, setAi] = useState(true);
  const [encrypted, setEncrypted] = useState(false);
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [reveal, setReveal] = useState(false);
  const [problem, setProblem] = useState<{ field: 'password' | 'repeat' | 'code'; message: string } | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  // The recovery code is made when the switch is first turned on and kept only in this form until Create sends it.
  const [code, setCode] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  // The window opens on its Name (the surface takes focus first; this runs after it).
  const nameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const ids = { hint: useId(), length: useId(), code: useId(), why: useId() };
  useEffect(() => { nameRef.current?.focus(); }, []);

  // Whether this server can make encrypted spaces (its key service answers): asked once, and the switch says so when it cannot.
  useEffect(() => {
    if (!allowed) return undefined;
    const controller = new AbortController();
    getEncryptionAvailability(controller.signal).then((answer) => setAvailable(answer.available), () => { if (!controller.signal.aborted) setAvailable(false); });
    return () => controller.abort();
  }, [allowed]);

  const check = checkPassword(password);

  function chooseEncrypted(on: boolean) {
    setEncrypted(on);
    setProblem(null);
    if (on && !code) setCode(generateRecoveryCode());
  }

  async function suggest() {
    try {
      const phrase = generatePassphrase(await loadWords());
      setPassword(phrase); setRepeat(phrase); setReveal(true); setProblem(null);
    } catch { setProblem({ field: 'password', message: 'The words couldn’t be loaded. Type your own password, or try again.' }); }
  }

  function refuse(field: 'password' | 'repeat' | 'code', message: string, focus: { current: HTMLElement | null }) {
    setProblem({ field, message });
    focus.current?.focus();
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setMissing(true); return; }
    const chosen = people.filter((id) => candidates.some((member) => member.userId === id));
    if (!encrypted) {
      const project = await create(name, { ai, people: chosen, invites: invites.map((invite) => invite.id) });
      if (project) { made.current.tied = true; onCreated(project); }
      return;
    }
    if (check.problem) { refuse('password', passwordRefusal(check), passwordRef); return; }
    if (password !== repeat) { refuse('repeat', 'The two passwords don’t match.', repeatRef); return; }
    if (!code || !downloaded) { refuse('code', 'Download the recovery code first: it is the only way back in if every admin password is lost.', downloadRef); return; }
    const project = await createEncrypted(name, { people: chosen, password, recoveryCode: code });
    // What was typed is gone from the form at once; a refusal keeps the code (already downloaded) and asks for the password again.
    if (project) { setPassword(''); setRepeat(''); setCode(null); onCreated(project); }
  }

  const spaceName = name.trim() || 'this space';
  // Create stays off until the recovery code is downloaded, and the footer says why, so the reason is in view wherever the form is scrolled (#1361).
  const needsCode = encrypted && !downloaded;
  return (
    <form className="newspace newspace--pinned" aria-labelledby="newspace-title" noValidate onSubmit={(event) => void submit(event)}>
      <div className="newspace__head">
        <h2 id="newspace-title">New space</h2>
        <button type="button" className="newspace__x" aria-label="Close" onClick={onCancel}><Icon name="x" size={18} /></button>
      </div>
      <div className="newspace__body">
      <Input ref={nameRef} label="Name" aria-label="Space name" placeholder="e.g. Volunteer sign-up app" value={name} onChange={(event) => { setName(event.target.value); setMissing(false); }}
        maxLength={200} error={missing ? 'Give the space a name.' : undefined} />
      <div className="newspace__field">
        {/* You are in it without a chip: said in the one word every list of people then gives you (personas-28), Owner for the company's owner. */}
        <div className="newspace__label">People<span>{space?.role === 'owner' ? 'You’re in it as the owner.' : 'You’re in it as its admin.'}</span></div>
        {loading ? <p className="pick__none" role="status">Loading people…</p>
          : <PeoplePicker candidates={candidates} value={people} onChange={setPeople} disabled={busy} companyName={companyName}>
            {/* An encrypted space takes only people of the company (C-24): no link joins it. */}
            {inviter && space && !encrypted ? <SomeoneNew workspaceId={space.id} spaceId={null} spaceName={name.trim() || 'this space'} companyName={companyName} members={members}
              inSpace={(id) => people.includes(id)} meId={me.user.id} onTick={(id) => setPeople((list) => (list.includes(id) ? list : [...list, id]))}
              onMade={(invite) => setInvites((list) => [...list, invite])} links={invites} /> : null}
          </PeoplePicker>}
        {/* The links made here are listed while the window is open, also with Add people closed, and the window says what Cancel does to
            them before it is pressed (personas-33/34): a link already copied is never turned off without a word. */}
        {inviter && !encrypted && invites.length ? (
          <p className="newspace__hint newspace__invited" data-new-space-invites="">
            Invited with a link: {invites.map((invite) => invite.email ?? 'anyone').join(', ')}. The {invites.length === 1 ? 'link adds them' : 'links add them'} to {spaceName} once
            you create it; Cancel turns {invites.length === 1 ? 'it' : 'them'} off.
          </p>
        ) : null}
      </div>
      <div className="newspace__switches">
        {/* An encrypted space has no AI: the row stays, dimmed and off, and says so (F-026 §7 Spaces). Each row leads with its icon, as Settings'
            AI row does, so their words start at one edge (round 15 daily P2-5). */}
        {encrypted
          ? <SwitchRow label="AI" icon={<Icon name="spark" size={16} />} detail="No AI in encrypted spaces" checked={false} onChange={() => undefined} disabled />
          : <SwitchRow label="AI" icon={<Icon name="spark" size={16} />} detail="Let AI agents help in this space" checked={ai} onChange={setAi} disabled={busy} />}
        <SwitchRow label="Encrypted" icon={<Icon name="lock" size={16} />} checked={encrypted} onChange={chooseEncrypted} disabled={busy || (available === false && !encrypted)}
          detail={available === false && !encrypted ? 'Not available on this server right now: its key service isn’t running.' : 'Can’t be turned off later'} />
      {encrypted ? (
        <div className="newspace__secret" data-encryption-password="">
          <p className="newspace__hint" data-admins-see-name="">Company admins will see this space’s name, never what’s in it.</p>
          {/* The password and its repeat sit side by side where the window is wide enough, as drawn (#1361). */}
          <div className="newspace__pair">
            <Input ref={passwordRef} label="Your unlock password" type={reveal ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false}
              value={password} aria-describedby={`${ids.hint} ${ids.length}`} error={problem?.field === 'password' ? problem.message : null} disabled={busy}
              onChange={(event) => { setPassword(event.target.value); setReveal(false); setProblem(null); }} />
            <Input ref={repeatRef} label="Repeat" type={reveal ? 'text' : 'password'} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={repeat}
              error={problem?.field === 'repeat' ? problem.message : null} disabled={busy}
              onChange={(event) => { setRepeat(event.target.value); setReveal(false); setProblem(null); }} />
          </div>
          <PasswordLength id={ids.length} check={check} />
          <div className="newspace__quiet">
            <Button variant="quiet" disabled={busy} onClick={() => void suggest()}>Suggest six random words</Button>
          </div>
          <p className="newspace__hint" id={ids.hint}>Each admin of this space has their own. After each server restart, an admin of this space unlocks it with theirs.</p>
          <div className="newspace__download" data-recovery-download={downloaded ? 'done' : 'todo'}>
            <Button ref={downloadRef} variant="outline" icon={downloaded ? 'check' : undefined} disabled={busy} aria-describedby={ids.code}
              onClick={() => { if (code) { downloadRecoveryCode(spaceName, code); setDownloaded(true); setProblem(null); } }}>{downloaded ? 'Recovery code downloaded' : 'Download recovery code'}</Button>
            <p className="newspace__hint" id={ids.code}>Required before Create. It opens {spaceName} if every admin password is lost. Keep it apart from your password.</p>
            {problem?.field === 'code' ? <p className="newspace__error" role="alert"><Icon name="alert" size={14} />{problem.message}</p> : null}
          </div>
          <p className="newspace__warning">If every unlock password and the recovery code are lost, everything in this space is gone for good. Nobody can recover it, not even whoever runs this server.</p>
        </div>
      ) : null}
      </div>
      {!space ? <p role="alert" className="newspace__error">You’re not in a company on this Flux yet. Ask an admin for an invite link.</p>
        : !allowed ? <p role="alert" className="newspace__error">Guests can’t start spaces. Ask someone in {space.name} to add you to one.</p> : null}
      {error ? <p role="alert" className="newspace__error"><Icon name="alert" size={14} />{error}</p> : null}
      </div>
      <div className="newspace__foot">
        {needsCode ? <p className="newspace__why" id={ids.why} data-create-needs-code="">Download the recovery code first.</p> : null}
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="primary" busy={busy} disabled={!allowed || needsCode} aria-describedby={needsCode ? ids.why : undefined}>Create space</Button>
      </div>
    </form>
  );
}
