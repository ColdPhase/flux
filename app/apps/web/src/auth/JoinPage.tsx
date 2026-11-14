import { useEffect, useRef, useState } from 'react';
import { Form, Link, useActionData, useLocation, useNavigate, useNavigation, useRevalidator } from 'react-router';
import type { AcceptInviteResult, IdentityCapabilities, InvitePreview, InviteRole } from '@flux/contracts';
import { PASSWORD_MIN_LENGTH, getCapabilities, getMe, type MeResponse } from '../api/auth';
import { ApiError, NetworkError } from '../api/client';
import { acceptInvite, previewInvite } from '../people/api';
import { Button, Icon, Input, Spinner } from '../ui';
import type { FormResult } from './logic';

// The page an invite link opens (F-035, #763 PE-2): `/join#<token>`. The token stays in the fragment (never sent in a
// request line) and in this tab's session storage, so signing in comes back here with it. Founder decision 2026-11-13 (#1438):
// the page is the create-account form first (sign in second), joining lands in Everyone with the composer ready, there is no
// "You joined" step, and a member's ordinary role needs no explaining.

const STORE = 'flux.invite-token';
const ROLE_NAME: Record<InviteRole, string> = { admin: 'an admin', member: 'a member', guest: 'a guest' };
/** Only a role other than the ordinary one gets a line. */
const ROLE_SENTENCE: Record<InviteRole, string | null> = {
  admin: 'You’ll be an admin: you can add people and change every space.',
  member: null,
  guest: 'You’ll be a guest: you see only the spaces you’re added to.',
};

function readToken(): string {
  const fromHash = window.location.hash.replace(/^#/, '').trim();
  try {
    if (fromHash) sessionStorage.setItem(STORE, fromHash);
    return fromHash || sessionStorage.getItem(STORE) || '';
  } catch { return fromHash; }
}
function forgetToken() { try { sessionStorage.removeItem(STORE); } catch { /* nothing kept */ } }

type State =
  | { kind: 'loading' }
  | { kind: 'problem'; title: string; text: string }
  /** `ssoOnly`: the provider's label when single sign-on is the only way in (then the provider makes the account, F-024). */
  | { kind: 'ready'; preview: InvitePreview; me: MeResponse | null; ssoOnly: string | null }
  /** Only an admin of an encrypted space without an unlock password stops here: everyone else opens the space at once. */
  | { kind: 'joined'; result: AcceptInviteResult };

function problemOf(error: unknown): { title: string; text: string } {
  if (error instanceof NetworkError) return { title: 'Flux can’t be reached', text: 'Check your connection and open the link again.' };
  if (error instanceof ApiError) {
    if (error.code === 'INVITE_USED') return { title: 'This invite link was already used', text: 'Each link works once. Ask whoever sent it for a new one.' };
    if (error.code === 'INVITE_EXPIRED') return { title: 'This invite link has expired', text: 'Ask whoever sent it for a new one.' };
    if (error.code === 'INVITE_REVOKED') return { title: 'This invite link no longer works', text: 'It was turned off. Ask whoever sent it for a new one.' };
    if (error.status === 429) return { title: 'Too many tries', text: 'Wait a minute, then open the link again.' };
  }
  return { title: 'This invite link doesn’t work', text: 'Check that you opened the whole link, or ask whoever sent it for a new one.' };
}

/** No token in this tab: it was never opened here (signing in in another tab does not carry it). */
const NO_TOKEN = { title: 'Open the invite link again in this tab', text: 'This tab doesn’t have the invite link. If you signed in in another tab, open the link you were sent again here.' };

/** Where joining lands: the space the server named, with its composer ready, or Home. */
function landingOf(result: AcceptInviteResult) {
  return result.landingSpaceId ? `/projects/${result.landingSpaceId}` : '/';
}

export function JoinPage() {
  const [state, setState] = useState<State>(() => (readToken() ? { kind: 'loading' } : { kind: 'problem', ...NO_TOKEN }));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  const revalidator = useRevalidator();
  const created = useActionData() as FormResult | undefined;
  const handled = useRef<FormResult | undefined>(undefined);

  /** What the page shows for the link and this tab's session; `joinNow`: the account was just made here, so it joins at once. */
  function show([me, preview, capabilities]: [MeResponse | null, InvitePreview, IdentityCapabilities | null], joinNow: boolean) {
    // An account made from this link joined as it was made (#1471): the page lands it as a join from here does (#763 FT-3, #1438).
    const madeHere = joinNow || new URLSearchParams(window.location.search).get('created') === '1';
    // A link this account already used, or someone already here: Flux opens, with nothing more to say (#1438).
    if (me && preview.state !== 'pending' && !(madeHere && preview.state === 'joined')) { forgetToken(); navigate('/', { replace: true }); return; }
    setState({ kind: 'ready', preview, me, ssoOnly: capabilities?.ssoOnly ? capabilities.sso?.label ?? 'single sign-on' : null });
    if (me && preview.state !== 'member' && madeHere) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
      void join();
    }
  }
  const failed = (error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    setState({ kind: 'problem', ...problemOf(error) });
  };
  const fetchLink = (signal?: AbortSignal) => Promise.all([getMe(signal).catch(() => null), previewInvite(readToken(), signal),
    getCapabilities(signal).catch(() => null)]);

  // Read on arrival, and again when the page is opened again from itself: signing out from here (a link for another address) lands on this same page, signed out.
  const opened = useRef(false);
  useEffect(() => {
    if (!readToken()) return undefined;
    if (opened.current) setState({ kind: 'loading' });
    opened.current = true;
    // The token is kept in this tab's session storage: take it out of the address and the browser's history.
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    const controller = new AbortController();
    fetchLink(controller.signal).then((read) => show(read, false), failed);
    return () => controller.abort();
    // `join` only reads this tab's token.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // The create-account form on this page made the account and signed it in: join now, as the same account (#1438).
  useEffect(() => {
    if (!created?.created || handled.current === created) return;
    handled.current = created;
    fetchLink().then((read) => show(read, true), failed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [created]);

  async function join() {
    const token = readToken();
    setBusy(true); setRefusal('');
    try {
      const result = await acceptInvite(token);
      forgetToken();
      // F-030: an admin of an encrypted space without an unlock password is told so before it opens; a toast would not outlive the change of pages.
      if (result.needsUnlockPassword) { setState({ kind: 'joined', result }); return; }
      revalidator.revalidate();
      navigate(landingOf(result), { replace: true, state: { focusComposer: true } });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'INVITE_WRONG_ACCOUNT') {
        setRefusal('This link was made for a different email address. Sign out and sign in with the address it was sent to, or ask for a link for this account.');
      } else if (error instanceof ApiError && error.status === 401) {
        navigate('/sign-in?next=%2Fjoin');
      } else setState({ kind: 'problem', ...problemOf(error) });
    } finally { setBusy(false); }
  }

  if (state.kind === 'loading') return <div className="auth__card" aria-busy="true"><Spinner label="Opening the invite link" /></div>;
  if (state.kind === 'problem') {
    return (
      <>
        <div className="auth__head"><h1 className="auth__title">{state.title}</h1><p className="auth__lead">{state.text}</p></div>
        <p className="auth__alt"><Link className="ui-link" to="/">Open Flux</Link></p>
      </>
    );
  }
  if (state.kind === 'joined') {
    const { result } = state;
    const open = () => { revalidator.revalidate(); navigate(landingOf(result), { replace: true, state: { focusComposer: true } }); };
    return (
      <>
        <div className="auth__head"><h1 className="auth__title">{`You joined ${result.workspaceName}`}</h1>
          <p className="auth__lead">{`You’re ${ROLE_NAME[result.role as InviteRole] ?? `an ${result.role}`} of ${result.workspaceName}.`}</p></div>
        <div className="auth__notice" role="status" data-invite-keys="needed">
          <Icon name="lock" />
          <div>
            <p><strong>{result.workspaceName} is encrypted. You don’t have an unlock password yet.</strong></p>
            <p>An owner or admin who has one lets you set yours, together with you. Until then someone else unlocks it after a restart; while it is unlocked you can work in it as usual.</p>
          </div>
        </div>
        <div className="auth__card"><Button variant="primary" size="lg" block autoFocus onClick={open}>{`Open ${result.workspaceName}`}</Button></div>
      </>
    );
  }

  const { preview, me, ssoOnly } = state;
  const roleLine = ROLE_SENTENCE[preview.role];
  const notes = preview.emailLocked || preview.encrypted ? (
    <div className="auth__notice" role="note">
      <Icon name={preview.encrypted ? 'lock' : 'mail'} />
      <div>
        {preview.emailLocked ? <p>This link works only for {preview.email ? <strong>{preview.email}</strong> : 'the email address it was sent to'}.</p> : null}
        {preview.encrypted ? <p>{preview.workspaceName} is encrypted. After a restart it stays locked until an owner or admin unlocks it.
          {preview.role === 'admin' ? ' As an admin you get your own unlock password only when someone who has one lets you set it.' : ''}</p> : null}
      </div>
    </div>
  ) : null;
  const head = (
    <div className="auth__head">
      <h1 className="auth__title">{`Join ${preview.workspaceName}`}</h1>
      <p className="auth__lead">{`${preview.invitedBy} invited you.`}{roleLine ? ` ${roleLine}` : ''}</p>
    </div>
  );
  const expires = <p className="auth__alt">Expires on {new Date(preview.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.</p>;
  if (me) {
    // A link for one address cannot be used by another account (#1424): no Join that could only be refused. Signing out lands on this page again,
    // signed out, where the address is filled in and locked, for the person who has an account and the one who does not.
    if (preview.email !== null && me.user.email.trim().toLowerCase() !== preview.email) {
      return (
        <>
          {head}
          {notes}
          <div className="auth__card">
            <p className="auth__lead">Signed in as <strong>{me.user.email}</strong>.</p>
            <Form method="post" action="/sign-out" aria-label="Sign out to use this link">
              <input type="hidden" name="next" value="/join" />
              <Button type="submit" variant="primary" size="lg" block>Sign out to use this link</Button>
            </Form>
          </div>
          {expires}
        </>
      );
    }
    return (
      <>
        {head}
        {notes}
        <div className="auth__card">
          <p className="auth__lead">Signed in as <strong>{me.user.email}</strong>.</p>
          {refusal ? <div className="auth__error" role="alert"><Icon name="alert" /><div><p>{refusal}</p></div></div> : null}
          <Button variant="primary" size="lg" block busy={busy} onClick={() => void join()}>{`Join ${preview.workspaceName}`}</Button>
          <p className="auth__alt">Not you? <Link className="ui-link" to="/sign-out">Sign out</Link>, then open the link again.</p>
        </div>
        {expires}
      </>
    );
  }
  // F-024: with single sign-on as the only way in, the first sign-in makes the account. Otherwise an invite link always allows one (#1471).
  if (ssoOnly) {
    return (
      <>
        {head}
        {notes}
        <div className="auth__card">
          <Button variant="primary" size="lg" block onClick={() => navigate('/sign-in?next=%2Fjoin')}>Sign in to join</Button>
          <p className="auth__alt">New here? Sign in with {ssoOnly}; your account is made the first time.</p>
        </div>
        {expires}
      </>
    );
  }
  return (
    <>
      {head}
      {notes}
      <JoinSignUp result={created} token={readToken()} lockedEmail={preview.email} />
      <p className="auth__alt">Already have an account? <Link className="ui-link" to="/sign-in?next=%2Fjoin">Sign in to join</Link></p>
      {expires}
    </>
  );
}

/** The create-account form first (#1438): the same fields and rules as the sign-up page; the route's action makes the account, then the page joins. */
function JoinSignUp({ result, token, lockedEmail }: { result: FormResult | undefined; token: string; lockedEmail: string | null }) {
  const navigation = useNavigation();
  const submitting = navigation.state === 'submitting' || (navigation.state === 'loading' && navigation.formMethod !== undefined) || !!result?.created;
  const formRef = useRef<HTMLFormElement>(null);
  const [passwordLength, setPasswordLength] = useState(0);
  const [editedAfter, setEditedAfter] = useState<typeof result>(undefined);
  const passwordError = editedAfter === result && passwordLength >= PASSWORD_MIN_LENGTH ? undefined : result?.fieldErrors?.password;
  useEffect(() => {
    if (result?.fieldErrors && Object.values(result.fieldErrors).some(Boolean)) formRef.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus();
  }, [result]);
  return (
    <Form method="post" className="auth__form" noValidate ref={formRef} aria-label="Create account and join">
      {result?.formError ? (
        <div className="auth__error" role="alert"><Icon name="alert" /><div><p>{result.formError}</p>
          {result.accountExists ? <p><Link className="ui-link" to="/sign-in?next=%2Fjoin">Sign in to join</Link> · <Link className="ui-link" to="/forgot-password">Reset password</Link></p> : null}</div></div>
      ) : null}
      <Input label="Name" name="name" autoComplete="name" defaultValue={result?.values?.name} error={result?.fieldErrors?.name} hint="Shown to people you work with." autoFocus />
      {/* #1471: the account is made from this link; a link for one address fills it in, read-only. */}
      <input type="hidden" name="inviteToken" value={token} />
      <Input label="Email" name="email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false}
        readOnly={lockedEmail !== null} defaultValue={lockedEmail ?? result?.values?.email} error={result?.fieldErrors?.email}
        hint={lockedEmail !== null ? 'This invite is for this address.' : undefined} />
      <Input label="Password" name="password" type="password" autoComplete="new-password" error={passwordError}
        onChange={(event) => { setPasswordLength(event.target.value.length); setEditedAfter(result); }}
        hint={passwordLength >= PASSWORD_MIN_LENGTH ? undefined : `At least ${PASSWORD_MIN_LENGTH} characters. A short sentence works well.`} />
      <Button type="submit" variant="primary" size="lg" block busy={submitting}>{submitting ? 'Joining…' : 'Create account and join'}</Button>
    </Form>
  );
}
