import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  NOTIFICATION_REASONS,
  type ChannelChoice,
  type EmailDestination,
  type NotificationChannel,
  type NotificationPreferences,
  type NotificationReason,
  type UpdateNotificationPreferencesCommand,
} from '@flux/contracts';
import { ApiError } from '../api/client';
import { useShellData } from '../app/data';
import { NotificationsButton } from '../pwa';
import { getPushState } from '../pwa/push';
import { Button, ErrorState, Icon, Spinner, useToast } from '../ui';
import { addAddress, getPreferences, removeAddress, resendVerification, setMute, unsubscribe, updatePreferences, verifyAddress } from './api';
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

const message = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);

/**
 * Notification settings (#116): per reason where it reaches you, where email goes (your sign-in
 * address, a verified extra address, both or nowhere), quiet hours and muted places. Every change
 * saves at once; nothing here changes how you sign in.
 */
export function NotificationSettings() {
  const { projects, directMessages } = useShellData();
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState('');
  const toast = useToast();
  const ids = { email: useId(), quiet: useId(), mute: useId() };

  const load = () => {
    setFailed(false);
    getPreferences().then(setPrefs, () => setFailed(true));
  };
  useEffect(() => { getPreferences().then(setPrefs, () => setFailed(true)); }, []);
  // Push cannot reach anyone when the server has no VAPID keys or the browser has no push.
  const [pushOff, setPushOff] = useState<string | null>(null);
  useEffect(() => {
    getPushState().then((push) => setPushOff(push.state === 'unavailable' ? 'Push is not set up on this Flux server, so the Push column has no effect.'
      : push.state === 'unsupported' ? 'This browser cannot receive push; choices apply to your other devices.' : null), () => undefined);
  }, []);

  // Saves run one after another in the order they were made, each numbered. Only the answer to
  // the newest one replaces what is shown, so an older response never undoes a newer edit.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const sequence = useRef(0);
  function save(run: () => Promise<NotificationPreferences>, done = 'Saved') {
    const mine = ++sequence.current;
    const next = queue.current.then(async () => {
      try {
        const result = await run();
        if (mine === sequence.current) { setPrefs(result); setSaved(done); }
      } catch (error) {
        toast({ message: message(error, 'Could not save. Try again.'), tone: 'danger' });
        if (mine === sequence.current) load();
      }
    });
    queue.current = next;
    return next;
  }
  const change = (command: UpdateNotificationPreferencesCommand, optimistic?: (current: NotificationPreferences) => NotificationPreferences) => {
    if (optimistic) setPrefs((current) => (current ? optimistic(current) : current));
    void save(() => updatePreferences(command));
  };

  if (failed) {
    return (
      <div className="pane-scroll"><div className="pane-in">
        <ErrorState title="Notification settings could not load" actions={<Button onClick={load}>Retry</Button>}><p>Your inbox still works.</p></ErrorState>
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

  return (
    <div className="pane-scroll"><div className="pane-in nset">
      <div className="inbox__head">
        <div>
          <h2>Notifications</h2>
          <p>Choose what reaches you and where. Your inbox keeps everything you can still open.</p>
        </div>
        <span className="nset__saved" role="status" aria-live="polite">{saved ? <><Icon name="check" size={14} />{saved}</> : null}</span>
      </div>

      <section className="nset__sec" aria-labelledby="nset-what">
        <h3 id="nset-what">What reaches you</h3>
        {pushOff ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span>{pushOff} Your inbox always works.</span></p> : null}
        <table className="nset__table">
          <thead><tr><th scope="col"><span className="ui-vh">Reason</span></th>{COLUMNS.map((column) => <th key={column.id} scope="col">{column.label}</th>)}</tr></thead>
          <tbody>
            {NOTIFICATION_REASONS.map((reason) => (
              <tr key={reason}>
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
              </tr>
            ))}
          </tbody>
        </table>
        <p className="nset__note">{emailOff
          ? prefs.email.available ? 'Email is off: you chose in-app only below.' : 'Email delivery unavailable on this server, so only the inbox and push are used.'
          : 'Emails never contain messages or project details, only a link to open in Flux.'}</p>
        <div className="nset__device"><span className="nset__label"><Icon name="bell" size={12} />Push on this device</span><NotificationsButton /></div>
      </section>

      <section className="nset__sec" aria-labelledby={ids.email}>
        <h3 id={ids.email}>Where email goes</h3>
        {!prefs.email.available ? (
          <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Email delivery unavailable.</b> This Flux server has no outgoing mail set up, so nothing is emailed. Your inbox and push still work; an administrator can configure SMTP.</span></p>
        ) : prefs.email.lastFailureAt ? (
          <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>A recent notification email could not be delivered.</b> Flux will retry for a while. Everything is in your inbox.</span></p>
        ) : null}
        <EmailDestinationChoice prefs={prefs} onChange={(destination) => change({ emailDestination: destination }, (current) => ({ ...current, email: { ...current.email, destination } }))} />
        <ExtraAddress prefs={prefs} save={save} />
      </section>

      <section className="nset__sec" aria-labelledby={ids.quiet}>
        <h3 id={ids.quiet}>Quiet hours</h3>
        <QuietHoursForm prefs={prefs} onChange={change} />
      </section>

      <section className="nset__sec" aria-labelledby={ids.mute}>
        <h3 id={ids.mute}>Muted places</h3>
        <p className="nset__lead">Nothing from a muted place notifies you, on any channel. You can still open it.</p>
        {prefs.muted.length ? (
          <ul className="nset__muted">
            {prefs.muted.map((place) => (
              <li key={`${place.type}:${place.id}`}>
                <span className="nset__place">{place.type === 'dm' ? <Icon name="chat" size={14} /> : <span className="nset__hash" aria-hidden="true">#</span>}{place.name}<span className="ui-vh">{place.type === 'dm' ? ', direct message' : ', project'}</span></span>
                <Button variant="quiet" onClick={() => void save(() => setMute({ type: place.type, id: place.id, muted: false }), `Unmuted ${place.name}`)}>Unmute</Button>
              </li>
            ))}
          </ul>
        ) : <p className="nset__none">No muted places.</p>}
        {mutable.length ? <MutePicker places={mutable} onMute={(place) => void save(() => setMute({ type: place.type, id: place.id, muted: true }), `Muted ${place.name}`)} /> : null}
      </section>
    </div></div>
  );
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

function ExtraAddress({ prefs, save }: { prefs: NotificationPreferences; save: (run: () => Promise<NotificationPreferences>, done?: string) => Promise<void> }) {
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
      const next = await addAddress(value.trim());
      await save(() => Promise.resolve(next), 'Verification link sent');
      setValue('');
    } catch (cause) {
      setError(message(cause, 'Could not send the link. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  if (extra) {
    return (
      <div className="nset__extra">
        <div className="nset__addr">
          <Icon name="mail" size={14} />
          <span><b>{extra.email}</b><span>{extra.verified ? 'Confirmed · receives notification email only' : 'Waiting for you to open the link we sent. It works once and expires in 24 hours.'}</span></span>
        </div>
        <div className="nset__actions">
          {!extra.verified ? <Button variant="quiet" onClick={() => void save(resendVerification, 'Sent again')}>Send again</Button> : null}
          <Button variant="quiet" onClick={() => void save(removeAddress, 'Extra address removed')}>Remove</Button>
        </div>
      </div>
    );
  }
  return (
    <form className="nset__add" onSubmit={(event) => void submit(event)} noValidate>
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

function QuietHoursForm({ prefs, onChange }: { prefs: NotificationPreferences; onChange: (command: UpdateNotificationPreferencesCommand, optimistic?: (current: NotificationPreferences) => NotificationPreferences) => void }) {
  const quiet = prefs.quietHours;
  const zones = useMemo(() => timeZones(quiet.timeZone), [quiet.timeZone]);
  const set = (next: Partial<typeof quiet>) => onChange({ quietHours: next }, (current) => ({ ...current, quietHours: { ...current.quietHours, ...next } }));
  const suggested = browserTimeZone();
  return (
    <div className="nset__quiet">
      <label className="nset__switch">
        <input type="checkbox" checked={quiet.enabled} onChange={(event) => set(event.target.checked && quiet.timeZone === 'UTC' && suggested !== 'UTC'
          ? { enabled: true, timeZone: suggested } : { enabled: event.target.checked })} />
        <span><b>Hold push and email during quiet hours</b><span>Your inbox still fills; the rest waits until quiet hours end.</span></span>
      </label>
      <div className={`nset__times${quiet.enabled ? '' : ' is-off'}`}>
        <label>From<input type="time" value={quiet.start} disabled={!quiet.enabled} onChange={(event) => event.target.value && set({ start: event.target.value })} /></label>
        <label>Until<input type="time" value={quiet.end} disabled={!quiet.enabled} onChange={(event) => event.target.value && set({ end: event.target.value })} /></label>
        <label className="nset__zone">Time zone
          <select value={quiet.timeZone} disabled={!quiet.enabled} onChange={(event) => set({ timeZone: event.target.value })}>
            {zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
          </select>
        </label>
      </div>
    </div>
  );
}

function MutePicker({ places, onMute }: { places: { type: 'project' | 'dm'; id: string; name: string }[]; onMute: (place: { type: 'project' | 'dm'; id: string; name: string }) => void }) {
  const [choice, setChoice] = useState('');
  const selectId = useId();
  const place = places.find((item) => `${item.type}:${item.id}` === choice);
  return (
    <div className="nset__row nset__mute">
      <label className="ui-vh" htmlFor={selectId}>Place to mute</label>
      <select id={selectId} value={choice} onChange={(event) => setChoice(event.target.value)}>
        <option value="">Choose a project or conversation…</option>
        {places.some((item) => item.type === 'project') ? <optgroup label="Projects">{places.filter((item) => item.type === 'project').map((item) => <option key={item.id} value={`project:${item.id}`}># {item.name}</option>)}</optgroup> : null}
        {places.some((item) => item.type === 'dm') ? <optgroup label="Direct messages">{places.filter((item) => item.type === 'dm').map((item) => <option key={item.id} value={`dm:${item.id}`}>{item.name}</option>)}</optgroup> : null}
      </select>
      <Button disabled={!place} onClick={() => { if (place) { onMute(place); setChoice(''); } }}>Mute</Button>
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
