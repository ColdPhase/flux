import { useEffect, useState } from 'react';
import { Link, useNavigate, useRevalidator } from 'react-router';
import type { AcceptInviteResult, IdentityCapabilities, InvitePreview, InviteRole } from '@flux/contracts';
import { getCapabilities, getMe, type MeResponse } from '../api/auth';
import { ApiError, NetworkError } from '../api/client';
import { acceptInvite, previewInvite } from '../people/api';
import { Button, Icon, Spinner } from '../ui';

// The page an invite link opens (F-035, #763 PE-2): `/join#<token>`. The token stays in the fragment (never sent in a
// request line) and in this tab's session storage, so signing in or creating an account comes back here with it.

const STORE = 'flux.invite-token';
const ROLE_NAME: Record<InviteRole, string> = { admin: 'an admin', member: 'a member', guest: 'a guest' };
const ROLE_SENTENCE: Record<InviteRole, string> = {
  admin: 'Admins add and remove people and manage every project.',
  member: 'Members see projects open to the workspace and the ones given to them.',
  guest: 'Guests see only the projects given to them.',
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
  | { kind: 'ready'; preview: InvitePreview; me: MeResponse | null; signup: IdentityCapabilities['signup']; sso: string | null }
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

export function JoinPage() {
  const [state, setState] = useState<State>(() => (readToken() ? { kind: 'loading' } : { kind: 'problem', ...NO_TOKEN }));
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  useEffect(() => {
    const token = readToken();
    if (!token) return undefined;
    // The token is kept in this tab's session storage: take it out of the address and the browser's history.
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
    const controller = new AbortController();
    Promise.all([getMe(controller.signal).catch(() => null), previewInvite(token, controller.signal),
      getCapabilities(controller.signal).catch(() => null)])
      .then(([me, preview, capabilities]) => setState({ kind: 'ready', preview, me, signup: capabilities?.signup ?? 'open', sso: capabilities?.sso?.label ?? null }),
        (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({ kind: 'problem', ...problemOf(error) });
      });
    return () => controller.abort();
  }, []);

  async function join() {
    const token = readToken();
    setBusy(true); setRefusal('');
    try {
      const result = await acceptInvite(token);
      forgetToken();
      // Said here, before the app opens: a toast would not outlive the change from signed-out pages to the app.
      setState({ kind: 'joined', result });
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
    const open = () => { revalidator.revalidate(); navigate('/', { replace: true }); };
    return (
      <>
        <div className="auth__head"><h1 className="auth__title">{result.status === 'joined' ? `You joined ${result.workspaceName}` : `You’re in ${result.workspaceName}`}</h1>
          <p className="auth__lead">{`You’re ${ROLE_NAME[result.role as InviteRole] ?? `an ${result.role}`} of ${result.workspaceName}.`}</p></div>
        {result.needsUnlockPassword ? (
          <div className="auth__notice" role="status" data-invite-keys="needed">
            <Icon name="lock" />
            <div>
              <p><strong>{result.workspaceName} is encrypted. You don’t have an unlock password yet.</strong></p>
              <p>An owner or admin who has one lets you set yours, together with you. Until then someone else unlocks it after a restart; while it is unlocked you can work in it as usual.</p>
            </div>
          </div>
        ) : null}
        <div className="auth__card"><Button variant="primary" size="lg" block autoFocus onClick={open}>{`Open ${result.workspaceName}`}</Button></div>
      </>
    );
  }

  const { preview, me, signup, sso } = state;
  const already = preview.state !== 'pending';
  return (
    <>
      <div className="auth__head">
        <h1 className="auth__title">{already ? `You’re in ${preview.workspaceName}` : `Join ${preview.workspaceName}`}</h1>
        <p className="auth__lead">{already ? 'This invite link has nothing more to do for this account.'
          : `${preview.invitedBy} invited you to ${preview.workspaceName} as ${ROLE_NAME[preview.role]}. ${ROLE_SENTENCE[preview.role]}`}</p>
      </div>
      {!already && (preview.emailLocked || preview.encrypted) ? (
        <div className="auth__notice" role="note">
          <Icon name={preview.encrypted ? 'lock' : 'mail'} />
          <div>
            {preview.emailLocked ? <p>This link works only for the email address it was sent to.</p> : null}
            {preview.encrypted ? <p>{preview.workspaceName} is encrypted. After a restart it stays locked until an owner or admin unlocks it.
              {preview.role === 'admin' ? ' As an admin you get your own unlock password only when someone who has one lets you set it.' : ''}</p> : null}
          </div>
        </div>
      ) : null}
      <div className="auth__card">
        {already ? (
          <Button variant="primary" size="lg" block onClick={() => { forgetToken(); navigate('/', { replace: true }); }}>Open Flux</Button>
        ) : me ? (
          <>
            <p className="auth__lead">Signed in as <strong>{me.user.email}</strong>.</p>
            {refusal ? <div className="auth__error" role="alert"><Icon name="alert" /><div><p>{refusal}</p></div></div> : null}
            <Button variant="primary" size="lg" block busy={busy} onClick={() => void join()}>{`Join ${preview.workspaceName}`}</Button>
            <p className="auth__alt">Not you? <Link className="ui-link" to="/sign-out">Sign out</Link>, then open the link again.</p>
          </>
        ) : (
          <>
            <Button variant="primary" size="lg" block onClick={() => navigate('/sign-in?next=%2Fjoin')}>Sign in to join</Button>
            {sso && signup === 'off'
              // F-024: with single sign-on the first sign-in makes the account.
              ? <p className="auth__alt">New here? Sign in with {sso}; your account is made the first time.</p>
              : signup === 'off'
              ? <p className="auth__alt">New accounts are closed on this Flux server. Ask {preview.invitedBy} to have one made for you.</p>
              : <Button variant="secondary" size="lg" block onClick={() => navigate('/sign-up?next=%2Fjoin')}>Create an account</Button>}
            {signup === 'verified' ? <p className="auth__alt">After you confirm your email address, open this invite link again.</p> : null}
          </>
        )}
      </div>
      <p className="auth__alt">Expires on {new Date(preview.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}.</p>
    </>
  );
}
