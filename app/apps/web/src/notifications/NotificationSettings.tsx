import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { MAX_EXTRA_ADDRESSES, type NotificationAddress, type NotificationLevel, type NotificationPreferences, type UpdateNotificationPreferencesCommand } from '@flux/contracts';
import { ApiError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { useShellData } from '../app/data';
import { InstallFlux, NotificationsButton } from '../pwa';
import { getPushState, pushOnServer } from '../pwa/push';
import { SwitchRow } from '../ui/SwitchRow';
import { noteSoundPreferences } from './sound';
import { captureNotificationSession, isCurrentNotificationSession } from './session';
import { Button, ErrorState, Icon, MEDIA, Spinner, useMediaQuery, useToast, Select, Option, OptionGroup, TimeField } from '../ui';
import { addAddress, getPreferences, removeAddress, resendVerification, setAddressEnabled, setMute, unsubscribe, updatePreferences, verifyAddress } from './api';
import { LEVELS } from './levels';
import { notificationsChanged } from './mutes';
import './notifications.css';

type MutedPlace = NotificationPreferences['muted'][number];
type PendingMute = { place: MutedPlace; muted: boolean };


function browserTimeZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function timeZones(current: string) {
  let zones: string[];
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
  const ids = { level: useId(), where: useId(), sound: useId(), email: useId(), quiet: useId(), muted: useId() };

  const queue = useRef<Promise<void>>(Promise.resolve());
  const sequence = useRef(0);
  const reads = useRef(0);
  const load = useCallback(() => {
    const mine = ++reads.current, edit = sequence.current;
    getPreferences().then((next) => {
      if (mounted.current && mine === reads.current && edit === sequence.current) {
        hasPreferences.current = true;
        setPrefs(next); setFailed(false); setStaleRead(false); noteSoundPreferences(ownerId, next.sound);
      }
    }, () => {
      if (mounted.current && mine === reads.current && edit === sequence.current) {
        if (hasPreferences.current) setStaleRead(true);
        else setFailed(true);
      }
    });
  }, [ownerId]);
  useEffect(load, [load]);
  // A place muted or unmuted from its ⋯ menu, here or in another tab (#1249), is read again: this list is the overview of the same mutes.
  useStreamEvents(ownerId, (event) => { if (notificationsChanged(event)) load(); }, load);
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
        setPrefs(result); setSaved(done); setPendingMute(null); setStaleRead(false); noteSoundPreferences(ownerId, result.sound);
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
  // The addresses a notification email goes to: the sign-in address and each confirmed extra one that is switched on (C-49).
  const addresses = (email.accountEnabled ? 1 : 0) + email.addresses.filter((item) => item.verified && item.enabled).length;
  const switchExtra = (id: string, enabled: boolean) => {
    setPrefs((current) => current && { ...current, email: { ...current.email, addresses: current.email.addresses.map((item) => item.id === id ? { ...item, enabled } : item) } });
    void save(() => setAddressEnabled(id, enabled));
  };
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
            detail={prefs.level === 'nothing' ? 'Not used while you hear about Nothing' : addresses === 0 ? 'No address is switched on' : `To ${addresses} ${addresses === 1 ? 'address' : 'addresses'}`}
            onChange={(emailMe) => change({ emailMe }, (current) => ({ ...current, emailMe }))} />
        ) : null}
        {pushServerOff ? null : (
          <div className="sset-row sset-row--stack"><span className="sset-row__t">On this device</span><NotificationsButton installStepsBelow={phone} /></div>
        )}
        <QuietHours prefs={prefs} open={quietOpen} panelId={ids.quiet} onToggle={() => setQuietOpen((open) => !open)} onChange={change} />
      </div>

      {/* Two sound switches (founder decision, 2026-11-12, #1243): an open tab plays them with a notice, so the level and quiet hours hold them too. */}
      <h3 className="sset-sec" id={ids.sound}>Sound</h3>
      <div className="sset-card" role="group" aria-labelledby={ids.sound}>
        <SwitchRow label="Sound for messages" checked={prefs.sound.messages}
          detail={prefs.level === 'nothing' ? 'Not used while you hear about Nothing' : 'A soft sound for messages to you and mentions while Flux is open'}
          onChange={(messages) => change({ sound: { messages } }, (current) => ({ ...current, sound: { ...current.sound, messages } }))} />
        <SwitchRow label="Sound when someone calls me" checked={prefs.sound.calls}
          detail={prefs.level === 'nothing' ? 'Not used while you hear about Nothing' : 'One soft chime when someone invites you to a call'}
          onChange={(calls) => change({ sound: { calls } }, (current) => ({ ...current, sound: { ...current.sound, calls } }))} />
      </div>

      {email.available ? (
        <>
          <h3 className="sset-sec" id={ids.email}>Email addresses</h3>
          {email.lastFailureAt ? (
            <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>A recent notification email could not be delivered.</b> Flux will retry for a while. Everything is in your inbox.</span></p>
          ) : null}
          <div className="sset-card" role="group" aria-labelledby={ids.email}>
            <AddressRow email={email.accountAddress} note="Your sign-in address" ticked={email.accountEnabled}
              onTick={(accountEnabled) => change({ accountEnabled }, (current) => ({ ...current, email: { ...current.email, accountEnabled } }))} />
            {email.addresses.map((address) => <ExtraAddress key={address.id} address={address} save={save} onSwitch={switchExtra} />)}
            <AddAddress full={email.addresses.length >= MAX_EXTRA_ADDRESSES} save={save} />
          </div>
          <p className="sset-note">
            {prefs.emailMe ? 'We send a confirmation link to a new address before any notification goes there.' : '“Email me too” is off, so no address gets notification email. Each address keeps its own switch.'}
          </p>
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
            <p className="nset__lead">A muted place is quiet for ordinary messages: no notices, push or email. What needs you still arrives: mentions, questions, tasks for you, decisions about your work, invitations and agents waiting for your OK. You can still open it.</p>
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
              <div className="nset__time"><label htmlFor={`${panelId}-from`}>From</label><TimeField id={`${panelId}-from`} value={quiet.start} onChange={(start) => set({ start })} /></div>
              <div className="nset__time"><label htmlFor={`${panelId}-until`}>Until</label><TimeField id={`${panelId}-until`} value={quiet.end} onChange={(end) => set({ end })} /></div>
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

/**
 * One address as the final design draws it: a tick on the left, the address and a line under it, and the quiet actions at the right
 * edge: Send again, then Remove. On a phone Remove stays at the right edge of the first line and Send again drops under the text, so
 * a long address is never squeezed and Remove is in the same place on every row.
 */
function AddressRow({ email, note, ticked, disabled, onTick, send, remove }: {
  email: string; note: string; ticked: boolean; disabled?: boolean; onTick?: (on: boolean) => void; send?: ReactNode; remove?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="sset-row nset__addr">
      <label className="nset__tick">
        <input id={id} type="checkbox" checked={ticked} disabled={disabled} aria-label={`Notification email to ${email}`} aria-describedby={`${id}-d`}
          onChange={(event) => onTick?.(event.target.checked)} />
      </label>
      <label className="sset-row__b" htmlFor={id}>
        <span className="sset-row__t">{email}</span>
        <span className="sset-row__s" id={`${id}-d`}>{note}</span>
      </label>
      {send ? <span className="nset__send">{send}</span> : null}
      {remove ? <span className="nset__remove">{remove}</span> : null}
    </div>
  );
}

/** One extra address: confirmed, with its tick and Remove, or waiting for its link, with Send again and Remove. */
function ExtraAddress({ address, save, onSwitch }: { address: NotificationAddress; save: Save; onSwitch: (id: string, enabled: boolean) => void }) {
  const remove = <Button variant="quiet" size="sm" aria-label={`Remove ${address.email}`} onClick={() => void save(() => removeAddress(address.id), 'Address removed')}>Remove</Button>;
  if (address.verified) return <AddressRow email={address.email} note="Confirmed" ticked={address.enabled} onTick={(enabled) => onSwitch(address.id, enabled)} remove={remove} />;
  return (
    <AddressRow email={address.email} note="Waiting for you to confirm it from that inbox" ticked={false} disabled remove={remove}
      send={<Button variant="quiet" size="sm" aria-label={`Send again to ${address.email}`} onClick={() => void save(() => resendVerification(address.id), 'Sent again')}>Send again</Button>} />
  );
}

/** The field to add another address, until the person has as many as they may. */
function AddAddress({ full, save }: { full: boolean; save: Save }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();

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

  if (full) return <p className="sset-row sset-row__s">You can keep up to {MAX_EXTRA_ADDRESSES} more addresses. Remove one to add another.</p>;
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
        {places.some((item) => item.type === 'dm') ? <OptionGroup label="Messages">{places.filter((item) => item.type === 'dm').map((item) => <Option key={item.id} value={`dm:${item.id}`}>{item.name}</Option>)}</OptionGroup> : null}
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

/** `/settings/notifications/verify?token=`: confirms one extra address for the signed-in account. */
export function VerifyAddress() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<{ status: 'working' } | { status: 'done'; email: string } | { status: 'failed'; text: string }>({ status: 'working' });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    verifyAddress(token).then((prefs) => setState({ status: 'done', email: prefs.confirmed }),
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
  // Each email's link switches off the address it came to (C-49); the person's other addresses keep their own switches.
  const ask = 'Flux will stop sending notification email to the address this message came to. Your other addresses, your Inbox and push stay as they are, and so does how you sign in. You can switch the address back on in notification settings.';
  const copy = {
    ask: ['Stop notification emails to this address?', ask],
    working: ['Stop notification emails to this address?', ask],
    account: ['Emails stopped', 'Flux will not send notification email to your sign-in address any more. Your other addresses, your Inbox and push are unchanged, and you can switch it back on in notification settings.'],
    extra: ['Emails stopped', 'Flux will not send notification email to this address any more. Your other addresses, your Inbox and push are unchanged, and you can switch it back on in notification settings.'],
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
