import { useCallback, useEffect, useId, useMemo, useRef, useState, Fragment, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  NOTIFICATION_REASONS,
  type ChannelChoice,
  type EmailDestination,
  type NotificationChannel,
  type NotificationLevel,
  type NotificationPreferences,
  type NotificationReason,
  type UpdateNotificationPreferencesCommand,
} from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { clock } from '../app/focus';
import { SwitchRow } from '../app/SettingsHome';
import { NotificationsButton } from '../pwa';
import { getPushState } from '../pwa/push';
import { Button, ErrorState, Icon, Spinner, useToast } from '../ui';
import { PAUSE_CHANGED, addAddress, announcePauseChange, announcePauseUncertainty, getPreferences, removeAddress, resendVerification, setMute, unsubscribe, updatePreferences, verifyAddress, type PauseChange } from './api';
import { captureNotificationSession, confirmedNotificationPauseSince, isCurrentNotificationSession, notificationPauseRevision, notificationPauseUncertain } from './session';
import './notifications.css';

const ROWS: Record<NotificationReason, { label: string; hint: string }> = {
  mention: { label: 'Mentions', hint: '@you in a project conversation' },
  question: { label: 'Questions to you', hint: 'Someone asks you directly' },
  dm: { label: 'Direct messages', hint: 'Messages to you, outside projects' },
  reply: { label: 'Replies', hint: 'In conversations you started or joined' },
  assigned: { label: 'Work assigned to you', hint: 'Someone else makes you the owner' },
  review: { label: 'Reviews for you', hint: 'Decisions and results about your work or agent' },
  invitation: { label: 'Invitations to work together', hint: 'Someone asks you to join them at a task, map, doc or conversation' },
};
const LEVELS: { id: NotificationLevel; label: string; detail?: string }[] = [
  { id: 'needsYou', label: 'Only “Needs you”', detail: 'Decisions, agent questions, blockers on your tasks, mentions' },
  { id: 'everything', label: 'Everything', detail: 'Also every reply in conversations you are part of' },
  { id: 'nothing', label: 'Nothing' },
];
const COLUMNS: { id: NotificationChannel; label: string }[] = [
  { id: 'inApp', label: 'Inbox' },
  { id: 'push', label: 'Push' },
  { id: 'email', label: 'Email' },
];

function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function timeZones(current: string) {
  let zones: string[] = [];
  try { zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { zones = []; }
  return [...new Set([current, browserTimeZone(), 'UTC', ...zones])].sort((a, b) => a.localeCompare(b));
}

type FeedbackArea = 'level' | 'quietHours' | 'morningSummary' | 'email' | 'mute' | NotificationReason;
type MuteReceipt = { place: NotificationPreferences['muted'][number]; muted: boolean; index: number };
type MutedPlaceRow = { place: NotificationPreferences['muted'][number]; receiptOnly: boolean };

const message = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);

/**
 * Notification settings (#116, #350 S22): Only "Needs you", Everything or Nothing, quiet hours and
 * the morning summary first; then per reason where it reaches you, where email goes (your sign-in
 * address, a verified extra address, both or nowhere) and muted places. Every change saves at once;
 * nothing here changes how you sign in.
 */
export function NotificationSettings() {
  const { me } = useShellData();
  return <AccountNotificationSettings key={me.user.id} />;
}

function AccountNotificationSettings() {
  const { me, projects, directMessages } = useShellData();
  const ownerId = me.user.id;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState('');
  const [feedbackArea, setFeedbackArea] = useState<FeedbackArea | null>(null);
  const [muteReceipt, setMuteReceipt] = useState<MuteReceipt | null>(null);
  const [emailTarget, setEmailTarget] = useState<string | null>(null);
  const [emailNoticeAtHead, setEmailNoticeAtHead] = useState(false);
  const emailReadNoticeRef = useRef<HTMLParagraphElement | null>(null);
  const emailHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [refreshWarning, setRefreshWarning] = useState<'pause' | 'settings' | null>(null);
  const [pauseExpired, setPauseExpired] = useState(false);
  const hasPreferences = useRef(false);
  const toast = useToast();
  const ids = { email: useId(), level: useId(), what: useId(), mute: useId() };

  const queue = useRef<Promise<void>>(Promise.resolve());
  const sequence = useRef(0);
  const reads = useRef(0);
  const reconcilePause = useCallback((next: NotificationPreferences, revision: number): NotificationPreferences => {
    const latest = confirmedNotificationPauseSince(captureNotificationSession(ownerId), revision);
    return latest === undefined ? next : { ...next, pause: { until: latest } };
  }, [ownerId]);
  const load = useCallback(() => {
    const mine = ++reads.current, edit = sequence.current;
    const session = captureNotificationSession(ownerId);
    const pauseVersion = notificationPauseRevision(session);
    getPreferences().then((next) => {
      if (mounted.current && mine === reads.current && edit === sequence.current && (!session || isCurrentNotificationSession(session))) {
        const result = reconcilePause(next, pauseVersion);
        hasPreferences.current = true;
        setPrefs(result); setFailed(false); setRefreshWarning(null);
        setMuteReceipt(null); setEmailTarget(null); setEmailNoticeAtHead(false);
        setPauseExpired(result.pause.until !== null && Date.parse(result.pause.until) <= Date.now());
        announcePauseChange(ownerId, result.pause.until);
      }
    }, () => {
      if (mounted.current && mine === reads.current && edit === sequence.current && (!session || isCurrentNotificationSession(session))) {
        if (hasPreferences.current) setRefreshWarning('settings');
        else setFailed(true);
        if (session && notificationPauseRevision(session) === pauseVersion) announcePauseUncertainty(session);
      }
    });
  }, [ownerId, reconcilePause]);
  useEffect(load, [load]);
  useEffect(() => {
    const changed = (event: Event) => {
      const update = (event as CustomEvent<PauseChange>).detail;
      if (update.ownerId === ownerId && isCurrentNotificationSession(captureNotificationSession(ownerId))) {
        setPrefs((current) => current ? { ...current, pause: { until: update.until } } : current);
        setPauseExpired(update.until !== null && Date.parse(update.until) <= Date.now());
        setRefreshWarning((current) => current === 'settings' ? current : update.uncertain ? 'pause' : null);
      }
    };
    window.addEventListener(PAUSE_CHANGED, changed);
    return () => window.removeEventListener(PAUSE_CHANGED, changed);
  }, [ownerId]);
  // Push cannot reach anyone when the server has no VAPID keys or the browser has no push.
  const [pushOff, setPushOff] = useState<string | null>(null);
  useEffect(() => {
    getPushState().then((push) => { if (mounted.current) setPushOff(push.state === 'unavailable' ? 'Push is not set up on this Flux server, so the Push column has no effect.'
      : push.state === 'unsupported' ? 'This browser cannot receive push; choices apply to your other devices.' : null); }, () => undefined);
  }, []);

  // Saves run one after another in the order they were made, each numbered. Only the answer to
  // the newest one replaces what is shown, so an older response never undoes a newer edit.
  function save(run: () => Promise<NotificationPreferences>, done = 'Saved', onError?: (error: unknown) => void, area: FeedbackArea = 'email', mute?: MuteReceipt, address?: string): Promise<boolean> {
    const session = captureNotificationSession(ownerId);
    if (!session) return Promise.resolve(false);
    const mine = ++sequence.current;
    if (mounted.current) { setSaved(''); setFeedbackArea(area); setMuteReceipt(null); setEmailTarget(null); setEmailNoticeAtHead(false); }
    const next = queue.current.then(async () => {
      if (!isCurrentNotificationSession(session)) return false;
      const pauseVersion = notificationPauseRevision(session);
      let result: NotificationPreferences;
      try { result = await run(); }
      catch (error) {
        if (!isCurrentNotificationSession(session)) return false;
        if (onError && mounted.current) onError(error);
        else toast({ message: message(error, 'Could not save. Try again.'), tone: 'danger' });
        if (mounted.current && mine === sequence.current) load();
        return false;
      }
      if (!isCurrentNotificationSession(session)) return false;
      let refreshFailed = false, refreshed = false, pauseReadUnavailable = false;
      if (notificationPauseRevision(session) !== pauseVersion || notificationPauseUncertain(session)) {
        const readVersion = notificationPauseRevision(session);
        try {
          const current = await getPreferences();
          if (!isCurrentNotificationSession(session)) return false;
          result = reconcilePause(current, readVersion);
          refreshed = true;
        } catch {
          if (!isCurrentNotificationSession(session)) return false;
          // The mutation was acknowledged. Preserve its other facts, never an obsolete pause,
          // and report read unavailability without suggesting the side effect needs repeating.
          result = reconcilePause(result, pauseVersion);
          refreshFailed = true;
          pauseReadUnavailable = notificationPauseRevision(session) === readVersion;
        }
      }
      if (refreshFailed) {
        if (pauseReadUnavailable) announcePauseUncertainty(session, !mounted.current
          ? `${done}. Current notification settings could not be refreshed; the last confirmed settings are shown.` : undefined);
      }
      else announcePauseChange(ownerId, result.pause.until);
      if (mounted.current && mine === sequence.current) {
        hasPreferences.current = true;
        setPrefs(result); setSaved(done); setFeedbackArea(area);
        setMuteReceipt(mute ? { ...mute, place: result.muted.find((place) => place.type === mute.place.type && place.id === mute.place.id) ?? mute.place } : null);
        setEmailTarget(address ?? null);
        setPauseExpired(result.pause.until !== null && Date.parse(result.pause.until) <= Date.now());
        if (refreshFailed) setRefreshWarning('settings');
        else if (refreshed) setRefreshWarning(null);
      }
      return true;
    });
    queue.current = next.then(() => undefined);
    return next;
  }
  const change = (command: UpdateNotificationPreferencesCommand, optimistic?: (current: NotificationPreferences) => NotificationPreferences) => {
    if (optimistic) setPrefs((current) => (current ? optimistic(current) : current));
    const area: FeedbackArea = command.channels ? NOTIFICATION_REASONS.find((reason) => command.channels?.[reason]) ?? 'level'
      : command.emailDestination !== undefined ? 'email' : command.morningSummary ? 'morningSummary' : command.quietHours ? 'quietHours' : 'level';
    void save(() => updatePreferences(command), 'Saved', undefined, area);
  };

  const showMuteReceipt = refreshWarning === 'settings' && feedbackArea === 'mute' && !!saved && muteReceipt !== null;
  useEffect(() => {
    // Measure the latest acknowledged email action in its own section, and retire its
    // subscriptions when that action, account, view or actual layout is no longer current.
    if (refreshWarning !== 'settings' || feedbackArea !== 'email' || !saved || !prefs?.email.available) return;
    const notice = emailReadNoticeRef.current, heading = emailHeadingRef.current;
    const pane = notice?.closest('.pane-scroll');
    if (!notice || !heading || !pane) return;
    const session = captureNotificationSession(ownerId), action = sequence.current;
    let active = true, frame = 0;
    let observer: ResizeObserver | null = null;
    const retire = () => {
      active = false;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      pane.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
    const measure = () => {
      frame = 0;
      if (!active) return;
      if (!mounted.current || action !== sequence.current || !isCurrentNotificationSession(session)
        || !notice.isConnected || !heading.isConnected || !pane.isConnected) { retire(); return; }
      const box = notice.getBoundingClientRect(), view = pane.getBoundingClientRect();
      const top = heading.getBoundingClientRect().bottom + (parseFloat(getComputedStyle(heading).marginBottom) || 0);
      const fitsAtHead = top >= view.top && top + box.height <= view.bottom;
      setEmailNoticeAtHead((atHead) => atHead ? fitsAtHead
        : box.bottom > view.bottom && box.top < view.bottom && fitsAtHead);
    };
    function schedule() {
      if (active && !frame) frame = requestAnimationFrame(measure);
    }
    observer = new ResizeObserver(schedule);
    observer.observe(pane);
    observer.observe(notice);
    observer.observe(heading.closest('section') ?? heading);
    observer.observe(document.documentElement);
    pane.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    schedule();
    return retire;
  }, [emailNoticeAtHead, refreshWarning, feedbackArea, saved, prefs?.email.available, ownerId]);

  if (failed) {
    return (
      <div className="pane-scroll"><div className="pane-in">
        <ErrorState title="Notification settings could not load" actions={<Button onClick={() => { setFailed(false); load(); }}>Retry</Button>}><p>Your inbox still works.</p></ErrorState>
      </div></div>
    );
  }
  if (!prefs) return <div className="pane-scroll"><div className="pane-in"><p className="inbox__loading"><Spinner label="Loading settings" /></p></div></div>;

  const toggle = (reason: NotificationReason, channel: NotificationChannel, on: boolean) => change(
    { channels: { [reason]: { [channel]: on } } },
    (current) => ({ ...current, channels: { ...current.channels, [reason]: { ...current.channels[reason], [channel]: on } as ChannelChoice } }),
  );
  const emailOff = !prefs.email.available || prefs.email.destination === 'none';
  const muted = new Set(prefs.muted.map((place) => `${place.type}:${place.id}`));
  const mutable = [
    ...projects.map((project) => ({ type: 'project' as const, id: project.id, name: project.name })),
    ...directMessages.map((dm) => ({ type: 'dm' as const, id: dm.id, name: dm.title })),
  ].filter((place) => !muted.has(`${place.type}:${place.id}`));

  const level = prefs.level;
  const setLevel = (next: NotificationLevel) => change({ level: next }, (current) => ({ ...current, level: next }));
  const workingFeedback = (area: FeedbackArea) => refreshWarning === 'settings' && feedbackArea === area
    ? <WorkingReadNotice acknowledged={saved} retry={load} /> : null;
  // The named result is also in its own row. Keep the header compact while the one live
  // announcement retains the complete acknowledged name for assistive technology.
  const savedMuteVerb = feedbackArea === 'mute' ? saved.startsWith('Muted ') ? 'Muted' : saved.startsWith('Unmuted ') ? 'Unmuted' : null : null;
  const activeMuteReceipt = showMuteReceipt ? muteReceipt : null;
  const muteRows: MutedPlaceRow[] = prefs.muted.map((place) => ({ place, receiptOnly: false }));
  if (activeMuteReceipt) {
    const existing = muteRows.findIndex(({ place }) => place.type === activeMuteReceipt.place.type && place.id === activeMuteReceipt.place.id);
    const row = existing >= 0 ? muteRows.splice(existing, 1)[0]! : { place: activeMuteReceipt.place, receiptOnly: true };
    // Both actions retain their captured reading slot. A returned snapshot can contain
    // new remote mutes above the old picker, so its new end is not the action's position.
    const index = Math.max(0, Math.min(activeMuteReceipt.index, muteRows.length));
    muteRows.splice(index, 0, row);
  }
  const pickerReceiptIndex = activeMuteReceipt?.muted ? muteRows.findIndex(({ place }) => place.type === activeMuteReceipt.place.type && place.id === activeMuteReceipt.place.id) : -1;
  const beforePickerRows = pickerReceiptIndex < 0 ? muteRows : muteRows.slice(0, pickerReceiptIndex);
  const afterPickerRows = pickerReceiptIndex < 0 ? [] : muteRows.slice(pickerReceiptIndex + 1);
  const onMute = (place: NotificationPreferences['muted'][number]) => void save(() => setMute({ type: place.type, id: place.id, muted: true }), `Muted ${place.name}`, undefined, 'mute', { place, muted: true, index: prefs.muted.length });
  const onUnmute = (place: NotificationPreferences['muted'][number]) => void save(() => setMute({ type: place.type, id: place.id, muted: false }), `Unmuted ${place.name}`, undefined, 'mute', { place, muted: false, index: prefs.muted.findIndex((item) => item.type === place.type && item.id === place.id) });
  const emailReadNotice = refreshWarning && !showMuteReceipt ? <p ref={emailReadNoticeRef} className="nset__problem" role="note"><Icon name="alert" size={14} /><span>
    {refreshWarning === 'settings' && feedbackArea === 'email' && saved ? `${saved}. ` : ''}
    {refreshWarning === 'settings' && feedbackArea === 'email' && saved && emailTarget ? <span className="nset__email-target">{emailTarget}</span> : null}
    {refreshWarning === 'settings' ? 'Current notification settings could not be refreshed. The last confirmed settings are shown.'
      : 'Current notification pause could not be checked. The last confirmed state is shown.'}{' '}
    <Button variant="quiet" onClick={load}>Retry current settings</Button>
  </span></p> : null;

  return (
    <div className="pane-scroll"><div className="pane-in sset-in nset" data-shift>
      <div className="sset-head nset__head">
        <div>
          <h2>Notifications</h2>
          <p>Flux only interrupts you for things that need you. Everything else waits in Inbox.</p>
        </div>
        <span className="nset__saved" role="status" aria-live="polite">{saved ? <><Icon name="check" size={14} />{savedMuteVerb
          ? <>{savedMuteVerb}<span className="ui-vh">{saved.slice(savedMuteVerb.length)}</span></> : saved}</> : null}</span>
      </div>

      {refreshWarning && !showMuteReceipt ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span>
        {refreshWarning === 'settings' ? 'Current notification settings could not be refreshed. Showing last confirmed settings.'
          : 'Current notification pause could not be checked. The last confirmed state is shown.'}{' '}
        <Button variant="quiet" aria-label="Retry current settings" onClick={load}>Refresh</Button>
      </span></p> : null}

      <h3 className="sset-sec" id={ids.level}>Notify me about</h3>
      <div className="sset-card" role="radiogroup" aria-labelledby={ids.level}>
        {LEVELS.map((option) => (
          <label key={option.id} className={`sset-row sset-choice${level === option.id ? ' is-on' : ''}`}>
            <span className="sset-row__b">
              <span className="sset-row__t">{option.label}</span>
              {option.detail ? <span className="sset-row__s">{option.detail}</span> : null}
            </span>
            <input type="radio" name="notification-level" value={option.id} checked={level === option.id} onChange={() => setLevel(option.id)} />
            <span className="sset-check" aria-hidden="true"><Icon name="check" size={12} /></span>
          </label>
        ))}
      </div>
      {workingFeedback('level')}
      {level === 'custom' ? <p className="sset-note" role="note">You chose channels for each kind below, so none of the three matches. Pick one to reset them.</p> : null}

      {prefs.pause.until && !pauseExpired ? (
        <p className="nset__focus" role="status">
          <Icon name="focus" size={14} /><span>{refreshWarning ? 'Last confirmed pause: push and email were paused until ' : 'Focus: push and email are paused until '}<time dateTime={prefs.pause.until}>{clock(new Date(prefs.pause.until))}</time>.</span>
          <Button variant="secondary" onClick={() => change({ pause: { until: null } }, (current) => ({ ...current, pause: { until: null } }))}>Resume now</Button>
        </p>
      ) : null}
      <div className="sset-card sset-gap">
        <QuietHoursRow prefs={prefs} onChange={change} feedback={workingFeedback('quietHours')} />
        <MorningSummaryRow prefs={prefs} onChange={change} feedback={workingFeedback('morningSummary')} />
      </div>

      <section className="nset__sec" aria-labelledby={ids.what}>
        <h3 className="sset-sec" id={ids.what}>Push and email for each kind</h3>
        {pushOff ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span>{pushOff} Your inbox always works.</span></p> : null}
        <div className="sset-card nset__matrix">
          <table className="nset__table">
            <thead><tr><th scope="col"><span className="ui-vh">Reason</span></th>{COLUMNS.map((column) => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead>
            <tbody>
              {NOTIFICATION_REASONS.map((reason) => (
                <Fragment key={reason}><tr>
                  <th scope="row"><b>{ROWS[reason].label}</b><span>{ROWS[reason].hint}</span></th>
                  {COLUMNS.map((column) => {
                    const disabled = (column.id === 'email' && emailOff) || (column.id === 'push' && !!pushOff?.startsWith('Push is not'));
                    return (
                      <td key={column.id}>
                        <label className={`nset__check${disabled ? ' is-off' : ''}`}>
                          <input type="checkbox" checked={prefs.channels[reason][column.id]} disabled={disabled}
                            aria-label={`${ROWS[reason].label}: ${column.label}`} onChange={(event) => toggle(reason, column.id, event.target.checked)} />
                          <span aria-hidden="true"><Icon name="check" size={12} /></span>
                        </label>
                      </td>
                    );
                  })}
                </tr>{refreshWarning === 'settings' && feedbackArea === reason ? <tr><td colSpan={4}>{workingFeedback(reason)}</td></tr> : null}</Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sset-note">{emailOff
          ? prefs.email.available ? 'Email is off: you chose in-app only below.' : 'Email delivery unavailable on this server, so only the inbox and push are used.'
          : 'Emails never contain messages or project details, only a link to open in Flux.'}</p>
        <div className="sset-card sset-gap nset__device"><span className="sset-row__t"><Icon name="bell" size={14} />Push on this device</span><NotificationsButton /></div>
      </section>

      <section className="nset__sec" aria-labelledby={ids.email}>
        <h3 ref={emailHeadingRef} className="sset-sec" id={ids.email}>Where email goes</h3>
        {emailNoticeAtHead ? emailReadNotice : null}
        {!prefs.email.available ? (
          <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Email delivery unavailable.</b> This Flux server has no outgoing mail set up, so nothing is emailed. Your inbox and push still work; an administrator can configure SMTP.</span></p>
        ) : prefs.email.lastFailureAt ? (
          <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>A recent notification email could not be delivered.</b> Flux will retry for a while. Everything is in your inbox.</span></p>
        ) : null}
        <div className="sset-card nset__box">
          <EmailDestinationChoice prefs={prefs} onChange={(destination) => change({ emailDestination: destination }, (current) => ({ ...current, email: { ...current.email, destination } }))} />
          <ExtraAddress prefs={prefs} save={(run, done, onError, address) => save(run, done, onError, 'email', undefined, address)} readNotice={emailNoticeAtHead ? null : emailReadNotice} />
        </div>
      </section>

      <section className="nset__sec" aria-labelledby={ids.mute}>
        <h3 className="sset-sec" id={ids.mute}>Muted places</h3>
        <div className="sset-card nset__box">
          <p className="nset__lead">Nothing from a muted place notifies you, on any channel. You can still open it.</p>
          {beforePickerRows.length ? <MutedPlaceRows rows={beforePickerRows} receipt={activeMuteReceipt} onUnmute={onUnmute} onRetry={load} /> : pickerReceiptIndex < 0 ? <p className="nset__none">No muted places.</p> : null}
          {pickerReceiptIndex >= 0 ? <MutePicker places={mutable} onMute={onMute} result={<MutedPlaceRows rows={[muteRows[pickerReceiptIndex]!]} receipt={activeMuteReceipt} onUnmute={onUnmute} onRetry={load} />} /> : null}
          {afterPickerRows.length ? <MutedPlaceRows rows={afterPickerRows} receipt={activeMuteReceipt} onUnmute={onUnmute} onRetry={load} /> : null}
          {mutable.length ? <MutePicker places={mutable} onMute={onMute} /> : null}
        </div>
      </section>
    </div></div>
  );
}

function MutedPlaceRows({ rows, receipt, onUnmute, onRetry }: {
  rows: MutedPlaceRow[];
  receipt: MuteReceipt | null;
  onUnmute: (place: NotificationPreferences['muted'][number]) => void;
  onRetry: () => void;
}) {
  return (
    <ul className="nset__muted">
      {rows.map(({ place, receiptOnly }) => (
        <li key={`${receiptOnly ? 'receipt:' : ''}${place.type}:${place.id}`} className={receiptOnly ? 'nset__mute-result' : undefined}>
          {receipt && receipt.place.type === place.type && receipt.place.id === place.id ? (
            <p className="nset__mute-read" role="note"><span>
              <span className="nset__place">{place.type === 'dm' ? <Icon name="chat" size={14} /> : <span className="nset__hash" aria-hidden="true">#</span>}{place.name}<span className="ui-vh">{place.type === 'dm' ? ', direct message' : ', project'}</span></span>
              <span className="nset__mute-state">{receipt.muted ? 'Muted' : 'Unmuted'}. Current settings unverified.</span>
              <span className="nset__mute-warning">Current notification settings could not be refreshed. Showing last confirmed settings.</span>
            </span><Button variant="quiet" aria-label="Retry current settings" onClick={onRetry}>Refresh</Button></p>
          ) : <span className="nset__place">{place.type === 'dm' ? <Icon name="chat" size={14} /> : <span className="nset__hash" aria-hidden="true">#</span>}{place.name}<span className="ui-vh">{place.type === 'dm' ? ', direct message' : ', project'}</span></span>}
          {!receiptOnly ? <Button variant="quiet" onClick={() => onUnmute(place)}>Unmute</Button> : null}
        </li>
      ))}
    </ul>
  );
}

function WorkingReadNotice({ acknowledged, retry }: { acknowledged: string; retry: () => void }) {
  return <div className="nset__read-feedback"><p className="nset__problem" role="note"><Icon name="alert" size={14} /><span>
    {acknowledged ? `${acknowledged}. ` : ''}Current notification settings could not be refreshed. The last confirmed settings are shown.{' '}
    <Button variant="quiet" onClick={retry}>Retry current settings</Button>
  </span></p></div>;
}

function EmailDestinationChoice({ prefs, onChange }: { prefs: NotificationPreferences; onChange: (destination: EmailDestination) => void }) {
  const { email } = prefs;
  const extra = email.extra?.verified ? email.extra.email : null;
  const options: { id: EmailDestination; label: string; detail: string; disabled?: boolean }[] = [
    { id: 'account', label: 'Sign-in address', detail: email.accountAddress },
    { id: 'extra', label: 'Extra address', detail: extra ?? 'Add and confirm one below', disabled: !extra },
    { id: 'both', label: 'Both', detail: extra ? `${email.accountAddress} and ${extra}` : 'Needs a confirmed extra address', disabled: !extra },
    { id: 'none', label: 'In-app only', detail: 'No email. Your inbox and push still work.' },
  ];
  return (
    <fieldset className="nset__dest" disabled={!email.available}>
      <legend className="ui-vh">Where email goes</legend>
      {options.map((option) => (
        <label key={option.id} className={`nset__radio${email.destination === option.id ? ' is-on' : ''}${option.disabled && email.destination !== option.id ? ' is-off' : ''}`}>
          <input type="radio" name="email-destination" value={option.id} checked={email.destination === option.id}
            disabled={option.disabled && email.destination !== option.id} onChange={() => onChange(option.id)} />
          <span><b>{option.label}</b><span>{option.detail}</span></span>
        </label>
      ))}
      <p className="nset__note">Changing where email goes never changes how you sign in or reset your password.</p>
    </fieldset>
  );
}

function ExtraAddress({ prefs, save, readNotice }: { prefs: NotificationPreferences; save: (run: () => Promise<NotificationPreferences>, done?: string, onError?: (error: unknown) => void, address?: string) => Promise<boolean>; readNotice: ReactNode }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  const extra = prefs.email.extra;
  if (!prefs.email.available) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const address = value.trim();
      const added = await save(() => addAddress(address), 'Verification link sent',
        (cause) => setError(message(cause, 'Could not send the link. Try again.')), address);
      if (added) setValue('');
    } catch (cause) {
      setError(message(cause, 'Could not send the link. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (extra) {
    return (
      <div className="nset__extra">
        {readNotice}
        <div className="nset__addr">
          <Icon name="mail" size={14} />
          <span><b>{extra.email}</b><span>{extra.verified ? 'Confirmed · receives notification email only' : 'Waiting for you to open the link we sent. It works once and expires in 24 hours.'}</span></span>
        </div>
        <div className="nset__actions">
          {!extra.verified ? <Button variant="quiet" onClick={() => void save(resendVerification, 'Sent again', undefined, extra.email)}>Send again</Button> : null}
          <Button variant="quiet" onClick={() => void save(removeAddress, 'Extra address removed', undefined, extra.email)}>Remove</Button>
        </div>
      </div>
    );
  }
  return (
    <form className="nset__add" onSubmit={(event) => void submit(event)} noValidate>
      {readNotice}
      <label htmlFor={inputId}>Add an extra address, for example the inbox you read most</label>
      <div className="nset__row">
        <input id={inputId} type="email" autoComplete="email" inputMode="email" placeholder="name@example.org" value={value}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${inputId}-error` : `${inputId}-hint`} onChange={(event) => { setValue(event.target.value); setError(''); }} />
        <Button type="submit" busy={busy}>Send link</Button>
      </div>
      {error ? <p className="nset__error" id={`${inputId}-error`} role="alert"><Icon name="alert" size={14} />{error}</p>
        : <p className="nset__note" id={`${inputId}-hint`}>We email a confirmation link. The address only receives notifications; it can never be used to sign in.</p>}
    </form>
  );
}

type Change = (command: UpdateNotificationPreferencesCommand, optimistic?: (current: NotificationPreferences) => NotificationPreferences) => void;

const shortClock = (value: string) => value.replace(/^0(\d)/, '$1');
const zoneLabel = (zone: string) => zone.replace(/_/g, ' ');

/** Quiet hours: a switch, then the window and its time zone while it is on. */
function QuietHoursRow({ prefs, onChange, feedback }: { prefs: NotificationPreferences; onChange: Change; feedback?: ReactNode }) {
  const quiet = prefs.quietHours;
  const zones = useMemo(() => timeZones(quiet.timeZone), [quiet.timeZone]);
  const set = (next: Partial<typeof quiet>) => onChange({ quietHours: next }, (current) => ({ ...current, quietHours: { ...current.quietHours, ...next } }));
  const suggested = browserTimeZone();
  return (
    <div className="nset__group">
      <SwitchRow label="Quiet hours" checked={quiet.enabled}
        detail={`${shortClock(quiet.start)} – ${shortClock(quiet.end)} · ${zoneLabel(quiet.timeZone)}`}
        onChange={(on) => set(on && quiet.timeZone === 'UTC' && suggested !== 'UTC' ? { enabled: true, timeZone: suggested } : { enabled: on })} />
      {feedback}
      {quiet.enabled ? (
        <div className="nset__times">
          <label>From<input type="time" value={quiet.start} onChange={(event) => event.target.value && set({ start: event.target.value })} /></label>
          <label>Until<input type="time" value={quiet.end} onChange={(event) => event.target.value && set({ end: event.target.value })} /></label>
          <label className="nset__zone">Time zone
            <select value={quiet.timeZone} onChange={(event) => set({ timeZone: event.target.value })}>
              {zones.map((zone) => <option key={zone} value={zone}>{zoneLabel(zone)}</option>)}
            </select>
          </label>
        </div>
      ) : null}
    </div>
  );
}

/** The morning summary (S22): one push a day at a local time, counting what waits in Inbox. */
function MorningSummaryRow({ prefs, onChange, feedback }: { prefs: NotificationPreferences; onChange: Change; feedback?: ReactNode }) {
  const summary = prefs.morningSummary;
  const zone = prefs.quietHours.timeZone;
  const suggested = browserTimeZone();
  const set = (next: Partial<typeof summary>) => onChange(
    // Turning it on in UTC takes this browser's time zone (shared with quiet hours), as quiet hours do.
    next.enabled && zone === 'UTC' && suggested !== 'UTC' ? { morningSummary: next, quietHours: { timeZone: suggested } } : { morningSummary: next },
    (current) => ({ ...current, morningSummary: { ...current.morningSummary, ...next } }),
  );
  return (
    <div className="nset__group">
      <SwitchRow label="Morning summary" checked={summary.enabled}
        detail={`One digest at ${shortClock(summary.at)} instead of single pings`}
        onChange={(on) => set({ enabled: on })} />
      {feedback}
      {summary.enabled ? (
        <div className="nset__times">
          <label>At<input type="time" value={summary.at} onChange={(event) => event.target.value && set({ at: event.target.value })} /></label>
          <span className="nset__zone-note">{zoneLabel(zone)}, the time zone of quiet hours. Nothing is sent when Inbox is empty.</span>
        </div>
      ) : null}
    </div>
  );
}

function MutePicker({ places, onMute, result }: { places: { type: 'project' | 'dm'; id: string; name: string }[]; onMute: (place: { type: 'project' | 'dm'; id: string; name: string }) => void; result?: ReactNode }) {
  const [choice, setChoice] = useState('');
  const selectId = useId();
  const place = places.find((item) => `${item.type}:${item.id}` === choice);
  return (
    <div className="nset__row nset__mute">
      {result ?? <>
      <label className="ui-vh" htmlFor={selectId}>Place to mute</label>
      <select id={selectId} value={choice} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Choose a project or conversation…</option>
        {places.some((item) => item.type === 'project') ? <optgroup label="Projects">{places.filter((item) => item.type === 'project').map((item) => <option key={item.id} value={`project:${item.id}`}># {item.name}</option>)}</optgroup> : null}
        {places.some((item) => item.type === 'dm') ? <optgroup label="Direct messages">{places.filter((item) => item.type === 'dm').map((item) => <option key={item.id} value={`dm:${item.id}`}>{item.name}</option>)}</optgroup> : null}
      </select>
      <Button disabled={!place} onClick={() => { if (place) { onMute(place); setChoice(''); } }}>Mute</Button>
      </>}
    </div>
  );
}

/** `/settings/notifications/verify?token=`: confirms the extra address for the signed-in account. */
export function VerifyAddress() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<{ status: 'working' } | { status: 'done'; email: string } | { status: 'failed'; text: string }>({ status: 'working' });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    verifyAddress(token).then((prefs) => setState({ status: 'done', email: prefs.email.extra?.email ?? '' }),
      (error: unknown) => setState({ status: 'failed', text: message(error, 'The address could not be confirmed. Try again.') }));
  }, [token]);
  return (
    <div className="pane-scroll"><div className="pane-in">
      <div className="inbox-gone" role={state.status === 'working' ? undefined : 'status'}>
        {state.status === 'working' ? <p className="inbox__loading"><Spinner label="Confirming the address" /></p> : (
          <>
            <Icon name={state.status === 'done' ? 'check' : 'alert'} size={16} />
            <div>
              <h2>{state.status === 'done' ? 'Address confirmed' : 'This link did not work'}</h2>
              <p>{state.status === 'done'
                ? `${state.email} can now receive notification email. Choose it under “Where email goes”.`
                : `${state.text} You can send a new link from notification settings.`}</p>
              <Link className="ui-btn ui-btn--secondary" to="/settings/notifications">Notification settings</Link>
            </div>
          </>
        )}
      </div>
    </div></div>
  );
}

/** `/unsubscribe?token=`: the page linked from every notification email. It needs no sign-in. */
export function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'ask' | 'working' | 'done' | 'stale' | 'failed'>('ask');
  const stop = () => {
    setState('working');
    unsubscribe(token).then((result) => setState(result.result === 'stale' ? 'stale' : 'done'), () => setState('failed'));
  };
  const copy = {
    ask: ['Stop notification emails?', 'Flux will stop sending notification email to the address this message went to. Nothing else changes, including how you sign in.'],
    working: ['Stop notification emails?', 'Flux will stop sending notification email to the address this message went to. Nothing else changes, including how you sign in.'],
    done: ['Emails stopped', 'Flux will not send notification email to this address. Your inbox and push are unchanged, and you can turn email back on in notification settings.'],
    stale: ['This link no longer applies', 'It was for an address that is no longer the one Flux emails, so nothing changed. You can choose where email goes in notification settings.'],
    failed: ['This link has expired', 'You can change email in notification settings after signing in.'],
  }[state];
  return (
    <div className="auth__head unsub">
      <h1 className="auth__title">{copy[0]}</h1>
      <p className="auth__lead">{copy[1]}</p>
      {state === 'ask' || state === 'working' ? <Button variant="primary" size="lg" busy={state === 'working'} onClick={stop}>Stop these emails</Button> : null}
      <p className="unsub__link"><Link className={`ui-btn ${state === 'failed' || state === 'stale' ? 'ui-btn--primary' : 'ui-btn--secondary'} ui-btn--lg`} to="/settings/notifications">Notification settings</Link></p>
    </div>
  );
}
