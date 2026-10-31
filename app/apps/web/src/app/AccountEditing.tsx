import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { useRevalidator, useSearchParams } from 'react-router';
import type { IdentityCapabilities, SessionSummary } from '@flux/contracts';
import { ApiError } from '../api/client';
import { changeEmail, changePassword, endOtherSessions, endSession, getCapabilities, getMe, listSessions, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, updateName } from '../api/auth';
import { Button, Icon, Input, Spinner } from '../ui';

// Settings → Account (#763 SG-1): the person changes their own name, address and password and sees where they are signed
// in. Each is one row with its value and Change; the form opens in place, and saving says so on the row. Under single
// sign-on the provider owns the address and the password, so those rows are not offered.

const failure = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 && error.message ? error.message : fallback);

/** One account fact with Change; its form opens under it and closes on Cancel or once saved. */
function EditRow({ title, value, open, onOpen, done, children }: {
  title: string; value: ReactNode; open: boolean; onOpen: (open: boolean) => void; done: string; children: ReactNode;
}) {
  const formId = useId();
  return (
    <li className="sset-acct">
      <div className="sset-row">
        <span className="sset-row__b"><span className="sset-row__t">{title}</span><span className="sset-row__s">{value}</span></span>
        <Button variant="quiet" aria-expanded={open} aria-controls={open ? formId : undefined} onClick={() => onOpen(!open)}>
          {open ? 'Cancel' : 'Change'}<span className="ui-vh"> {title.toLowerCase()}</span>
        </Button>
      </div>
      {open ? <div className="sset-acct__form" id={formId}>{children}</div> : null}
      <p className="sset-acct__done" role="status">{done && !open ? <><Icon name="check" size={13} />{done}</> : null}</p>
    </li>
  );
}

export function AccountEditing({ name, email }: { name: string; email: string }) {
  const revalidator = useRevalidator();
  const [params] = useSearchParams();
  const [capabilities, setCapabilities] = useState<IdentityCapabilities | null>(null);
  const [open, setOpen] = useState<'name' | 'email' | 'password' | null>(null);
  const [done, setDone] = useState<Record<string, string>>(params.get('email') === 'confirmed' ? { email: 'Your new address is confirmed.' } : {});
  useEffect(() => {
    const controller = new AbortController();
    getCapabilities(controller.signal).then(setCapabilities, () => undefined);
    return () => controller.abort();
  }, []);
  // The provider owns the address and the password under single sign-on (F-024); the server refuses both there too.
  const passwords = capabilities ? !capabilities.ssoOnly && !capabilities.sso : false;
  const finish = (key: string, message: string) => { setOpen(null); setDone((current) => ({ ...current, [key]: message })); revalidator.revalidate(); };
  const toggle = (key: 'name' | 'email' | 'password') => (next: boolean) => { setOpen(next ? key : null); setDone((current) => ({ ...current, [key]: '' })); };
  return (
    <section aria-labelledby="account-edit">
      <h3 className="sset-sub" id="account-edit">Your details</h3>
      <ul className="sset-card">
        <EditRow title="Name" value={name} open={open === 'name'} onOpen={toggle('name')} done={done.name ?? ''}>
          <NameForm current={name} onDone={() => finish('name', 'Name saved. People see it from now on.')} />
        </EditRow>
        {passwords ? (
          <EditRow title="Email" value={email} open={open === 'email'} onOpen={toggle('email')} done={done.email ?? ''}>
            <EmailForm current={email} onDone={(message) => finish('email', message)} />
          </EditRow>
        ) : null}
        {passwords ? (
          <EditRow title="Password" value="Used to sign in on this Flux" open={open === 'password'} onOpen={toggle('password')} done={done.password ?? ''}>
            <PasswordForm onDone={(others) => finish('password', others ? 'Password changed. Your other devices are signed out.' : 'Password changed.')} />
          </EditRow>
        ) : null}
      </ul>
      <Sessions />
    </section>
  );
}

function NameForm({ current, onDone }: { current: string; onDone: () => void }) {
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = value.trim();
    if (!next) { setError('Enter the name people should see.'); return; }
    if (next === current) { onDone(); return; }
    setBusy(true); setError('');
    try { await updateName(next); onDone(); } catch (cause) { setError(failure(cause, 'Your name could not be saved. Try again.')); } finally { setBusy(false); }
  }
  return (
    <form className="sset-acct__fields" noValidate onSubmit={(event) => void submit(event)}>
      <Input label="Name" autoComplete="name" value={value} maxLength={200} autoFocus error={error || undefined} hint="Shown to people you work with." onChange={(event) => { setValue(event.target.value); setError(''); }} />
      <div className="details__actions"><Button type="submit" variant="primary" busy={busy}>Save name</Button></div>
    </form>
  );
}

function EmailForm({ current, onDone }: { current: string; onDone: (message: string) => void }) {
  const [value, setValue] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ email?: string; password?: string; form?: string }>({});
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = value.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next)) { setErrors({ email: 'Enter the new email address.' }); return; }
    if (next === current.toLowerCase()) { setErrors({ email: 'That is already your address.' }); return; }
    if (!password) { setErrors({ password: 'Enter your current password.' }); return; }
    setBusy(true); setErrors({});
    try {
      await changeEmail(next, password);
      // The server answers the same whether the address changed at once, waits for its link, or belongs to someone else.
      const me = await getMe();
      onDone(me?.user.email.toLowerCase() === next ? `Your address is now ${next}.`
        : `If ${next} can be used, a link to confirm it is on its way there. Your address changes once it is opened.`);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'INVALID_PASSWORD') setErrors({ password: 'Your current password is not right.' });
      else setErrors({ form: failure(cause, 'Your address could not be changed. Try again.') });
    } finally { setBusy(false); }
  }
  return (
    <form className="sset-acct__fields" noValidate onSubmit={(event) => void submit(event)}>
      <Input label="New email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} autoFocus value={value}
        error={errors.email} onChange={(event) => { setValue(event.target.value); setErrors({}); }} />
      <Input label="Current password" type="password" autoComplete="current-password" value={password} error={errors.password}
        onChange={(event) => { setPassword(event.target.value); setErrors({}); }} />
      {errors.form ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{errors.form}</p> : null}
      <div className="details__actions"><Button type="submit" variant="primary" busy={busy}>Change email</Button></div>
    </form>
  );
}

function PasswordForm({ onDone }: { onDone: (others: boolean) => void }) {
  const [currentPassword, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [others, setOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<{ current?: string; next?: string; form?: string }>({});
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!currentPassword) { setErrors({ current: 'Enter your current password.' }); return; }
    if (next.length < PASSWORD_MIN_LENGTH) { setErrors({ next: `Use at least ${PASSWORD_MIN_LENGTH} characters.` }); return; }
    if (next.length > PASSWORD_MAX_LENGTH) { setErrors({ next: `Use at most ${PASSWORD_MAX_LENGTH} characters.` }); return; }
    setBusy(true); setErrors({});
    try { await changePassword(currentPassword, next, others); onDone(others); } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'INVALID_PASSWORD') setErrors({ current: 'Your current password is not right.' });
      else setErrors({ form: failure(cause, 'Your password could not be changed. Try again.') });
    } finally { setBusy(false); }
  }
  const othersId = useId();
  return (
    <form className="sset-acct__fields" noValidate onSubmit={(event) => void submit(event)}>
      <Input label="Current password" type="password" autoComplete="current-password" autoFocus value={currentPassword} error={errors.current}
        onChange={(event) => { setCurrent(event.target.value); setErrors({}); }} />
      <Input label="New password" type="password" autoComplete="new-password" value={next} error={errors.next}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`} onChange={(event) => { setNext(event.target.value); setErrors({}); }} />
      <label className="sset-acct__check" htmlFor={othersId}>
        <input id={othersId} type="checkbox" checked={others} onChange={(event) => setOthers(event.target.checked)} />
        <span>Sign out my other devices</span>
      </label>
      {errors.form ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{errors.form}</p> : null}
      <div className="details__actions"><Button type="submit" variant="primary" busy={busy}>Change password</Button></div>
    </form>
  );
}

const when = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dated = (iso: string) => { const date = new Date(iso); return Number.isNaN(date.getTime()) ? iso : when.format(date); };

/** A plain name for a browser from its user agent: enough to tell devices apart, never the raw string. */
function deviceName(agent: string | null): string {
  if (!agent) return 'A browser';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'A browser';
  const system = /iPhone/.test(agent) ? 'iPhone' : /iPad/.test(agent) ? 'iPad' : /Android/.test(agent) ? 'Android' : /Mac OS X/.test(agent) ? 'Mac'
    : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '';
  return system ? `${browser} on ${system}` : browser;
}

/** Where the person is signed in: this device first, then the others with End, and one way to end them all. */
function Sessions() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const load = (signal?: AbortSignal) => listSessions(signal).then((list) => { setSessions(list); setFailed(false); }, () => { if (!signal?.aborted) setFailed(true); });
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, []);
  async function end(id: string | 'others') {
    setBusy(id); setStatus('');
    try {
      if (id === 'others') { const { revoked } = await endOtherSessions(); setStatus(revoked === 1 ? 'Signed out on 1 other device.' : `Signed out on ${revoked} other devices.`); }
      else { await endSession(id); setStatus('Signed out on that device.'); }
      await load();
    } catch { setStatus('That did not work. Try again.'); } finally { setBusy(null); }
  }
  const ordered = sessions ? [...sessions.filter((item) => item.current), ...sessions.filter((item) => !item.current)] : null;
  const others = ordered?.filter((item) => !item.current).length ?? 0;
  return (
    <section aria-labelledby="account-sessions">
      <h3 className="sset-sub" id="account-sessions">Where you’re signed in</h3>
      {failed ? <p className="sset-note" role="alert">Your devices could not be listed. <button type="button" className="ui-link" onClick={() => void load()}>Try again</button></p>
        : !ordered ? <p className="sset-note"><Spinner label="Loading your devices" /></p> : (
          <ul className="sset-card" aria-label="Signed-in devices">
            {ordered.map((item) => (
              <li key={item.id} className="sset-row">
                <span className="sset-row__ic" aria-hidden="true"><Icon name="monitor" size={16} /></span>
                <span className="sset-row__b">
                  <span className="sset-row__t">{deviceName(item.userAgent)}{item.current ? <span className="sset-row__meta"> · this device</span> : null}</span>
                  <span className="sset-row__s">Signed in {dated(item.createdAt)}</span>
                </span>
                {item.current ? null : <Button variant="quiet" busy={busy === item.id} onClick={() => void end(item.id)}>Sign out<span className="ui-vh"> {deviceName(item.userAgent)}, signed in {dated(item.createdAt)}</span></Button>}
              </li>
            ))}
          </ul>
        )}
      {others > 1 ? <div className="details__actions sset-gap"><Button variant="secondary" busy={busy === 'others'} onClick={() => void end('others')}>Sign out all other devices</Button></div> : null}
      <p className="sset-acct__done" role="status">{status}</p>
    </section>
  );
}
