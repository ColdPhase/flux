import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { AgentRuntimeConnection, AgentRuntimeStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, Spinner } from '../ui';
import { checkRuntime, dismissNotice, getRuntime, removeRuntime, signOutRuntime } from './api';
import { accountLabel, dateTime, PAYER } from './copy';
import './runtime.css';

// Claude Code in Flux (F-022 AIM-3, T4 #279): the owner's own Claude Code, signed in to their own
// account in their own space. This section offers the two subscriptions first (F-027 AST-1.1), says
// plainly when the server does not offer them (AST-1.2), who can see the login and who pays, before any
// sign-in; afterwards it shows display facts only. API keys and the other providers sit under "Other
// ways to connect".

const failure = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);

/** What the owner is told before signing in (F-022 "Settings says, before sign-in"). */
export function BeforeSignIn({ status }: { status: AgentRuntimeStatus }) {
  return (
    <ul className="rt-facts" aria-label="Before you sign in">
      <li><b>Who can see your login</b><span>Your login is kept in your own space on this Flux server, never in Flux’s database. The person who runs this server can technically read that storage, so sign in only on a server whose operator you trust.</span></li>
      <li><b>Anthropic’s rules</b><span>Anthropic recommends API keys for products and automation, and may restrict this kind of use without notice, possibly on your account. Signing in with Anthropic Console is the option Anthropic recommends.</span></li>
      <li><b>Who pays</b><span>It depends on how you sign in: your Claude plan, your organization’s plan, or your Anthropic Console organization. Flux cannot see plan limits or costs, and never pays or switches to another payer.</span></li>
      <li><b>What Flux keeps</b><span>Only how you signed in, your plan if Claude Code reports it, a shortened account name like a***@example.org and the time. Never your password, the sign-in code or the login itself.</span></li>
      {status.commercialTerms ? <li><b>This server</b><span>Its operator states they agreed to Anthropic’s Commercial Terms on {status.commercialTerms.agreedOn}. Flux records that statement; it does not check it.</span></li> : null}
    </ul>
  );
}

function SignedIn({ connection }: { connection: AgentRuntimeConnection }) {
  return (
    <ul className="rt-facts" aria-label="Your sign-in">
      <li><b>{accountLabel(connection.signInMethod)}</b><span>{[connection.accountLabel, connection.plan].filter(Boolean).join(' · ') || 'Claude Code reports a login'}{connection.signedInAt ? <>, signed in <time dateTime={connection.signedInAt}>{dateTime(connection.signedInAt)}</time></> : null}</span></li>
      <li><b>Who pays</b><span>{PAYER[connection.payer ?? 'unknown']}</span></li>
    </ul>
  );
}

/** One folded line on Connect AI (F-027 AST-1): plain words about which account fits which work. */
export function WhichAccount() {
  return (
    <details className="rt-more">
      <summary>Which account should I use?</summary>
      <p className="nset__note">Claude Max and Team plans include monthly API credits. Anthropic recommends an API key for work that runs on its own, and a key from your Claude Console organization uses those credits (about 5 minutes in the Claude Console).</p>
      <p className="nset__note">Using Flux for work? In the EU and Switzerland, Claude’s personal plans (Pro, Max) are for non-business use. A Team plan or an API key covers work.</p>
    </details>
  );
}

export function RuntimeSection({ otherWays }: { otherWays: ReactNode }) {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const generation = useRef(0);
  const acting = useRef(false);
  const pendingRead = useRef<AbortController | null>(null);
  const load = useCallback((signal?: AbortSignal) => {
    if (acting.current) return;
    const current = ++generation.current;
    pendingRead.current?.abort();
    const controller = new AbortController();
    pendingRead.current = controller;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    getRuntime(controller.signal).then((next) => {
      if (current !== generation.current || controller.signal.aborted) return;
      setStatus(next); setFailed(false);
    }).catch(() => {
      if (current === generation.current && !controller.signal.aborted) setFailed(true);
    }).finally(() => {
      signal?.removeEventListener('abort', abort);
      if (pendingRead.current === controller) pendingRead.current = null;
    });
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => { controller.abort(); pendingRead.current?.abort(); generation.current += 1; };
  }, [load]);
  // Reads never replace a newer action result; while an action owns the view, skip polling.
  useEffect(() => {
    if (busy || (status?.binding?.state !== 'releasing' && !status?.auth?.claude_code)) return;
    const timer = window.setTimeout(() => load(), 2000);
    return () => window.clearTimeout(timer);
  }, [status, load, busy]);

  const act = async (key: string, action: () => Promise<AgentRuntimeStatus>, fallback: string) => {
    const current = ++generation.current;
    acting.current = true;
    pendingRead.current?.abort();
    setBusy(key); setError('');
    let refresh = false;
    try {
      const next = await action();
      if (current === generation.current) { setStatus(next); setConfirmRemove(false); }
    } catch (cause) {
      if (current === generation.current) { setError(failure(cause, fallback)); refresh = true; }
    } finally {
      if (current === generation.current) {
        acting.current = false; setBusy('');
        if (refresh) load();
      }
    }
  };

  if (failed) return <section className="nset__sec rt" aria-labelledby="rt-h"><h3 id="rt-h">Claude Code in Flux</h3><p className="nset__note">This part couldn’t load. <button type="button" className="ui-link" onClick={() => { setFailed(false); load(); }}>Try again</button></p>{otherWays}</section>;
  if (!status) return <section className="nset__sec rt" aria-labelledby="rt-h"><h3 id="rt-h">Claude Code in Flux</h3><p className="inbox__loading"><Spinner label="Loading Claude Code in Flux" /></p></section>;

  // AST-1.2: when the server does not offer sign-in, one plain sentence and the API key choices; no sign-in button.
  if (!status.enabled || status.clients.claude_code !== 'available') {
    return (
      <section className="nset__sec rt" aria-labelledby="rt-h">
        <h3 id="rt-h">Claude Code in Flux</h3>
        <p className="nset__note">{status.enabled ? 'Signing in with your Claude subscription isn’t offered on this Flux server.' : 'Signing in with your Claude or ChatGPT subscription isn’t turned on for this Flux server.'}</p>
        {otherWays}
        <WhichAccount />
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
      {!signedIn && !removing && !authPending ? (
        <ul className="sset-card rt-choices">
          <li>
            <Link to="/settings/agents/claude-code" className="sset-row sset-row--link">
              <span className="sset-row__b"><span className="sset-row__t">Sign in with Claude</span><span className="sset-row__s">Use the plan you already pay for</span></span>
              <span className="sset-row__go"><span className="sset-row__go-label">{again ? 'Sign in again' : 'Sign in'}</span></span>
            </Link>
          </li>
          <li>
            <div className="sset-row rt-choice--off" aria-disabled="true">
              <span className="sset-row__b"><span className="sset-row__t">Sign in with ChatGPT</span><span className="sset-row__s">Not available on this Flux server yet</span></span>
            </div>
          </li>
        </ul>
      ) : null}
      {connection?.accountChange ? (
        <div className="nset__problem rt-notice" role="alert">
          <Icon name="alert" size={14} />
          <span><b>Signed in to a different account than before.</b> {connection.accountChange.previousLabel ? <>It was {connection.accountChange.previousLabel}; now it is {connection.accountLabel ?? 'another account'}.</> : <>It is now {connection.accountLabel ?? 'another account'}.</>} This changed on {dateTime(connection.accountChange.at)}. If you didn’t do this, sign out here now and change your Flux password.</span>
          <Button variant="quiet" busy={busy === 'notice'} onClick={() => void act('notice', () => dismissNotice('claude_code'), 'Couldn’t save. Try again.')}>Got it</Button>
        </div>
      ) : null}
      {connection?.signOut?.failed && !signedIn ? (
        <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Anthropic didn’t confirm the sign-out.</b> Flux deleted the login from your Claude Code space anyway. To be sure it can’t be used, end the session in your Claude account or Anthropic Console settings.</span></p>
      ) : null}
      {!binding && release?.signOutFailed ? (
        <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Your Claude Code space was removed, but Anthropic didn’t confirm the sign-out.</b> Flux deleted the login anyway. End the session in your Claude account or Anthropic Console settings to be sure.</span></p>
      ) : null}
      {!binding && release && release.reason !== 'owner' ? (
        <p className="nset__note">Your Claude Code space was removed on {dateTime(release.at)} {release.reason === 'idle' ? 'because it wasn’t used for a while' : release.reason === 'auth_recovery' ? 'to recover safely after an unconfirmed operation; both clients need to sign in again' : 'by the person who runs this server'}. {release.signOutFailed ? 'Vendor sign-out was not confirmed; end the session in your vendor account settings.' : 'It signed out first.'}</p>
      ) : null}
      {removing ? <p className="nset__note" role="status"><Spinner /> {binding?.recovery ? 'Recovering your Claude Code space after an unconfirmed operation. Access is disabled; both clients may need to sign in again after cleanup.' : 'Signing out and removing your Claude Code space…'}</p> : null}
      {authPending ? <p className="nset__note" role="status"><Spinner /> {authPending === 'signing_out' ? 'Sign-out requested. Access is disabled while Claude Code signs out and its files are removed.' : authPending === 'signing_in' ? 'A sign-in is still in progress.' : 'Checking the current sign-in…'}</p> : null}
      {signedIn && connection ? <SignedIn connection={connection} /> : null}
      {!signedIn && !removing ? (
        status.pool === 'full' && !binding
          ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Every Claude Code space on this server is in use.</b> You can still use an API key here, or Claude Code on your own computer through <Link className="ui-link" to="/connect-agent">Local co-work</Link>.</span></p>
          : <><h4 className="rt-sub">Before you sign in</h4><BeforeSignIn status={status} /></>
      ) : null}
      {status.authCompletion?.disposition === 'superseded' ? <p className="nset__problem" role="status">This operation’s result was no longer current and was not accepted. The current state is shown here.</p> : null}
      {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
      {removing ? null : (
        <div className="aset__actions rt-actions">
          {signedIn && !authPending ? <Button variant="secondary" busy={busy === 'check'} onClick={() => void act('check', () => checkRuntime('claude_code'), 'Couldn’t check. Try again.')}>Check sign-in</Button> : null}
          {signedIn ? <Button variant="secondary" busy={busy === 'signout'} onClick={() => void act('signout', () => signOutRuntime('claude_code'), 'Sign-out could not be confirmed. Access remains disabled while the Claude Code space recovers; both clients may need to sign in again.')}>Sign out</Button> : null}
          {binding && !confirmRemove ? <Button variant="quiet" onClick={() => setConfirmRemove(true)}>Remove Claude Code from Flux…</Button> : null}
        </div>
      )}
      {binding && confirmRemove && !removing ? (
        <div className="details__confirm" role="group" aria-label="Remove Claude Code from Flux">
          <p>Flux signs Claude Code out first, then deletes its files from your space on this server and frees the space for someone else. You can set it up again later.</p>
          <div className="aset__actions">
            <Button variant="danger" busy={busy === 'remove'} onClick={() => void act('remove', removeRuntime, 'Removal could not be confirmed. Check the current state before trying again.')}>Sign out and remove</Button>
            <Button variant="quiet" onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      <details className="rt-more"><summary>Other ways to connect</summary>{otherWays}</details>
      <WhichAccount />
    </section>
  );
}
