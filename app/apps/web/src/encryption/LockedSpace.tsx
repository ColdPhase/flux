import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams, useRevalidator, useRouteError } from 'react-router';
import { useShellData } from '../app/data';
import { Button, EmptyState, Icon, Input } from '../ui';
import { ApiError } from '../api/client';
import { encryptionProblem, isWorkspaceLocked, lockedWorkspaceId, unlockWorkspace, type WorkspaceEncryption } from './api';
import { isManagerOf, setLockedPlace, useLockedWorkspaces, useSpace } from './state';
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
  if (!names.length) return 'An owner or admin needs to unlock it.';
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `${list} can unlock it.`;
}

export function LockedSpace({ workspaceId }: { workspaceId: string | null }) {
  const space = useSpace(workspaceId);
  const { me } = useShellData();
  const revalidator = useRevalidator();
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
  const unlockedNow = !!space && encryption?.state !== 'locked';
  useEffect(() => { if (unlockedNow) void revalidator.revalidate(); }, [unlockedNow, revalidator]);

  return (
    <div className="pane-scroll"><div className="pane-in locked">
      <div className="locked__card" data-locked-space={workspaceId ?? ''}>
        {manager ? (
          <EmptyState icon="lock" level={2} title={`Unlock ${name}`}>
            <p data-locked-reason="">{reason}{' '}
              {hasPassword ? 'Type your unlock password to open it for everyone.'
                : unlocker ? `You don’t have an unlock password for ${name} yet. ${whoCanUnlock(encryption, me.user.id)}${codeExists ? ' Or use the recovery code.' : ''}`
                  : `You don’t have an unlock password for ${name} yet. ${whoCanUnlock(encryption, me.user.id)}`}</p>
            {unlocker && workspaceId ? <UnlockForm workspaceId={workspaceId} name={name} encryption={encryption} autoFocus /> : null}
          </EmptyState>
        ) : (
          <EmptyState icon="lock" level={2} title={`${name} is waiting to be unlocked`}>
            <p data-locked-reason="">{reason} {space?.role === 'guest' ? 'An owner or admin needs to unlock it.' : whoCanUnlock(encryption, me.user.id)} You can come back then.</p>
          </EmptyState>
        )}
      </div>
    </div></div>
  );
}

/**
 * The unlock field (F-030): the person's own unlock password, or the recovery code swapped in place. Used by the locked panel
 * and, after Lock now, by People → Encryption in Lock now's slot (UI audit EN-1). Errors are shown below the buttons, so
 * they never move.
 */
export function UnlockForm({ workspaceId, name, encryption, autoFocus = false, onUnlocked, onCancel }: {
  workspaceId: string; name: string; encryption: WorkspaceEncryption | null; autoFocus?: boolean; onUnlocked?: () => void; onCancel?: () => void;
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
      <Input ref={fieldRef} label={usingRecovery ? 'Recovery code' : 'Your unlock password'} type={usingRecovery ? 'text' : 'password'}
        autoComplete={usingRecovery ? 'off' : 'current-password'} autoCapitalize="none" autoCorrect="off" spellCheck={false} autoFocus={autoFocus}
        value={secret} aria-invalid={problem ? true : undefined} aria-describedby={problem ? statusId : undefined}
        onChange={(event) => { setSecret(event.target.value); if (problem) setProblem(''); }} />
      <div className="locked__actions">
        <Button type="submit" variant="primary" busy={busy}>Unlock</Button>
        {hasPassword && codeExists ? <Button variant="quiet" onClick={() => { setRecovery(!recovery); setSecret(''); setProblem(''); requestAnimationFrame(() => fieldRef.current?.focus()); }}>{recovery ? 'Use my unlock password' : 'Use the recovery code'}</Button> : null}
        {onCancel ? <Button variant="quiet" onClick={onCancel}>Cancel</Button> : null}
      </div>
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
 * The error boundary of every place in the app (F-030, #655): a place whose data answered `423 WORKSPACE_LOCKED` shows the
 * locked panel, inside the shell and at the same address. Any other error goes on to the app's own error page.
 */
export function LockedBoundary() {
  const error = useRouteError();
  if (!isWorkspaceLocked(error)) throw error;
  return <LockedSpace workspaceId={lockedWorkspaceId(error)} />;
}

/** The Inbox's and Jump to's quiet line about spaces that wait to be unlocked: what is in them is not listed, and not searched (F-030, #655). */
export function LockedSpacesNote() {
  const locked = useLockedWorkspaces();
  if (!locked.length) return null;
  return (
    <section className="locked-note" aria-labelledby="locked-note-h" data-locked-note="">
      <h2 id="locked-note-h">Waiting to be unlocked</h2>
      <p>What is inside {locked.length === 1 ? 'this space' : 'these spaces'} isn’t shown here until an owner or admin unlocks {locked.length === 1 ? 'it' : 'them'}.</p>
      <ul>
        {locked.map((space) => (
          <li key={space.id}><Link to={`/spaces/${space.id}`} data-locked-space={space.id}><Icon name="lock" size={13} />{space.name}</Link></li>
        ))}
      </ul>
    </section>
  );
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
            <Icon name="lock" size={13} /><span className="waiting-spaces__name">{space.name}</span><span className="waiting-spaces__state">Waiting to be unlocked</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Search's line about encrypted spaces it did not search (F-030, #655): one that waits to be unlocked (the shell's list, which a search
 * answer's `lockedWorkspaces` refreshes), and one the server cannot search in memory because it is too large (`sealedUnavailable`).
 */
export function UnsearchedSpaces({ tooLarge }: { tooLarge: readonly string[] }) {
  const locked = useLockedWorkspaces();
  const { workspaces } = useShellData();
  const large = tooLarge.map((id) => workspaces.find((space) => space.id === id)).filter((space): space is NonNullable<typeof space> => !!space);
  if (!locked.length && !large.length) return null;
  return (
    <ul className="unsearched" aria-label="Not searched" data-unsearched="">
      {locked.map((space) => (
        <li key={space.id} data-locked-space={space.id}><Icon name="lock" size={13} />
          <span><Link to={`/spaces/${space.id}`}>{space.name}</Link> isn’t searched while it waits to be unlocked.</span></li>
      ))}
      {large.map((space) => (
        <li key={space.id} data-too-large={space.id}><Icon name="lock" size={13} />
          <span>Search isn’t available in {space.name}: it is too large to search in memory.</span></li>
      ))}
    </ul>
  );
}
