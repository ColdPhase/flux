import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { WorkspaceMember } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, Input, Option, Select } from '../ui';
import { encryptionProblem, grantUnlockPassword, isWrongPassword, lockWorkspace, newRecoveryCode, setUnlockPassword, type EncryptedWorkspace, type KeyRotation } from './api';
import { checkPassword, generatePassphrase, loadWords } from './passphrase';
import { PasswordLength, passwordRefusal } from './PasswordLength';
import { RecoveryCodeBlock } from './RecoveryCode';

const timeOnly = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const dayOnly = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** "at 09:12" today, "on 21 Oct at 09:12" on another day. */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const today = new Date();
  if (at.toDateString() === today.toDateString()) return `at ${timeOnly.format(at)}`;
  return `on ${dayOnly.format(at)} at ${timeOnly.format(at)}`;
}

type Panel =
  | { kind: 'password'; via: 'current' | 'recovery' | 'grant' }
  | { kind: 'lock' }
  | { kind: 'code' }
  | { kind: 'allow' }
  | { kind: 'shown'; code: string };

const first = (person: string) => person.trim().split(/\s+/)[0] || person;

/**
 * People → Encryption (F-030, #655, S3): its own section before AI, in its place in every state. Everyone reads the first
 * line. Owners and admins get a row of quiet buttons whose places never change: only a button's label or its dimming does
 * (a button that cannot act now is dimmed, not removed). Each button opens one inline group below the row, one at a time.
 * Passwords and the recovery code are typed or shown here and kept nowhere.
 *
 * The wire says whether the caller has a password, when a holder's permission to set a first one ends
 * (`passwordGrantUntil`), whether a recovery code exists, and, on the member rows a holder reads, who lacks a password
 * (`unlockPassword`). So an owner or admin without a password sees **Set your unlock password** while a holder's permission
 * lasts, **Use the recovery code** otherwise, and a dimmed **Set your unlock password** when neither is possible; a holder
 * who lets someone set a first password is offered only the owners and admins without one.
 */
type RotationState = 'stalled' | 'paused' | 'starting' | 'running';
/** Where a key rotation is (S2c): it cannot finish; it waits for an unlock; it is about to start (pending while unlocked); it runs. */
function rotationState(rotation: KeyRotation, locked: boolean): RotationState {
  if (rotation.stalled) return 'stalled';
  if (locked) return 'paused';
  if (!rotation.startedAt) return 'starting';
  return rotation.paused ? 'paused' : 'running';
}
function rotationLine(rotation: KeyRotation, locked: boolean, name: string): string {
  switch (rotationState(rotation, locked)) {
    // What the security notice every holder gets says too: no table, no column, nothing about the content.
    case 'stalled': return 'The key change can’t finish: some stored data doesn’t open. Ask your server’s operator.';
    case 'paused': return `Changing the key · paused until ${name} is unlocked.`;
    case 'starting': return `Changing the key · starting. It continues while ${name} is unlocked.`;
    default: return `Changing the key · ${Math.max(0, Math.min(99, Math.round(rotation.percent)))}%. It continues while ${name} is unlocked.`;
  }
}

export function EncryptionSection({ workspace, members, meId, myRole, offerCode, onChanged }: {
  workspace: EncryptedWorkspace; members: WorkspaceMember[] | null; meId: string; myRole: string;
  /** Counts up when an owner has just removed an owner or admin: the group that makes a new recovery code opens in place. */
  offerCode: number; onChanged: () => void;
}) {
  const enc = workspace.encryption;
  const name = workspace.name;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [status, setStatus] = useState('');
  const [offered, setOffered] = useState(offerCode);
  if (offered !== offerCode) { setOffered(offerCode); setPanel({ kind: 'code' }); setStatus(''); }
  const triggers = useRef<Record<string, HTMLButtonElement | null>>({});
  const headingId = useId();
  const lineId = useId();
  if (!enc) return null;

  const manager = myRole === 'owner' || myRole === 'admin';
  const owner = myRole === 'owner';
  const locked = enc.state === 'locked';
  // A key rotation (an owner or admin left) ends the old recovery code until an owner makes a new one.
  const noCode = !enc.recoveryCode;
  const rotation = enc.rotation as KeyRotation | null;
  const changedOn = enc.keyChangedAt && !Number.isNaN(Date.parse(enc.keyChangedAt)) ? dayOnly.format(new Date(enc.keyChangedAt)) : '';
  // The other owners and admins, whom a holder can let set a first password.
  const candidates = manager && enc.myPassword && members
    ? members.filter((member) => member.userId !== meId && (member.role === 'owner' || member.role === 'admin') && member.unlockPassword === false) : [];
  // A first password: with a holder's permission, or with the recovery code. Neither: the button waits, dimmed, in its place.
  // The server names only a grant that is valid when it answers; one that ran out since is answered in place (403) when it is used.
  const grantUntil = !enc.myPassword && enc.passwordGrantUntil && !Number.isNaN(Date.parse(enc.passwordGrantUntil)) ? enc.passwordGrantUntil : null;
  const firstPassword: Panel = enc.myPassword ? { kind: 'password', via: 'current' } : { kind: 'password', via: grantUntil ? 'grant' : 'recovery' };
  const canFirst = enc.myPassword || !!grantUntil || !noCode;
  const passwordLabel = enc.myPassword ? 'Change your unlock password' : grantUntil || noCode ? 'Set your unlock password' : 'Use the recovery code';

  const unlockedLine = `Unlocked${enc.unlockedBy ? ` by ${enc.unlockedBy.name}` : ''}${enc.unlockedAt ? ` ${when(enc.unlockedAt)}` : ''}.`;
  const closeTo = (key: string) => { setPanel(null); requestAnimationFrame(() => triggers.current[key]?.focus({ preventScroll: true })); };
  const toggle = (next: Panel) => {
    setStatus('');
    setPanel((open) => (open && JSON.stringify(open) === JSON.stringify(next) ? null : next));
  };
  // A button that cannot act while the space is locked is dimmed and still reachable, so nothing around it moves.
  const dim = (also = false) => ({ ...(locked || also ? { 'aria-disabled': true as const } : {}), className: `people__enc-button${locked || also ? ' is-dim' : ''}` });
  const guard = (run: () => void, also = false) => () => { if (locked || also) return; run(); };
  const saved = (message: string, key: string) => { setStatus(message); closeTo(key); onChanged(); };

  return (
    <section className="details__sec people__enc" aria-labelledby={headingId} data-encryption-section={enc.state}>
      <h4 id={headingId}>Encryption</h4>
      <p className="people__enc-line" id={lineId}>Encrypted · only people, no AI. {locked ? 'Waiting to be unlocked.' : unlockedLine}</p>
      {manager ? (
        <>
          <div className="people__enc-actions">
            <Button ref={(element) => { triggers.current.password = element; }} variant="quiet" {...dim(!canFirst)} aria-expanded={panel?.kind === 'password'}
              onClick={guard(() => toggle(firstPassword), !canFirst)}>{passwordLabel}</Button>
            <Button ref={(element) => { triggers.current.lock = element; }} variant="quiet" {...dim()} aria-expanded={panel?.kind === 'lock'} onClick={guard(() => toggle({ kind: 'lock' }))}>Lock now</Button>
            {owner ? <Button ref={(element) => { triggers.current.code = element; }} variant="quiet" {...dim()} aria-expanded={panel?.kind === 'code' || panel?.kind === 'shown'} onClick={guard(() => toggle({ kind: 'code' }))}>{noCode ? 'Make a new recovery code' : 'New recovery code'}</Button> : null}
            {candidates.length ? (
              <Button ref={(element) => { triggers.current.allow = element; }} variant="quiet" {...dim()} aria-expanded={panel?.kind === 'allow'} onClick={guard(() => toggle({ kind: 'allow' }))}>
                {candidates.length === 1 ? `Let ${first(candidates[0]!.name)} set an unlock password` : 'Let someone set an unlock password'}
              </Button>
            ) : null}
          </div>
          {locked ? <p className="people__hint">These need {name} to be unlocked first.</p> : null}
          {grantUntil ? <p className="people__hint" data-password-grant="">You can set an unlock password until {timeOnly.format(new Date(grantUntil))}.</p>
            : !enc.myPassword ? <p className="people__hint">You don’t have an unlock password yet. Another owner or admin can let you set one{noCode ? '.' : ', or use the recovery code.'}</p> : null}
          {rotation ? <p className="people__hint" data-key-rotation={rotationState(rotation, locked)}>{rotationLine(rotation, locked, name)}</p>
            : changedOn ? <p className="people__hint" data-key-changed="">New key since {changedOn}.</p> : null}
          {noCode ? <p className="people__hint" data-no-recovery-code="">{owner ? `${name} has no recovery code. Make a new one and keep it safe.` : `${name} has no recovery code. An owner can make a new one.`}</p> : null}
        </>
      ) : null}

      {panel?.kind === 'password' ? (
        <PasswordEditor key={panel.via} workspace={workspace} start={panel.via} recoveryCode={!noCode} onClose={() => closeTo('password')}
          onSaved={(message) => saved(message, 'password')} />
      ) : null}
      {panel?.kind === 'lock' ? (
        <LockConfirm workspace={workspace} onClose={() => closeTo('lock')} onLocked={() => saved(`${name} is locked.`, 'lock')} />
      ) : null}
      {panel?.kind === 'code' ? (
        <NewCodeConfirm workspace={workspace} none={noCode} onClose={() => closeTo('code')} onMade={(code) => { setPanel({ kind: 'shown', code }); onChanged(); }} />
      ) : null}
      {panel?.kind === 'shown' ? (
        <div className="people__edit people__code" role="group" aria-label="Your new recovery code">
          <RecoveryCodeBlock workspaceName={name} code={panel.code} lead={`This code unlocks ${name} if every password is lost. The old code no longer works. It’s shown only now: print it or write it down and keep it somewhere safe.`}
            onDone={() => { setStatus('The new recovery code is in use.'); closeTo('code'); }} />
        </div>
      ) : null}
      {panel?.kind === 'allow' && candidates.length ? (
        <AllowConfirm workspace={workspace} candidates={candidates} onClose={() => closeTo('allow')}
          onAllowed={(person, until) => saved(`${first(person.name)} can set an unlock password ${until ? `until ${timeOnly.format(new Date(until))}` : 'now'}.`, 'allow')} />
      ) : null}
      <p className="people__done" role="status">{status ? <><Icon name="check" size={13} />{status}</> : null}</p>
    </section>
  );
}

/** Focuses the first field of a group when it opens. */
function useFocusFirst<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: false }); }, []);
  return ref;
}

const closeOnEscape = (onClose: () => void) => (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };

/** Asks for the holder's own unlock password before a lock-sensitive change. */
function ConfirmGroup({ label, line, field, action, busy, problem, onSubmit, onClose }: {
  label: string; line: string; field: string; action: string; busy: boolean; problem: string; onSubmit: (password: string) => void; onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const ref = useFocusFirst<HTMLInputElement>();
  const submit = (event: FormEvent) => { event.preventDefault(); if (!busy && password) onSubmit(password); };
  return (
    <form className="details__confirm people__confirm people__edit" role="group" aria-label={label} onSubmit={submit} onKeyDown={closeOnEscape(onClose)} noValidate>
      <p>{line}</p>
      <Input ref={ref} label={field} type="password" autoComplete="current-password" autoCapitalize="none" spellCheck={false} value={password} aria-invalid={problem ? true : undefined}
        onChange={(event) => setPassword(event.target.value)} />
      <div className="details__actions">
        <Button type="submit" variant="primary" busy={busy} aria-disabled={!password || undefined}>{action}</Button>
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
      </div>
      <p className="people__problem" role="alert">{problem}</p>
    </form>
  );
}

/** "Lock now": everyone loses access until an owner or admin unlocks it again. */
function LockConfirm({ workspace, onClose, onLocked }: { workspace: EncryptedWorkspace; onClose: () => void; onLocked: () => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const first = useFocusFirst<HTMLButtonElement>();
  async function lock() {
    if (busy) return;
    setBusy(true); setProblem('');
    try { await lockWorkspace(workspace.id); onLocked(); }
    catch (error) { setProblem(encryptionProblem(error, { workspace: workspace.name })); setBusy(false); }
  }
  return (
    <div className="details__confirm people__confirm people__edit" role="group" aria-label={`Lock ${workspace.name}`} onKeyDown={closeOnEscape(onClose)}>
      <p>Everyone in {workspace.name} loses access until an owner or admin unlocks it again.</p>
      <div className="details__actions">
        <Button ref={first} variant="primary" busy={busy} onClick={() => void lock()}>Lock {workspace.name}</Button>
        <Button variant="quiet" onClick={onClose}>Keep it unlocked</Button>
      </div>
      <p className="people__problem" role="alert">{problem}</p>
    </div>
  );
}

/** "New recovery code" (owners): the old one stops working, so it asks for the owner's own unlock password. */
function NewCodeConfirm({ workspace, none, onClose, onMade }: { workspace: EncryptedWorkspace; none: boolean; onClose: () => void; onMade: (code: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  async function make(password: string) {
    setBusy(true); setProblem('');
    try { onMade((await newRecoveryCode(workspace.id, password)).recoveryCode); }
    catch (error) { setProblem(isWrongPassword(error) ? `That password doesn’t unlock ${workspace.name}.` : encryptionProblem(error, { workspace: workspace.name })); setBusy(false); }
  }
  return <ConfirmGroup label="New recovery code" line={none ? `${workspace.name} has no recovery code now. Enter your own unlock password to make one.` : 'The old code stops working. Enter your own unlock password to make a new one.'} field="Your unlock password" action="Make a new code" busy={busy} problem={problem} onSubmit={(password) => void make(password)} onClose={onClose} />;
}

/** "Let Ben set an unlock password": the holder's own password allows it for a short time; Ben's session alone could never add one. */
function AllowConfirm({ workspace, candidates, onClose, onAllowed }: {
  workspace: EncryptedWorkspace; candidates: WorkspaceMember[]; onClose: () => void; onAllowed: (person: WorkspaceMember, until: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [who, setWho] = useState(candidates[0]!.userId);
  const [password, setPassword] = useState('');
  const person = candidates.find((candidate) => candidate.userId === who) ?? candidates[0]!;
  const firstName = first(person.name);
  const selectId = useId();
  const ref = useFocusFirst<HTMLInputElement>();
  async function allow(event: FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true); setProblem('');
    try {
      const granted = await grantUnlockPassword(workspace.id, person.userId, password);
      onAllowed(person, granted?.expiresAt && !Number.isNaN(Date.parse(granted.expiresAt)) ? granted.expiresAt : null);
    } catch (error) {
      setProblem(error instanceof ApiError && error.code === 'UNLOCK_INCORRECT' ? `That password doesn’t unlock ${workspace.name}.` : encryptionProblem(error, { workspace: workspace.name, who: firstName }));
      if (error instanceof ApiError && error.code === 'UNLOCK_INCORRECT') setPassword('');
      setBusy(false);
    }
  }
  return (
    <form className="details__confirm people__confirm people__edit" role="group" aria-label={candidates.length === 1 ? `Let ${firstName} set an unlock password` : 'Let someone set an unlock password'}
      onSubmit={(event) => void allow(event)} onKeyDown={closeOnEscape(onClose)} noValidate>
      <p>Enter your own unlock password to let {candidates.length === 1 ? firstName : 'them'} set theirs. It’s allowed for a short time, and it gives {candidates.length === 1 ? firstName : 'them'} no key.</p>
      {candidates.length > 1 ? (
        <div className="people__field">
          <label htmlFor={selectId}>Who</label>
          <Select id={selectId} value={who} onChange={(next) => { setWho(next); setProblem(''); }}>
            {candidates.map((candidate) => <Option key={candidate.userId} value={candidate.userId}>{candidate.name}</Option>)}
          </Select>
        </div>
      ) : null}
      <Input ref={ref} label="Your unlock password" type="password" autoComplete="current-password" autoCapitalize="none" spellCheck={false} value={password} aria-invalid={problem ? true : undefined}
        onChange={(event) => setPassword(event.target.value)} />
      <div className="details__actions">
        <Button type="submit" variant="primary" busy={busy} aria-disabled={!password || undefined}>Let {firstName} set one</Button>
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
      </div>
      <p className="people__problem" role="alert">{problem}</p>
    </form>
  );
}

/**
 * Set or change the person's own unlock password. Changing needs the current password or the recovery code; a first password
 * needs a holder's permission (a grant) or the recovery code. The new one follows the rule the server enforces.
 */
function PasswordEditor({ workspace, start, recoveryCode, onClose, onSaved }: { workspace: EncryptedWorkspace; start: 'current' | 'recovery' | 'grant'; recoveryCode: boolean; onClose: () => void; onSaved: (message: string) => void }) {
  const [via, setVia] = useState(start);
  const [secret, setSecret] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [nextError, setNextError] = useState('');
  const [repeatError, setRepeatError] = useState('');
  const secretRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);
  const lengthId = useId();
  const check = checkPassword(next);
  useEffect(() => { (via === 'grant' ? nextRef : secretRef).current?.focus(); }, [via]);

  async function suggest() {
    try {
      const phrase = generatePassphrase(await loadWords());
      setNext(phrase); setRepeat(phrase); setShown(true); setNextError(''); setRepeatError('');
    } catch { setProblem('The words couldn’t be loaded. Type a password of your own.'); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setProblem('');
    if (via !== 'grant' && !secret.trim()) { setProblem(via === 'current' ? 'Enter your current unlock password.' : 'Enter the recovery code.'); secretRef.current?.focus(); return; }
    if (check.problem) { setNextError(passwordRefusal(check)); nextRef.current?.focus(); return; }
    if (next !== repeat) { setRepeatError('The two passwords don’t match.'); repeatRef.current?.focus(); return; }
    setBusy(true);
    try {
      await setUnlockPassword(workspace.id, via === 'current' ? { currentPassword: secret, newPassword: next } : via === 'recovery' ? { recoveryCode: secret.trim(), newPassword: next } : { newPassword: next });
      onSaved(start === 'current' ? 'Your unlock password was changed.' : 'Your unlock password is set.');
    } catch (error) {
      if (isWrongPassword(error)) { setProblem(via === 'recovery' ? `That recovery code doesn’t unlock ${workspace.name}.` : `That password doesn’t unlock ${workspace.name}.`); setSecret(''); secretRef.current?.focus(); }
      else if (error instanceof ApiError && error.code === 'PASSWORD_TOO_WEAK') { setNextError(encryptionProblem(error, { workspace: workspace.name })); nextRef.current?.focus(); }
      else setProblem(encryptionProblem(error, { workspace: workspace.name }));
      setBusy(false);
    }
  }

  const type = shown ? 'text' : 'password';
  return (
    <form className="people__edit people__password" role="group" aria-label={start === 'current' ? 'Change your unlock password' : 'Set your unlock password'} onSubmit={(event) => void submit(event)} onKeyDown={closeOnEscape(onClose)} noValidate>
      {via !== 'grant' ? (
        <Input ref={secretRef} label={via === 'current' ? 'Your current unlock password' : 'Recovery code'} type={via === 'current' ? 'password' : 'text'} autoComplete={via === 'current' ? 'current-password' : 'off'}
          autoCapitalize="none" spellCheck={false} value={secret} onChange={(event) => { setSecret(event.target.value); if (problem) setProblem(''); }} />
      ) : null}
      <Input ref={nextRef} label="New unlock password" type={type} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={next} error={nextError || null} aria-describedby={lengthId}
        onChange={(event) => { setNext(event.target.value); if (nextError) setNextError(''); }} />
      <PasswordLength id={lengthId} check={check} />
      <Input ref={repeatRef} label="Repeat new password" type={type} autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={repeat} error={repeatError || null}
        onChange={(event) => { setRepeat(event.target.value); if (repeatError) setRepeatError(''); }} />
      <div className="people__enc-quiet">
        <Button variant="quiet" onClick={() => void suggest()}>Suggest six random words</Button>
        {recoveryCode && start !== 'recovery' ? <Button variant="quiet" onClick={() => { setVia(via === 'recovery' ? start : 'recovery'); setSecret(''); setProblem(''); }}>{via === 'recovery' ? (start === 'current' ? 'Use my current password' : 'Use a holder’s permission instead') : 'Use the recovery code instead'}</Button> : null}
      </div>
      <div className="details__actions">
        <Button type="submit" variant="primary" busy={busy}>{start === 'current' ? 'Save password' : 'Set password'}</Button>
        <Button variant="quiet" onClick={onClose}>Cancel</Button>
      </div>
      <p className="people__problem" role="alert">{problem}</p>
    </form>
  );
}
