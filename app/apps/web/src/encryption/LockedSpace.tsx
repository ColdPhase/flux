import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useParams, useRevalidator } from 'react-router';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { Button, Icon, Input } from '../ui';
import { ApiError } from '../api/client';
import { encryptionProblem, unlockWorkspace, type WorkspaceEncryption } from './api';
import { isManagerOf, lockedLine, setLockedPlace, useLockedWorkspaces, useSpace } from './state';
import './encryption.css';

/**
 * The panel of an encrypted workspace that waits to be unlocked (F-030, #655, S3). It is the page behind the sidebar's
 * "Waiting to be unlocked" row, and it replaces any place inside the workspace that is opened or open while it is locked
 * (the address stays, so Back works). A member or guest can only wait; an owner or admin unlocks here with their own
 * unlock password, or with the recovery code. Unlocking changes the page back without a reload: the shell reads the
 * workspaces again, and every place that failed with `423` loads again.
 */
const lockTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const lockDay = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
/** "at 22:10" today, "on 21 Oct at 22:10" on another day. */
function at(iso: string): string {
  const time = new Date(iso);
  if (Number.isNaN(time.getTime())) return '';
  return time.toDateString() === new Date().toDateString() ? `at ${lockTime.format(time)}` : `on ${lockDay.format(time)} at ${lockTime.format(time)}`;
}
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Why the space is locked (UI audit LK-1): "Ada locked Garden club at 22:10." or "The server restarted at 22:15." */
export function lockedReason(encryption: WorkspaceEncryption | null, name: string, meId: string): string {
  const because = encryption?.lockedBecause;
  if (!because) return 'Its content is encrypted.';
  const when = at(because.at);
  if (because.reason === 'restart') return `The server restarted${when ? ` ${when}` : ''}.`;
  const who = because.by ? (because.by.id === meId ? 'You' : firstName(because.by.name)) : 'Someone';
  return `${who} locked ${name}${when ? ` ${when}` : ''}.`;
}

/** "Ada, Jonas or Ben can unlock it.": the owners and admins with an unlock password, by first name. */
export function whoCanUnlock(encryption: WorkspaceEncryption | null, meId: string): string {
  const names = (encryption?.unlockers ?? []).filter((person) => person.id !== meId).map((person) => firstName(person.name));
  if (!names.length) return 'An admin of this space needs to unlock it.';
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `${list} can unlock it.`;
}

/** False while focus is on purpose inside a panel or dialog (an admin who just pressed Lock now in the keys panel keeps their button). */
const focusIsFree = () => typeof document === 'undefined' || !document.activeElement?.closest('.ui-panel__body, [role="dialog"]');

export function LockedSpace({ workspaceId }: { workspaceId: string | null }) {
  const space = useSpace(workspaceId);
  const { me } = useShellData();
  const revalidator = useRevalidator();
  const { openDetails } = useShellActions();
  const name = space?.name ?? 'This space';
  const encryption = space?.encryption ?? null;
  const manager = isManagerOf(space);
  // `canUnlock` is the server's answer: an owner or admin with an unlock password, or with the recovery code while one exists.
  const unlocker = manager && !!encryption?.canUnlock;
  const hasPassword = !!encryption?.myPassword;
  const codeExists = !!encryption?.recoveryCode;
  const reason = lockedReason(encryption, name, me.user.id);

  // The shell names this space in its header while the panel is on show.
  useLayoutEffect(() => {
    setLockedPlace(workspaceId);
    return () => setLockedPlace(null);
  }, [workspaceId]);

  // The space is open for this tab already (another tab or person unlocked it, and the shell has read that): load the place again.
  // Once each time the shell turns to "open": `revalidator` is a new object on every revalidation, so with it as a dependency a
  // shell read that still says open while the place answers 423 (the lock not yet in the list) read everything again without end.
  const unlockedNow = !!space && encryption?.state !== 'locked';
  const revalidate = useRef(revalidator.revalidate);
  useLayoutEffect(() => { revalidate.current = revalidator.revalidate; });
  useEffect(() => { if (unlockedNow) void revalidate.current(); }, [unlockedNow]);

  // One calm card in the middle of the space's pane (F-026 §7 Spaces): the lock, "<name> is locked", what happened and who can unlock it. A
  // member only waits; a space admin who can unlock it has the field, Unlock and the recovery code in the same card. The header above it
  // is the space's own, so nothing here repeats it.
  const text = manager
    ? hasPassword ? `${reason} Type your unlock password to open it for everyone.`
      : unlocker ? `${reason} You don’t have an unlock password for ${name} yet. ${whoCanUnlock(encryption, me.user.id)}${codeExists ? ' Or use the recovery code.' : ''}`
        : `${reason} You don’t have an unlock password for ${name} yet. ${whoCanUnlock(encryption, me.user.id)}`
    : `${reason} ${space?.role === 'guest' ? 'An admin of this space unlocks it.' : whoCanUnlock(encryption, me.user.id)}`;
  // A locked space has no settings page to reach its keys from: its admins open them here (who has a password, a rotation waiting). Inside the
  // form, above the line a refusal is said in, so that reserved line is at the card's foot instead of a gap above this (review of #1360).
  const keys = workspaceId ? <Button variant="quiet" data-encrypted-keys="" onClick={() => openDetails({ kind: 'people', workspaceId })}>People and encryption</Button> : null;
  return (
    <div className="pane-scroll"><div className="pane-in locked">
      <div className="locked__card" data-locked-space={workspaceId ?? ''}>
        <span className="locked__icon" aria-hidden="true"><Icon name="lock" size={20} /></span>
        <h2 className="locked__title">{name} is locked</h2>
        <p className="locked__text" data-locked-reason="">{text}</p>
        {manager && unlocker && workspaceId ? <UnlockForm workspaceId={workspaceId} name={name} encryption={encryption} autoFocus={focusIsFree()} more={keys} /> : null}
        {manager && !unlocker ? keys : null}
      </div>
    </div></div>
  );
}

/**
 * The unlock field (F-030): the person's own unlock password, or the recovery code swapped in place. Used by the locked panel
 * and, after Lock now, by People → Encryption in Lock now's slot (UI audit EN-1). Errors are shown below the buttons, so
 * they never move.
 */
export function UnlockForm({ workspaceId, name, encryption, autoFocus = false, onUnlocked, onCancel, more }: {
  workspaceId: string; name: string; encryption: WorkspaceEncryption | null; autoFocus?: boolean; onUnlocked?: () => void; onCancel?: () => void;
  /** One more quiet action on its own row under the others, above the refusal line (the locked card's "People and encryption"). */
  more?: ReactNode;
}) {
  const revalidator = useRevalidator();
  const hasPassword = !!encryption?.myPassword;
  // A key rotation ends the old recovery code until an owner makes a new one (F-030, #655).
  const codeExists = !!encryption?.recoveryCode;
  const [recovery, setRecovery] = useState(false);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const inFlight = useRef(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const statusId = useId();
  const usingRecovery = (recovery && codeExists) || !hasPassword;

  async function unlock(event: FormEvent) {
    event.preventDefault();
    if (busy || inFlight.current) return;
    if (!secret.trim()) {
      setProblem(usingRecovery ? 'Enter the recovery code.' : 'Enter your unlock password.');
      fieldRef.current?.focus();
      return;
    }
    inFlight.current = true;
    setBusy(true); setProblem('');
    try {
      await unlockWorkspace(workspaceId, usingRecovery ? { recoveryCode: secret.trim() } : { password: secret });
      setSecret('');
      await revalidator.revalidate();
      onUnlocked?.();
    } catch (error) {
      setSecret('');
      setProblem(error instanceof ApiError && error.code === 'UNLOCK_INCORRECT' && usingRecovery
        ? `That recovery code doesn’t unlock ${name}.` : encryptionProblem(error, { workspace: name }));
      fieldRef.current?.focus();
    } finally { inFlight.current = false; setBusy(false); }
  }

  return (
    <form className="locked__form" onSubmit={(event) => void unlock(event)} noValidate aria-label={`Unlock ${name}`}
      onKeyDown={onCancel ? (event) => { if (event.key === 'Escape') { event.stopPropagation(); onCancel(); } } : undefined}>
      <div className="locked__row">
        <Input ref={fieldRef} label={usingRecovery ? 'Recovery code' : 'Your unlock password'} type={usingRecovery ? 'text' : 'password'}
          autoComplete={usingRecovery ? 'off' : 'current-password'} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus={autoFocus}
          value={secret} aria-invalid={problem ? true : undefined} aria-describedby={problem ? statusId : undefined}
          onChange={(event) => { setSecret(event.target.value); if (problem) setProblem(''); }} />
        <Button type="submit" variant="primary" busy={busy}>Unlock</Button>
      </div>
      <div className="locked__actions">
        {hasPassword && codeExists ? <Button variant="quiet" onClick={() => { setRecovery(!recovery); setSecret(''); setProblem(''); requestAnimationFrame(() => fieldRef.current?.focus()); }}>{recovery ? 'Use my unlock password' : 'Use the recovery code'}</Button> : null}
        {onCancel ? <Button variant="secondary" onClick={onCancel}>Cancel</Button> : null}
      </div>
      {/* Its own row, so a longer "Use my unlock password" never wraps the row above and moves the field. */}
      {more ? <div className="locked__actions">{more}</div> : null}
      {/* Below the buttons, so an error never moves them. */}
      <p className="locked__status" id={statusId} role="alert">{problem}</p>
    </form>
  );
}

/** The sidebar row's page: `/spaces/:workspaceId`. Once the space is unlocked it leads into its first project, or Home. */
export function LockedSpacePage() {
  const workspaceId = useParams().workspaceId ?? '';
  const { projects, workspaces } = useShellData();
  const navigate = useNavigate();
  const space = useSpace(workspaceId);
  const open = workspaces.some((item) => item.id === workspaceId);
  const first = projects.find((project) => project.workspaceId === workspaceId)?.id;
  useEffect(() => { if (open) navigate(first ? `/projects/${first}` : '/', { replace: true }); }, [open, first, navigate]);
  // A space the person is not in (or that is gone) is not a locked one.
  if (!space && !open) return <Navigate to="/" replace />;
  return <LockedSpace workspaceId={workspaceId} />;
}

/**
 * Home's "Needs you" (F-030, #655): what needs the person in a space that waits to be unlocked is not known until it is unlocked, so the
 * queue says which spaces it could not look into, one quiet row each, instead of "Nothing needs you".
 */
export function WaitingSpaces() {
  const locked = useLockedWorkspaces();
  if (!locked.length) return null;
  return (
    <ul className="waiting-spaces" aria-label="Waiting to be unlocked" data-waiting-spaces="">
      {locked.map((space) => (
        <li key={space.id}>
          <Link to={`/spaces/${space.id}`} data-locked-space={space.id}>
            <Icon name="lock" size={13} /><span className="waiting-spaces__name">{space.name}</span><span className="waiting-spaces__state">{lockedLine(space)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Search's line about an encrypted space the server cannot search in memory because it is too large (`sealedUnavailable`, F-030, #655). One
 * that waits to be unlocked is not named here: the sidebar and Home say it waits, and Search says nothing (#1419 item 16).
 */
export function UnsearchedSpaces({ tooLarge }: { tooLarge: readonly string[] }) {
  const { workspaces } = useShellData();
  const large = tooLarge.map((id) => workspaces.find((space) => space.id === id)).filter((space): space is NonNullable<typeof space> => !!space);
  if (!large.length) return null;
  return (
    <ul className="unsearched" aria-label="Not searched" data-unsearched="">
      {large.map((space) => (
        <li key={space.id} data-too-large={space.id}><Icon name="lock" size={13} />
          <span>Search isn’t available in {space.name}: it is too large to search in memory.</span></li>
      ))}
    </ul>
  );
}
