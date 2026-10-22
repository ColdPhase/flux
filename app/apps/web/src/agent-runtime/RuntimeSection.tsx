import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AGENT_RUNTIME_ERRORS, type AgentRuntimeClient, type AgentRuntimeConnection, type AgentRuntimeStatus } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, Icon, Spinner } from '../ui';
import { checkRuntime, dismissNotice, getRuntime, removeRuntime, signOutRuntime } from './api';
import { accountLabel, dateTime, PAYER } from './copy';
import './runtime.css';

// The owner's own client sign-ins in Flux (F-022 AIM-3, T4 #279, T6 #281): each client uses its own
// account in the owner's shared runtime space. This section offers the subscriptions first (F-027 AST-1.1),
// says plainly when this server does not offer them (AST-1.2), who can see each login and who pays, before
// sign-in; afterwards it shows display facts only. API keys and other providers sit under "Other ways to connect".

const failure = (error: unknown, fallback: string) => (error instanceof ApiError && error.status < 500 ? error.message : fallback);

/** What the owner is told before signing in (F-022 "Settings says, before sign-in"). */
export function BeforeSignIn({ status, client = 'claude_code' }: { status: AgentRuntimeStatus; client?: AgentRuntimeClient }) {
  if (client === 'codex') {
    return (
      <ul className="rt-facts" aria-label="Before you sign in">
        <li><b>Who can see your login</b><span>Your login is kept in your own space on this Flux server, never in Flux’s database. The person who runs this server can technically read that storage, so sign in only on a server whose operator you trust.</span></li>
        <li><b>OpenAI’s rules</b><span>OpenAI calls API keys the right default for automation and allows a ChatGPT sign-in when you need to work as your own Codex account. It may restrict this kind of use.</span></li>
        <li><b>Who pays</b><span>It depends on how you sign in: your ChatGPT plan, your organization’s ChatGPT workspace, or your OpenAI API organization. Flux cannot see plan limits or costs, and never pays or switches to another payer.</span></li>
        <li><b>What Flux keeps</b><span>Only how you signed in and the time. Never your password, the sign-in code or the login itself.</span></li>
      </ul>
    );
  }
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
        <p className="nset__note">Flux cannot see plan limits or costs. It does not pay for Codex or switch to another payer.</p>
      </> : <>
        <p className="nset__note">Claude Max and Team plans include monthly API credits. Anthropic recommends an API key for work that runs on its own, and a key from your Claude Console organization uses those credits (about 5 minutes in the Claude Console).</p>
        <p className="nset__note">Using Flux for work? In the EU and Switzerland, Claude’s personal plans (Pro, Max) are for non-business use. A Team plan or an API key covers work.</p>
      </>}
    </details>
  );
}

export function RuntimeSection({ otherWays }: { otherWays: ReactNode }) {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [errorContext, setErrorContext] = useState<{ action: string; uncertain: boolean } | null>(null);
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
    if (busy || (status?.binding?.state !== 'releasing' && !status?.auth?.claude_code && !status?.auth?.codex)) return;
    const timer = window.setTimeout(() => load(), 2000);
    return () => window.clearTimeout(timer);
  }, [status, load, busy]);

  const act = async (key: string, action: () => Promise<AgentRuntimeStatus>, fallback: string) => {
    const current = ++generation.current;
    acting.current = true;
    pendingRead.current?.abort();
    setBusy(key); setError(''); setErrorContext(null);
    let refresh = false;
    try {
      const next = await action();
      if (current === generation.current) { setStatus(next); setConfirmRemove(false); }
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

  if (failed) return <section className="nset__sec rt" aria-labelledby="rt-h"><h3 id="rt-h">Agent sign-in in Flux</h3><p className="nset__note">This part couldn’t load. <button type="button" className="ui-link" onClick={() => { setFailed(false); load(); }}>Try again</button></p>{otherWays}</section>;
  if (!status) return <section className="nset__sec rt" aria-labelledby="rt-h"><h3 id="rt-h">Agent sign-in in Flux</h3><p className="inbox__loading"><Spinner label="Loading agent sign-in" /></p></section>;

  // AST-1.2: when the server does not offer sign-in, one plain sentence and the API key choices; no sign-in button.
  const claudeOn = status.clients.claude_code === 'available';
  const codexOn = status.clients.codex === 'available';
  if (!status.enabled || (!claudeOn && !codexOn)) {
    return (
      <section className="nset__sec rt" aria-labelledby="rt-h">
        <h3 id="rt-h">Agent sign-in in Flux</h3>
        <p className="nset__note">{status.enabled ? 'Signing in with your Claude subscription isn’t offered on this Flux server.' : 'Signing in with your Claude or ChatGPT subscription isn’t turned on for this Flux server.'}</p>
        {otherWays}
        <WhichAccount />
      </section>
    );
  }

  // The section's heading follows Claude Code when it is offered, else Codex (F-022 T6 #281); Codex, when
  // offered beside it, has its own short block below.
  const primary: AgentRuntimeClient = claudeOn ? 'claude_code' : 'codex';
  const cli = primary === 'codex' ? 'Codex' : 'Claude Code';
  const vendor = primary === 'codex' ? 'OpenAI' : 'Anthropic';
  const accountSettings = primary === 'codex' ? 'your ChatGPT or OpenAI account settings' : 'your Claude account or Anthropic Console settings';
  const removeLabel = 'Remove shared runtime space from Flux…';
  const removeGroupLabel = 'Remove shared runtime space from Flux';
  const removeDisclosure = 'Flux tries to sign out of Claude Code and Codex, then deletes both clients’ files from your shared runtime space on this server and frees the space for someone else. If you use either client again, you can set it up later.';
  const connection = status.connections[primary];
  const binding = status.binding;
  const signedIn = connection?.state === 'signed_in';
  const removing = binding?.state === 'releasing';
  const authPending = status.auth?.[primary];
  const codex = status.connections.codex;
  const codexSignedIn = codexOn && codex?.state === 'signed_in';
  const codexPending = status.auth?.codex;
  const codexAgain = codex?.state === 'sign_in_again';
  const again = binding?.state === 'sign_in_again' || connection?.state === 'sign_in_again';
  const release = status.lastRelease;
  const lastReported = Boolean(busy || errorContext?.uncertain);
  const clientState = (available: boolean, current: AgentRuntimeConnection | null | undefined, pending: string | undefined) =>
    !available ? 'not offered' : pending ? pending === 'signing_in' ? 'signing in' : pending === 'signing_out' ? 'signing out' : 'checking sign-in'
      : current?.state === 'signed_in' ? 'signed in' : current?.state === 'sign_in_again' ? 'sign in again' : 'not signed in';
  const claudeState = clientState(claudeOn, status.connections.claude_code, status.auth?.claude_code);
  const codexState = clientState(codexOn, codex, status.auth?.codex);
  const heading = claudeOn && codexOn
    ? `Claude Code and Codex in Flux · ${lastReported ? 'last reported: ' : ''}Claude Code ${claudeState} · Codex ${codexState}`
    : `${cli} in Flux · ${lastReported ? 'last reported: ' : ''}${removing ? 'removing' : signedIn ? 'signed in' : again ? 'sign in again' : 'not signed in'}`;
  // Only current saved facts confirm sign-out; an action ACK or an older receipt cannot do so.
  const confirmedSignOut = binding?.state === 'active' && !binding.recovery && !busy && !error && !authPending
    && status.authCompletion?.disposition !== 'superseded' && connection?.state === 'signed_out'
    && connection.signOut?.failed === false && Boolean(connection.signOut.at) && Number.isFinite(Date.parse(connection.signOut.at))
    ? connection.signOut : null;

  return (
    <section className="nset__sec rt" aria-labelledby="rt-h">
      <h3 id="rt-h" className="aset__state"><span className={`aset__dot${signedIn || codexSignedIn ? ' is-ready' : ''}`} aria-hidden="true" />{heading}</h3>
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
      {!removing && !authPending && !codexPending && ((claudeOn && !signedIn) || !codexSignedIn) ? (
        <ul className="sset-card rt-choices">
          {claudeOn && !signedIn ? <li>
            <Link to="/settings/agents/claude-code" className="sset-row sset-row--link">
              <span className="sset-row__b"><span className="sset-row__t">Sign in with Claude</span><span className="sset-row__s">Use the plan you already pay for</span></span>
              <span className="sset-row__go"><span className="sset-row__go-label">{again ? 'Sign in again' : 'Sign in'}</span></span>
            </Link>
          </li> : null}
          {!codexSignedIn ? <li>
            {codexOn ? (
              <Link to="/settings/agents/codex" className="sset-row sset-row--link">
                <span className="sset-row__b"><span className="sset-row__t">Sign in with ChatGPT</span><span className="sset-row__s">Use the plan you already pay for</span></span>
                <span className="sset-row__go"><span className="sset-row__go-label">{codexAgain ? 'Sign in again' : 'Sign in'}</span></span>
              </Link>
            ) : (
              <div className="sset-row rt-choice--off" aria-disabled="true">
                <span className="sset-row__b"><span className="sset-row__t">Sign in with ChatGPT</span><span className="sset-row__s">Not offered on this Flux server</span></span>
              </div>
            )}
          </li> : null}
        </ul>
      ) : null}
      {connection?.accountChange ? (
        <div className="nset__problem rt-notice" role="alert">
          <Icon name="alert" size={14} />
          <span><b>Signed in to a different account than before.</b> {connection.accountChange.previousLabel ? <>It was {connection.accountChange.previousLabel}; now it is {connection.accountLabel ?? 'another account'}.</> : <>It is now {connection.accountLabel ?? 'another account'}.</>} This changed on {dateTime(connection.accountChange.at)}. If you didn’t do this, sign out here now and change your Flux password.</span>
          <Button variant="quiet" busy={busy === 'notice'} onClick={() => void act('notice', () => dismissNotice(primary), 'Couldn’t save. Try again.')}>Got it</Button>
        </div>
      ) : null}
      {signedIn && connection ? <SignedIn connection={connection} cli={cli} /> : null}
      {primary === 'claude_code' && codexSignedIn && codex && !removing ? (
        <div className="rt-codex" aria-label="Codex in Flux">
          <h4 className="rt-sub"><span className="aset__dot is-ready" aria-hidden="true" /> Codex in Flux · signed in</h4>
          <SignedIn connection={codex} cli="Codex" />
          <div className="aset__actions rt-actions">
            {!codexPending ? <Button variant="secondary" busy={busy === 'check-codex'} onClick={() => void act('check-codex', () => checkRuntime('codex'), 'Couldn’t check. Try again.')}>Check ChatGPT sign-in</Button> : null}
            <Button variant="secondary" busy={busy === 'signout-codex'} onClick={() => void act('signout-codex', () => signOutRuntime('codex'), 'Sign-out could not be confirmed. Access remains disabled while the shared runtime space recovers; both clients may need to sign in again.')}>Sign out of ChatGPT</Button>
          </div>
        </div>
      ) : null}
      {!signedIn && !removing ? (
        status.pool === 'full' && !binding
          ? <p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Every shared runtime space on this server is in use.</b> You can still use an API key here, or your own MCP client through <Link className="ui-link" to="/connect-agent">Local co-work</Link>.</span></p>
          : <><h4 className="rt-sub">Before you sign in</h4><BeforeSignIn status={status} client={primary} /></>
      ) : null}
      {removing ? null : (
        <div className="aset__actions rt-actions">
          {signedIn && !authPending ? <Button variant="secondary" busy={busy === 'check'} onClick={() => void act('check', () => checkRuntime(primary), 'Couldn’t check. Try again.')}>{primary === 'codex' ? 'Check Codex sign-in' : 'Check sign-in'}</Button> : null}
          {signedIn ? <Button variant="secondary" busy={busy === 'signout'} onClick={() => void act('signout', () => signOutRuntime(primary), 'Sign-out could not be confirmed. Access remains disabled while the shared runtime space recovers; both clients may need to sign in again.')}>{primary === 'codex' ? 'Sign out of Codex' : 'Sign out'}</Button> : null}
          {binding && !confirmRemove ? <Button variant="quiet" onClick={() => setConfirmRemove(true)}>{removeLabel}</Button> : null}
        </div>
      )}
      {binding && confirmRemove && !removing ? (
        <div className="details__confirm" role="group" aria-label={removeGroupLabel}>
          <p>{removeDisclosure}</p>
          {error && errorContext?.action === 'remove' ? <p className="nset__error" aria-hidden="true"><Icon name="alert" size={14} />{error}</p> : null}
          <div className="aset__actions">
            <Button variant="danger" aria-describedby={error && errorContext?.action === 'remove' ? 'rt-error' : undefined} busy={busy === 'remove'} onClick={() => void act('remove', removeRuntime, 'Removal could not be confirmed. Check the current state before trying again.')}>Sign out and remove</Button>
            <Button variant="quiet" aria-describedby={error && errorContext?.action === 'remove' ? 'rt-error' : undefined} onClick={() => setConfirmRemove(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      <details className="rt-more"><summary>Other ways to connect</summary>{otherWays}</details>
      <WhichAccount client={primary} />
    </section>
  );
}
