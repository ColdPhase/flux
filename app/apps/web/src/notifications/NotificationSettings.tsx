import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { type NotificationLevel, type NotificationPreferences, type UpdateNotificationPreferencesCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { InstallFlux, NotificationsButton } from '../pwa';
import { getPushState, pushOnServer } from '../pwa/push';
import { SwitchRow } from '../ui/SwitchRow';
import { captureNotificationSession, isCurrentNotificationSession } from './session';
import { Button, ErrorState, Icon, MEDIA, Spinner, useMediaQuery, useToast, Select, Option, OptionGroup } from '../ui';
import { addAddress, getPreferences, removeAddress, resendVerification, setMute, unsubscribe, updatePreferences, verifyAddress } from './api';
import './notifications.css';

type MutedPlace = NotificationPreferences['muted'][number];
type PendingMute = { place: MutedPlace; muted: boolean };

const LEVELS: { id: NotificationLevel; label: string; detail: string }[] = [
  { id: 'needsYou', label: 'Only what needs me', detail: 'Decisions, questions, blocked tasks, mentions and agents waiting for you' },
  { id: 'everything', label: 'Everything', detail: 'Also every reply in conversations you are part of' },
  { id: 'nothing', label: 'Nothing', detail: 'No push or email. Everything still waits in the Inbox' },
];

function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function timeZones(current: string) {
  let zones: string[] = [];
  try { zones = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? []; } catch { zones = []; }
  return [...new Set([current, browserTimeZone(), 'UTC', ...zones])].sort((a, b) => a.localeCompare(b));
}

const message = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);
const shortClock = (value: string) => value.replace(/^0(\d)/, '$1');
const zoneLabel = (zone: string) => zone.replace(/_/g, ' ');

/**
 * Notifications (#116, #872): what to hear about (Only what needs me, Everything, Nothing), where it reaches you
 * (email too, this device, quiet hours), the addresses that email goes to, and muted places. Every change saves
 * at once; nothing here changes how you sign in.
 */
export function NotificationSettings() {
  const { me } = useShellData();
  return <AccountNotificationSettings key={me.user.id} />;
}

function AccountNotificationSettings() {
  const { me, projects, directMessages } = useShellData();
  const ownerId = me.user.id;
  const mounted = useRef(false);
  const phone = useMediaQuery(MEDIA.phone);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState('');
  const [pendingMute, setPendingMute] = useState<PendingMute | null>(null);
  const [staleRead, setStaleRead] = useState(false);
  const [quietOpen, setQuietOpen] = useState(false);
  const [mutedOpen, setMutedOpen] = useState(false);
  const hasPreferences = useRef(false);
  const toast = useToast();
  const ids = { level: useId(), where: useId(), email: useId(), quiet: useId(), muted: useId() };

  const queue = useRef<Promise<void>>(Promise.resolve());
  const sequence = useRef(0);
  const reads = useRef(0);
  const load = useCallback(() => {
    const mine = ++reads.current, edit = sequence.current;
    getPreferences().then((next) => {
      if (mounted.current && mine === reads.current && edit === sequence.current) {
        hasPreferences.current = true;
        setPrefs(next); setFailed(false); setStaleRead(false);
      }
    }, () => {
      if (mounted.current && mine === reads.current && edit === sequence.current) {
        if (hasPreferences.current) setStaleRead(true);
        else setFailed(true);
      }
    });
  }, []);
  useEffect(load, [load]);
  // Push cannot reach anyone when the server has no VAPID keys or the browser has no push. The server's reason comes
  // first: a channel this server lacks is not offered at all, whatever the browser (#763 SG-3).
  const [pushServerOff, setPushServerOff] = useState(false);
  const [pushOff, setPushOff] = useState<string | null>(null);
  useEffect(() => {
    pushOnServer().then((on) => {
      if (!mounted.current) return;
      setPushServerOff(!on);
      if (on) getPushState().then((push) => { if (mounted.current) setPushOff(push.state === 'unsupported' ? 'This browser cannot receive push; your choices apply to your other devices.' : null); }, () => undefined);
    }, () => undefined);
  }, []);

  // Saves run one after another in the order they were made, each numbered. Only the answer to
  // the newest one replaces what is shown, so an older response never undoes a newer edit.
  function save(run: () => Promise<NotificationPreferences>, done = 'Saved', onError?: (error: unknown) => void, pending?: PendingMute): Promise<boolean> {
    // A save belongs to the account that asked for it: if the tab signs out and in as another account while it waits in the
    // queue, it is never sent (the shell retires the session with the account).
    const session = captureNotificationSession(ownerId);
    if (!session) return Promise.resolve(false);
    const mine = ++sequence.current;
    if (mounted.current) { setSaved(''); setPendingMute(pending ?? null); }
    const next = queue.current.then(async () => {
      if (!isCurrentNotificationSession(session)) return false;
      let result: NotificationPreferences;
      try { result = await run(); }
      catch (error) {
        if (!isCurrentNotificationSession(session)) return false;
        if (onError && mounted.current) onError(error);
        else toast({ message: message(error, 'Could not save. Try again.'), tone: 'danger' });
        if (mounted.current && mine === sequence.current) { setPendingMute(null); load(); }
        return false;
      }
      if (!isCurrentNotificationSession(session)) return false;
      if (mounted.current && mine === sequence.current) {
        hasPreferences.current = true;
        setPrefs(result); setSaved(done); setPendingMute(null); setStaleRead(false);
      }
      return true;
    });
    queue.current = next.then(() => undefined);
    return next;
  }
  const change: Change = (command, optimistic) => {
    if (optimistic) setPrefs((current) => (current ? optimistic(current) : current));
    void save(() => updatePreferences(command));
  };

  if (failed) {
    return (
      <div className="pane-scroll"><div className="pane-in">
        <ErrorState title="Notification settings could not load" actions={<Button onClick={() => { setFailed(false); load(); }}>Retry</Button>}><p>Your inbox still works.</p></ErrorState>
      </div></div>
    );
  }
  if (!prefs) return <div className="pane-scroll"><div className="pane-in"><p className="inbox__loading"><Spinner label="Loading settings" /></p></div></div>;

  const { email } = prefs;
  // Only the channels this server has (#763 SG-3).
  const missing = pushServerOff && !email.available ? 'Push and email aren’t set up on this Flux server, so everything waits in your Inbox.'
    : pushServerOff ? 'Push isn’t set up on this Flux server. Your inbox always works.'
      : !email.available ? 'Email isn’t set up on this Flux server. Your inbox and push still work.' : '';
  const addresses = 1 + (email.extra?.verified ? 1 : 0);
  const muted = new Set(prefs.muted.map((place) => `${place.type}:${place.id}`));
  const mutable = [
    ...projects.map((project) => ({ type: 'project' as const, id: project.id, name: project.name })),
    ...directMessages.map((dm) => ({ type: 'dm' as const, id: dm.id, name: dm.title })),
  ].filter((place) => !muted.has(`${place.type}:${place.id}`));
  const setLevel = (level: NotificationLevel) => change({ level }, (current) => ({ ...current, level }));

  return (
    <div className="pane-scroll"><div className="pane-in sset-in nset">
      <div className="sset-head nset__head">
        <div>
          <h2>Notifications</h2>
          <p>The Inbox always shows everything that waits for you.</p>
        </div>
        <span className="nset__saved" role="status" aria-live="polite">{saved ? <><Icon name="check" size={14} />{saved}</> : null}</span>
      </div>

      {staleRead ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span>
        Current notification settings could not be refreshed. Showing the last confirmed settings.{' '}
        <Button variant="quiet" aria-label="Retry current settings" onClick={load}>Refresh</Button>
      </span></p> : null}

      <h3 className="sset-sec" id={ids.level}>Tell me about</h3>
      <div className="sset-card" role="radiogroup" aria-labelledby={ids.level}>
        {LEVELS.map((option) => (
          <label key={option.id} className={`sset-row sset-choice${prefs.level === option.id ? ' is-on' : ''}`}>
            <span className="sset-row__b">
              <span className="sset-row__t" id={`${ids.level}-${option.id}`}>{option.label}</span>
              <span className="sset-row__s" id={`${ids.level}-${option.id}-d`}>{option.detail}</span>
            </span>
            {/* The option is named by its title and described by its line, so a screen reader says each once. */}
            <input type="radio" name="notification-level" value={option.id} checked={prefs.level === option.id} aria-labelledby={`${ids.level}-${option.id}`}
              aria-describedby={`${ids.level}-${option.id}-d`} onChange={() => setLevel(option.id)} />
            <span className="sset-check" aria-hidden="true"><Icon name="check" size={12} /></span>
          </label>
        ))}
      </div>

      <h3 className="sset-sec" id={ids.where}>Where</h3>
      {/* Channels this server lacks are not offered: one status line says so (#763 SG-3). */}
      {missing ? <p className="nset__problem nset__server" role="note"><Icon name="bell" size={14} /><span>{missing}</span></p> : null}
      {pushOff ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span>{pushOff} Your inbox always works.</span></p> : null}
      <div className="sset-card" role="group" aria-labelledby={ids.where}>
        {email.available ? (
          <SwitchRow label="Email me too" checked={prefs.emailMe}
            detail={prefs.level === 'nothing' ? 'Not used while you hear about Nothing' : `To ${addresses} ${addresses === 1 ? 'address' : 'addresses'}`}
            onChange={(emailMe) => change({ emailMe }, (current) => ({ ...current, emailMe }))} />
        ) : null}
        {pushServerOff ? null : (
          <div className="sset-row sset-row--stack"><span className="sset-row__t">On this device</span><NotificationsButton installStepsBelow={phone} /></div>
        )}
        <QuietHours prefs={prefs} open={quietOpen} panelId={ids.quiet} onToggle={() => setQuietOpen((open) => !open)} onChange={change} />
      </div>

      {email.available ? (
        <>
          <h3 className="sset-sec" id={ids.email}>Email addresses</h3>
          {email.lastFailureAt ? (
            <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>A recent notification email could not be delivered.</b> Flux will retry for a while. Everything is in your inbox.</span></p>
          ) : null}
          <div className="sset-card" role="group" aria-labelledby={ids.email}>
            <div className="sset-row">
              <span className="sset-row__ic" aria-hidden="true"><Icon name="mail" size={16} /></span>
              <span className="sset-row__b"><span className="sset-row__t">{email.accountAddress}</span><span className="sset-row__s">Your sign-in address</span></span>
            </div>
            <ExtraAddress prefs={prefs} save={save} />
          </div>
          <p className="sset-note">We send a confirmation link to a new address before any notification goes there.</p>
        </>
      ) : null}

      <div className="sset-card sset-gap">
        <div className="sset-row">
          <span className="sset-row__b">
            <span className="sset-row__t">Muted places</span>
            <span className="sset-row__s">{mutedSummary(prefs.muted)}</span>
          </span>
          <Button variant="quiet" size="sm" aria-expanded={mutedOpen} aria-controls={ids.muted}
            aria-label={mutedOpen ? 'Close muted places' : 'Change muted places'} onClick={() => setMutedOpen((open) => !open)}>{mutedOpen ? 'Done' : 'Change'}</Button>
        </div>
        {mutedOpen ? (
          <div className="nset__panel nset__places" id={ids.muted}>
            <p className="nset__lead">Nothing from a muted place notifies you, on any channel. You can still open it.</p>
            {prefs.muted.length ? (
              <ul className="nset__muted">
                {prefs.muted.map((place) => (
                  <li key={`${place.type}:${place.id}`} data-place={`${place.type}:${place.id}`}>
                    <PlaceName place={place} />
                    <Button variant="quiet" busy={pendingMute?.muted === false && pendingMute.place.type === place.type && pendingMute.place.id === place.id}
                      onClick={() => void save(() => setMute({ type: place.type, id: place.id, muted: false }), `Unmuted ${place.name}`, undefined, { place, muted: false })}>Unmute</Button>
                  </li>
                ))}
              </ul>
            ) : <p className="nset__none">No muted places.</p>}
            <MutePicker places={mutable} pending={pendingMute?.muted ? pendingMute : null}
              onMute={(place) => save(() => setMute({ type: place.type, id: place.id, muted: true }), `Muted ${place.name}`, undefined, { place, muted: true })} />
          </div>
        ) : null}
      </div>

      {/* Installing Flux, last on the page, so an install offer that arrives late never moves another row. The card
          shows only when it has a row. */}
      <section className="nset__sec nset__this-device">
        <div className="sset-card"><InstallFlux title={phone ? 'Flux on this phone' : 'Install Flux'} phone={phone} /></div>
      </section>
    </div></div>
  );
}

function mutedSummary(muted: NotificationPreferences['muted']) {
  if (!muted.length) return 'None';
  const names = muted.slice(0, 3).map((place) => place.name).join(', ');
  return muted.length > 3 ? `${names} and ${muted.length - 3} more` : names;
}

function PlaceName({ place }: { place: MutedPlace }) {
  return (
    <span className="nset__place">
      {place.type === 'dm' ? <Icon name="chat" size={14} /> : <span className="nset__hash" aria-hidden="true">#</span>}{place.name}
      <span className="ui-vh">{place.type === 'dm' ? ', direct message' : ', space'}</span>
    </span>
  );
}

type Change = (command: UpdateNotificationPreferencesCommand, optimistic?: (current: NotificationPreferences) => NotificationPreferences) => void;

/**
 * Quiet hours as one row (C-31): while they last Flux sends no email or push, and sends nothing when they end; the
 * Inbox keeps everything. Change opens the switch, the window and its time zone.
 */
function QuietHours({ prefs, open, panelId, onToggle, onChange }: { prefs: NotificationPreferences; open: boolean; panelId: string; onToggle: () => void; onChange: Change }) {
  const quiet = prefs.quietHours;
  const zones = useMemo(() => timeZones(quiet.timeZone), [quiet.timeZone]);
  const set = (next: Partial<typeof quiet>) => onChange({ quietHours: next }, (current) => ({ ...current, quietHours: { ...current.quietHours, ...next } }));
  const suggested = browserTimeZone();
  // While off, the line names the zone turning it on will use, this browser's, not the stored UTC default (#763 SG-5).
  const shownZone = !quiet.enabled && quiet.timeZone === 'UTC' ? suggested : quiet.timeZone;
  return (
    <>
      <div className="sset-row">
        <span className="sset-row__b">
          <span className="sset-row__t">Quiet hours</span>
          <span className="sset-row__s">{quiet.enabled ? `${shortClock(quiet.start)}–${shortClock(quiet.end)} · no email or push then; the Inbox keeps everything` : 'Off'}</span>
        </span>
        <Button variant="quiet" size="sm" aria-expanded={open} aria-controls={panelId}
          aria-label={open ? 'Close quiet hours' : 'Change quiet hours'} onClick={onToggle}>{open ? 'Done' : 'Change'}</Button>
      </div>
      {open ? (
        <div className="nset__panel" id={panelId}>
          <SwitchRow label="Use quiet hours" checked={quiet.enabled} detail={`${shortClock(quiet.start)}–${shortClock(quiet.end)} · ${zoneLabel(shownZone)}`}
            onChange={(on) => set(on && quiet.timeZone === 'UTC' && suggested !== 'UTC' ? { enabled: true, timeZone: suggested } : { enabled: on })} />
          {quiet.enabled ? (
            <div className="nset__times">
              <label>From<input type="time" value={quiet.start} onChange={(event) => event.target.value && set({ start: event.target.value })} /></label>
              <label>Until<input type="time" value={quiet.end} onChange={(event) => event.target.value && set({ end: event.target.value })} /></label>
              <label className="nset__zone">Time zone
                <Select value={quiet.timeZone} onChange={(next) => set({ timeZone: next })}>
                  {zones.map((zone) => <Option key={zone} value={zone}>{zoneLabel(zone)}</Option>)}
                </Select>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

type Save = (run: () => Promise<NotificationPreferences>, done?: string, onError?: (error: unknown) => void) => Promise<boolean>;

/** The one extra address: confirmed or waiting for its link, with Send again and Remove, or a field to add one. */
function ExtraAddress({ prefs, save }: { prefs: NotificationPreferences; save: Save }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  const extra = prefs.email.extra;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const address = value.trim();
      const added = await save(() => addAddress(address), 'Confirmation link sent',
        (cause) => setError(message(cause, 'Could not send the link. Try again.')));
      if (added) setValue('');
    } catch (cause) {
      setError(message(cause, 'Could not send the link. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (extra) {
    return (
      <div className="sset-row nset__extra">
        <span className="sset-row__ic" aria-hidden="true"><Icon name="mail" size={16} /></span>
        <span className="sset-row__b">
          <span className="sset-row__t">{extra.email}</span>
          <span className="sset-row__s">{extra.verified ? 'Confirmed · receives notification email only' : 'Waiting for you to open the link we sent. It works once and expires in 24 hours.'}</span>
        </span>
        {!extra.verified ? <Button variant="quiet" size="sm" onClick={() => void save(resendVerification, 'Sent again')}>Send again</Button> : null}
        <Button variant="quiet" size="sm" onClick={() => void save(removeAddress, 'Address removed')}>Remove</Button>
      </div>
    );
  }
  return (
    <form className="sset-row nset__add" onSubmit={(event) => void submit(event)} noValidate>
      <label className="ui-vh" htmlFor={inputId}>Add another address</label>
      <input id={inputId} type="email" autoComplete="email" inputMode="email" placeholder="Add another address" value={value}
        aria-invalid={error ? true : undefined} aria-describedby={error ? `${inputId}-error` : undefined} onChange={(event) => { setValue(event.target.value); setError(''); }} />
      <Button type="submit" size="sm" busy={busy}>Add</Button>
      {error ? <p className="nset__add-error" id={`${inputId}-error`} role="alert"><Icon name="alert" size={14} />{error}</p> : null}
    </form>
  );
}

function MutePicker({ places, onMute, pending }: { places: MutedPlace[]; onMute: (place: MutedPlace) => Promise<boolean>; pending: PendingMute | null }) {
  const [choice, setChoice] = useState('');
  const choiceVersion = useRef(0);
  const selectId = useId();
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const place = places.find((item) => `${item.type}:${item.id}` === choice);
  return (
    <div className="nset__row nset__mute" hidden={!places.length && !pending}>
      <label className="ui-vh" htmlFor={selectId}>Place to mute</label>
      <Select id={selectId} value={choice} disabled={!!pending} onChange={(next) => { choiceVersion.current += 1; setChoice(next); }}>
        <Option value="">Choose a space or conversation…</Option>
        {places.some((item) => item.type === 'project') ? <OptionGroup label="Spaces">{places.filter((item) => item.type === 'project').map((item) => <Option key={item.id} value={`project:${item.id}`}># {item.name}</Option>)}</OptionGroup> : null}
        {places.some((item) => item.type === 'dm') ? <OptionGroup label="Direct messages">{places.filter((item) => item.type === 'dm').map((item) => <Option key={item.id} value={`dm:${item.id}`}>{item.name}</Option>)}</OptionGroup> : null}
      </Select>
      <Button disabled={!place && !pending} busy={!!pending} onClick={() => {
        if (!place) return;
        const selected = choice, version = ++choiceVersion.current;
        void onMute(place).then((acknowledged) => { if (acknowledged && mounted.current && version === choiceVersion.current) setChoice((current) => current === selected ? '' : current); });
      }}>Mute</Button>
      {pending ? <p className="nset__mute-pending" role="note">Muting {pending.place.name}…</p> : null}
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
                ? `${state.email} is confirmed and now receives notification email whenever “Email me too” is on.`
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
  const [state, setState] = useState<'ask' | 'working' | 'account' | 'extra' | 'stale' | 'failed'>('ask');
  const stop = () => {
    setState('working');
    unsubscribe(token).then((result) => setState(result.result === 'stale' ? 'stale' : result.stopped), () => setState('failed'));
  };
  // The link of the sign-in address turns "Email me too" off, which stops notification email to every address; an extra address's link removes that address.
  const ask = 'Flux will stop sending notification email. If this message came to your sign-in address, that turns off “Email me too”, so no address of yours gets notification email any more; if it came to an extra address, that address is removed. Your Inbox and push stay as they are, and so does how you sign in.';
  const copy = {
    ask: ['Stop notification emails?', ask],
    working: ['Stop notification emails?', ask],
    account: ['Emails stopped', '“Email me too” is now off, so Flux sends no notification email. Your Inbox and push are unchanged, and you can turn email back on in notification settings.'],
    extra: ['Emails stopped', 'Flux removed this address and will not send notification email to it. Your Inbox, push and other addresses are unchanged.'],
    stale: ['This link no longer applies', 'It was for an address that is no longer one Flux emails, so nothing changed. You can manage your email addresses in notification settings.'],
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
