import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { AgentRuntimeConnection, AgentRuntimeStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, Spinner } from '../ui';
import { checkRuntime, dismissNotice, getRuntime, removeRuntime, signOutRuntime } from './api';
import { dateTime, METHOD_NAME, PAYER } from './copy';
import './runtime.css';

// Claude Code in Flux (F-022 AIM-3, T4 #279): the owner's own Claude Code, signed in to their own
// account in their own runtime. This section says plainly whether the server offers it, who can see
// the login and who pays, before any sign-in; afterwards it shows display facts only.

const failure = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);

/** What the owner is told before signing in (F-022 "Settings says, before sign-in"). */
export function BeforeSignIn({ status }: { status: AgentRuntimeStatus }) {
  return (
    <ul className="rt-facts" aria-label="Before you sign in">
      <li><b>Who can see your login</b><span>Your login is kept in your own runtime on this Flux server, never in Flux’s database. The person who runs this server can technically read that storage, so sign in only on a server whose operator you trust.</span></li>
      <li><b>Anthropic’s rules</b><span>Anthropic recommends API keys for products and automation, and may restrict this kind of use without notice, possibly on your account. Signing in with Anthropic Console (API billing) is the option Anthropic recommends.</span></li>
      <li><b>Who pays</b><span>It depends on how you sign in: your Claude plan, your organization’s plan, or your Anthropic Console organization. Flux cannot see plan limits or costs, and never pays or switches to another payer.</span></li>
      <li><b>What Flux keeps</b><span>Only how you signed in, your plan if Claude Code reports it, a shortened account name like a***@example.org and the time. Never your password, the sign-in code or the login itself.</span></li>
      {status.commercialTerms ? <li><b>This server</b><span>Its operator states they agreed to Anthropic’s Commercial Terms on {status.commercialTerms.agreedOn}. Flux records that statement; it does not check it.</span></li> : null}
    </ul>
  );
}

function SignedIn({ connection }: { connection: AgentRuntimeConnection }) {
  return (
    <ul className="rt-facts" aria-label="Your sign-in">
      <li><b>Signed in</b><span>{[connection.signInMethod ? METHOD_NAME[connection.signInMethod] : null, connection.accountLabel, connection.plan].filter(Boolean).join(' · ') || 'Claude Code reports a login'}{connection.signedInAt ? <>, since <time dateTime={connection.signedInAt}>{dateTime(connection.signedInAt)}</time></> : null}</span></li>
      <li><b>Who pays</b><span>{PAYER[connection.payer ?? 'unknown']}</span></li>
    </ul>
  );
}

export function RuntimeSection() {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const load = useCallback((signal?: AbortSignal) => {
    getRuntime(signal).then((next) => { setStatus(next); setFailed(false); }).catch(() => { if (!signal?.aborted) setFailed(true); });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);
  // While the runtime is being removed, the worker signs out and frees the slot; look again shortly.
  useEffect(() => {
    if (status?.binding?.state !== 'releasing' && !status?.auth?.claude_code) return;
    const timer = window.setTimeout(() => load(), 2000);
    return () => window.clearTimeout(timer);
  }, [status, load]);

  const act = async (key: string, action: () => Promise<AgentRuntimeStatus>, fallback: string) => {
    setBusy(key); setError('');
    try { setStatus(await action()); setConfirmRemove(false); } catch (cause) { setError(failure(cause, fallback)); load(); } finally { setBusy(''); }
  };

  if (failed) return <section className="nset__sec rt" aria-labelledby="rt-h"><h3 id="rt-h">Claude Code in Flux</h3><p className="nset__note">This part couldn’t load. <button type="button" className="ui-link" onClick={() => { setFailed(false); load(); }}>Try again</button></p></section>;
  if (!status) return <section className="nset__sec rt" aria-labelledby="rt-h"><h3 id="rt-h">Claude Code in Flux</h3><p className="inbox__loading"><Spinner label="Loading Claude Code in Flux" /></p></section>;

  const intro = <p className="nset__lead">Your own Claude Code, signed in to your own account as in a terminal, running inside Flux. Only you can use it.</p>;
  if (!status.enabled || status.clients.claude_code !== 'available') {
    return (
      <section className="nset__sec rt" aria-labelledby="rt-h">
        <h3 id="rt-h">Claude Code in Flux</h3>
        {intro}
        <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>{status.enabled ? 'Claude Code isn’t offered on this Flux server.' : 'Not turned on for this Flux server.'}</b> The person who runs this server decides whether it is offered. You can still use Claude Code on your own computer through an <Link className="ui-link" to="/connect-agent">agent connection (MCP)</Link>.</span></p>
      </section>
    );
  }

  const connection = status.connections.claude_code;
  const binding = status.binding;
  const signedIn = connection?.state === 'signed_in';
  const removing = binding?.state === 'releasing';
  const authPending = status.auth?.claude_code;
  const again = binding?.state === 'sign_in_again' || connection?.state === 'sign_in_again';
  const release = status.lastRelease;

  return (
    <section className="nset__sec rt" aria-labelledby="rt-h">
      <h3 id="rt-h" className="aset__state"><span className={`aset__dot${signedIn ? ' is-ready' : ''}`} aria-hidden="true" />Claude Code in Flux · {removing ? 'removing' : signedIn ? 'signed in' : again ? 'sign in again' : 'not signed in'}</h3>
      {intro}
      {connection?.accountChange ? (
        <div className="nset__problem rt-notice" role="alert">
          <Icon name="alert" size={14} />
          <span><b>Signed in to a different account than before.</b> {connection.accountChange.previousLabel ? <>It was {connection.accountChange.previousLabel}; now it is {connection.accountLabel ?? 'another account'}.</> : <>It is now {connection.accountLabel ?? 'another account'}.</>} This changed on {dateTime(connection.accountChange.at)}. If you didn’t do this, sign out here now and change your Flux password.</span>
          <Button variant="quiet" busy={busy === 'notice'} onClick={() => void act('notice', () => dismissNotice('claude_code'), 'Couldn’t save. Try again.')}>Got it</Button>
        </div>
      ) : null}
      {connection?.signOut?.failed && !signedIn ? (
        <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Anthropic didn’t confirm the sign-out.</b> Flux deleted the login from your runtime anyway. To be sure it can’t be used, end the session in your Claude account or Anthropic Console settings.</span></p>
      ) : null}
      {!binding && release?.signOutFailed ? (
        <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Your runtime was removed, but Anthropic didn’t confirm the sign-out.</b> Flux deleted the login anyway. End the session in your Claude account or Anthropic Console settings to be sure.</span></p>
      ) : null}
      {!binding && release && release.reason !== 'owner' ? (
        <p className="nset__note">Your runtime was removed on {dateTime(release.at)} {release.reason === 'idle' ? 'because it wasn’t used for a while' : release.reason === 'auth_recovery' ? 'to recover safely after an unconfirmed operation; both clients need to sign in again' : 'by the person who runs this server'}. It signed out first.</p>
      ) : null}
      {removing ? <p className="nset__note" role="status"><Spinner /> {binding?.recovery ? 'Recovering your runtime after an unconfirmed operation. Access is disabled; both clients may need to sign in again after cleanup.' : 'Signing out and removing your runtime…'}</p> : null}
      {authPending ? <p className="nset__note" role="status"><Spinner /> {authPending === 'signing_out' ? 'Sign-out requested. Access is disabled while Claude Code signs out and its files are removed.' : authPending === 'signing_in' ? 'A sign-in is still in progress.' : 'Checking the current sign-in…'}</p> : null}
      {signedIn && connection ? <SignedIn connection={connection} /> : null}
      {!signedIn && !removing ? (
        status.pool === 'full' && !binding
          ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Every runtime on this server is in use.</b> You can still use your own AI key here, or Claude Code on your computer through an <Link className="ui-link" to="/connect-agent">agent connection (MCP)</Link>.</span></p>
          : <><h4 className="rt-sub">Before you sign in</h4><BeforeSignIn status={status} /></>
      ) : null}
      {status.authCompletion?.disposition === 'superseded' ? <p className="nset__problem" role="status">This operation’s result was no longer current and was not accepted. The current runtime state is shown here.</p> : null}
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
      {removing ? null : (
        <div className="aset__actions rt-actions">
          {!signedIn && !authPending && !(status.pool === 'full' && !binding) ? <Link className="ui-btn ui-btn--primary" to="/settings/assistant/claude-code">{again ? 'Sign in again' : 'Sign in to Claude Code'}</Link> : null}
          {signedIn && !authPending ? <Button variant="secondary" busy={busy === 'check'} onClick={() => void act('check', () => checkRuntime('claude_code'), 'Couldn’t check. Try again.')}>Check sign-in</Button> : null}
          {signedIn ? <Button variant="secondary" busy={busy === 'signout'} onClick={() => void act('signout', () => signOutRuntime('claude_code'), 'Sign-out could not be confirmed. Access remains disabled while the runtime recovers; both clients may need to sign in again.')}>Sign out</Button> : null}
          {binding && !confirmRemove ? <Button variant="quiet" onClick={() => setConfirmRemove(true)}>Remove runtime…</Button> : null}
        </div>
      )}
      {binding && confirmRemove && !removing ? (
        <div className="details__confirm" role="group" aria-label="Remove your runtime">
          <p>Flux signs Claude Code out first, then deletes your runtime’s files and frees it for someone else. You can set it up again later.</p>
          <div className="aset__actions">
            <Button variant="danger" busy={busy === 'remove'} onClick={() => void act('remove', removeRuntime, 'Couldn’t remove it. Nothing changed; try again.')}>Sign out and remove</Button>
            <Button variant="quiet" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
