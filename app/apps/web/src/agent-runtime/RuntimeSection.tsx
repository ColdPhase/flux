import { useCallback, useEffect, useRef, useState } from 'react';
import { AGENT_RUNTIME_ERRORS, type AgentRuntimeClient, type AgentRuntimeConnection, type AgentRuntimeStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, Spinner } from '../ui';
import { checkRuntime, dismissNotice, getRuntime, removeRuntime, signOutRuntime } from './api';
import { accountLabel, dateTime, PAYER } from './copy';
import { planUsageLine } from '../ai/connections';
import '../notifications/notifications.css';
import './runtime.css';

// The owner's own plans in Flux (F-022 AIM-3, T4 #279, T6 #281; Connect AI #854): each CLI uses its own account in the
// owner's own place on this server. Before sign-in Flux says who can see the login and who pays; afterwards it shows
// display facts only, with the provider's remaining usage.

const failure = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);

/** What the owner is told before signing in (F-022 "Settings says, before sign-in"). */
export function BeforeSignIn({ status, client = 'claude_code' }: { status: AgentRuntimeStatus; client?: AgentRuntimeClient }) {
  if (client === 'codex') {
    return (
      <ul className="rt-facts" aria-label="Before you sign in">
        <li><b>Who can see your login</b><span>Your login is kept in your own space on this Flux server, never in Flux’s database. The person who runs this server can technically read that storage, so sign in only on a server whose operator you trust.</span></li>
        <li><b>OpenAI’s rules</b><span>OpenAI calls API keys the right default for automation and allows a ChatGPT sign-in when you need to work as your own Codex account. It may restrict this kind of use.</span></li>
        <li><b>Who pays</b><span>It depends on how you sign in: your ChatGPT plan, your organization’s ChatGPT workspace, or your OpenAI API organization. Flux shows what is left of your plan when Codex reports it, adds no limits of its own, and never pays or switches to another payer.</span></li>
        <li><b>What Flux keeps</b><span>Only how you signed in and the time. Never your password, the sign-in code or the login itself.</span></li>
      </ul>
    );
  }
  return (
    <ul className="rt-facts" aria-label="Before you sign in">
      <li><b>Who can see your login</b><span>Your login is kept in your own space on this Flux server, never in Flux’s database. The person who runs this server can technically read that storage, so sign in only on a server whose operator you trust.</span></li>
      <li><b>Anthropic’s rules</b><span>Anthropic recommends API keys for products and automation, and may restrict this kind of use without notice, possibly on your account. Signing in with Anthropic Console is the option Anthropic recommends.</span></li>
      <li><b>Who pays</b><span>It depends on how you sign in: your Claude plan, your organization’s plan, or your Anthropic Console organization. Your plan’s limits apply; Flux adds none of its own, and never pays or switches to another payer.</span></li>
      <li><b>What Flux keeps</b><span>Only how you signed in, your plan if Claude Code reports it, a shortened account name like a***@example.org and the time. Never your password, the sign-in code or the login itself.</span></li>
      {status.commercialTerms ? <li><b>This server</b><span>Its operator states they agreed to Anthropic’s Commercial Terms on {status.commercialTerms.agreedOn}. Flux records that statement; it does not check it.</span></li> : null}
    </ul>
  );
}

function SignedIn({ connection, cli = 'Claude Code' }: { connection: AgentRuntimeConnection; cli?: string }) {
  return (
    <ul className="rt-facts" aria-label={cli === 'Codex' ? 'Your Codex sign-in' : 'Your sign-in'}>
      <li><b>{accountLabel(connection.signInMethod)}</b><span>{[connection.accountLabel, connection.plan].filter(Boolean).join(' · ') || `${cli} reports a login`}{connection.signedInAt ? <>, signed in <time dateTime={connection.signedInAt}>{dateTime(connection.signedInAt)}</time></> : null}</span></li>
      <li><b>Who pays</b><span>{PAYER[connection.payer ?? 'unknown']}</span></li>
    </ul>
  );
}

/** One folded line on Connect AI (F-027 AST-1): plain words about which account fits which work. */
export function WhichAccount({ client = 'claude_code' }: { client?: AgentRuntimeClient }) {
  return (
    <details className="rt-more">
      <summary>Which account should I use?</summary>
      {client === 'codex' ? <>
        <p className="nset__note">A ChatGPT sign-in uses the account or organization you choose in Codex. For automated work, OpenAI recommends an API key; use the API organization that should pay.</p>
        <p className="nset__note">Flux adds no limits of its own. It does not pay for Codex or switch to another payer.</p>
      </> : <>
        <p className="nset__note">Claude Max and Team plans include monthly API credits. Anthropic recommends an API key for work that runs on its own, and a key from your Claude Console organization uses those credits (about 5 minutes in the Claude Console).</p>
        <p className="nset__note">Using Flux for work? In the EU and Switzerland, Claude’s personal plans (Pro, Max) are for non-business use. A Team plan or an API key covers work.</p>
      </>}
    </details>
  );
}

/**
 * One plan in Connect AI (#854), on its own page behind "Change": its state and the provider's remaining usage, who pays,
 * Check sign-in and Sign out. Signing out pauses what uses it; nothing switches to another connection. Removing the whole
 * runtime space signs out of both CLIs.
 */
export function PlanConnection({ client, onStatus }: { client: AgentRuntimeClient; onStatus?: (status: AgentRuntimeStatus) => void }) {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [errorContext, setErrorContext] = useState<{ action: string; uncertain: boolean } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const generation = useRef(0);
  const acting = useRef(false);
  const pendingRead = useRef<AbortController | null>(null);
  const show = useCallback((next: AgentRuntimeStatus) => { setStatus(next); onStatus?.(next); }, [onStatus]);
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
      show(next); setFailed(false);
    }).catch(() => {
      if (current === generation.current && !controller.signal.aborted) setFailed(true);
    }).finally(() => {
      signal?.removeEventListener('abort', abort);
      if (pendingRead.current === controller) pendingRead.current = null;
    });
  }, [show]);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => { controller.abort(); pendingRead.current?.abort(); generation.current += 1; };
  }, [load]);
  // Reads never replace a newer action result; while an action owns the view, skip polling.
  useEffect(() => {
    if (busy || (status?.binding?.state !== 'releasing' && !status?.auth?.[client])) return;
    const timer = window.setTimeout(() => load(), 2000);
    return () => window.clearTimeout(timer);
  }, [status, load, busy, client]);

  const act = async (key: string, action: () => Promise<AgentRuntimeStatus>, fallback: string) => {
    const current = ++generation.current;
    acting.current = true;
    pendingRead.current?.abort();
    setBusy(key); setError(''); setErrorContext(null);
    let refresh = false;
    try {
      const next = await action();
      if (current === generation.current) { show(next); setConfirmRemove(false); }
    } catch (cause) {
      if (current === generation.current) {
        const offRemoval = key === 'remove' && cause instanceof ApiError && cause.status === 409 && cause.code === AGENT_RUNTIME_ERRORS.off;
        // AUTH_BUSY belongs to auth admission, not removal: an unexpected payload cannot prove no deletion.
        const unknownRemovalBusy = key === 'remove' && cause instanceof ApiError && cause.status === 409 && cause.code === AGENT_RUNTIME_ERRORS.authBusy;
        setError(offRemoval ? 'The shared runtime space was not removed. Sign-in is turned off on this server. Ask the person who runs this server to turn it on, then try again.'
          : unknownRemovalBusy ? fallback : failure(cause, fallback));
        setErrorContext({ action: key, uncertain: unknownRemovalBusy || !(cause instanceof ApiError) || cause.status >= 500 });
        refresh = true;
      }
    } finally {
      if (current === generation.current) {
        acting.current = false; setBusy('');
        if (refresh) load();
      }
    }
  };

  if (failed) return <p className="nset__note">This part couldn’t load. <button type="button" className="ui-link" onClick={() => { setFailed(false); load(); }}>Try again</button></p>;
  if (!status) return <p className="inbox__loading"><Spinner label="Loading" /></p>;
  const connection = status.connections[client];
  const binding = status.binding;
  const release = status.lastRelease;
  const removing = binding?.state === 'releasing';
  const signedIn = connection?.state === 'signed_in';
  const again = binding?.state === 'sign_in_again' || connection?.state === 'sign_in_again';
  const authPending = status.auth?.[client];
  const company = client === 'codex' ? 'ChatGPT' : 'Claude';
  const cli = client === 'codex' ? 'Codex' : 'Claude Code';
  const vendor = client === 'codex' ? 'OpenAI' : 'Anthropic';
  const accountSettings = client === 'codex' ? 'your ChatGPT or OpenAI account settings' : 'your Claude account or Anthropic Console settings';
  const confirmedSignOut = binding?.state === 'active' && !binding.recovery && !busy && !error && !authPending
    && status.authCompletion?.disposition !== 'superseded' && connection?.state === 'signed_out'
    && connection.signOut?.failed === false && Boolean(connection.signOut.at) && Number.isFinite(Date.parse(connection.signOut.at))
    ? connection.signOut : null;
  // Nothing to show before a first sign-in: no space yet, no sign-in, no saved outcome and nothing under way.
  if (!binding && !signedIn && !again && !authPending && !connection?.signOut?.failed && !release && !error && !busy) return null;
  // While an action is under way, or its result is unknown, the state shown is only what was last reported.
  const lastReported = Boolean(busy || errorContext?.uncertain);

  return (
    <section className="nset__sec rt" aria-labelledby="rt-h">
      <h3 id="rt-h" className="aset__state"><span className={`aset__dot${signedIn ? ' is-ready' : ''}`} aria-hidden="true" />{company} plan · {lastReported ? 'last reported: ' : ''}{removing ? 'removing' : signedIn ? 'connected' : again ? 'sign in again' : 'not connected'}</h3>
      {signedIn ? <p className="nset__lead" data-testid="plan-usage">{planUsageLine(company, connection?.usage ?? null)}</p> : null}
      {confirmedSignOut ? <p className="nset__note" role="status"><b>Signed out of {cli} in Flux.</b> <time dateTime={confirmedSignOut.at}>{dateTime(confirmedSignOut.at)}</time>.</p> : null}
      {connection?.signOut?.failed && !signedIn ? (
        <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>{vendor} didn’t confirm the sign-out.</b> Flux deleted the login files from your shared runtime space anyway. To be sure the session can’t be used, end it in {accountSettings}.</span></p>
      ) : null}
      {!binding && release?.signOutFailed ? (
        <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Your shared runtime space was removed, but sign-out of at least one client wasn’t confirmed.</b> Flux deleted the local login files anyway. End the session in the corresponding vendor account settings to be sure.</span></p>
      ) : null}
      {!binding && release && release.reason !== 'owner' ? (
        <p className="nset__note">Your shared runtime space was removed on {dateTime(release.at)} {release.reason === 'idle' ? 'because it wasn’t used for a while' : release.reason === 'auth_recovery' ? 'to recover safely after an unconfirmed operation; both Claude Code and Codex may need to sign in again' : 'by the person who runs this server'}. {release.signOutFailed ? 'Sign-out was not confirmed for at least one client; end that session in its vendor account settings.' : 'Flux tried to sign out of both clients first.'}</p>
      ) : null}
      {removing ? <p className="nset__note" role="status"><Spinner /> {binding?.recovery ? 'Recovering your shared runtime space after an unconfirmed operation. Access is disabled; both Claude Code and Codex may need to sign in again after cleanup.' : 'Signing out of both clients and removing your shared runtime space…'}</p> : null}
      {authPending ? <p className="nset__note" role="status"><Spinner /> {authPending === 'signing_out' ? `Sign-out requested. Access is disabled while ${cli} signs out and its login files are removed.` : authPending === 'signing_in' ? 'A sign-in is still in progress.' : 'Checking the current sign-in…'}</p> : null}
      {status.authCompletion?.disposition === 'superseded' ? <p className="nset__problem" role="status">This operation’s result was no longer current and was not accepted. The current state is shown here.</p> : null}
      {error ? <p id="rt-error" className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
      {connection?.accountChange ? (
        <div className="nset__problem rt-notice" role="alert">
          <Icon name="alert" size={14} />
          <span><b>Signed in to a different account than before.</b> {connection.accountChange.previousLabel ? <>It was {connection.accountChange.previousLabel}; now it is {connection.accountLabel ?? 'another account'}.</> : <>It is now {connection.accountLabel ?? 'another account'}.</>} This changed on {dateTime(connection.accountChange.at)}. If you didn’t do this, sign out here now and change your Flux password.</span>
          <Button variant="quiet" busy={busy === 'notice'} onClick={() => void act('notice', () => dismissNotice(client), 'Couldn’t save. Try again.')}>Got it</Button>
        </div>
      ) : null}
      {signedIn && connection ? <SignedIn connection={connection} cli={cli} /> : null}
      {removing ? null : (
        <div className="aset__actions rt-actions">
          {signedIn && !authPending ? <Button variant="secondary" busy={busy === 'check'} onClick={() => void act('check', () => checkRuntime(client), 'Couldn’t check. Try again.')}>Check sign-in</Button> : null}
          {signedIn ? <Button variant="secondary" busy={busy === 'signout'} onClick={() => void act('signout', () => signOutRuntime(client), 'Sign-out could not be confirmed. Access remains disabled while the shared runtime space recovers; both clients may need to sign in again.')}>Sign out</Button> : null}
          {binding && !confirmRemove ? <Button variant="quiet" onClick={() => setConfirmRemove(true)}>Remove shared runtime space from Flux…</Button> : null}
        </div>
      )}
      {signedIn ? <p className="nset__note">Signing out pauses what uses this plan until you pick another model. Nothing switches to another connection by itself.</p> : null}
      {binding && confirmRemove && !removing ? (
        <div className="details__confirm" role="group" aria-label="Remove shared runtime space from Flux">
          <p>Flux tries to sign out of Claude Code and Codex, then deletes both clients’ files from your shared runtime space on this server. If you use either client again, you can set it up later.</p>
          {error && errorContext?.action === 'remove' ? <p className="nset__error" aria-hidden="true"><Icon name="alert" size={14} />{error}</p> : null}
          <div className="aset__actions">
            <Button variant="danger" aria-describedby={error && errorContext?.action === 'remove' ? 'rt-error' : undefined} busy={busy === 'remove'} onClick={() => void act('remove', removeRuntime, 'Removal could not be confirmed. Check the current state before trying again.')}>Sign out and remove</Button>
            <Button variant="quiet" aria-describedby={error && errorContext?.action === 'remove' ? 'rt-error' : undefined} onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
