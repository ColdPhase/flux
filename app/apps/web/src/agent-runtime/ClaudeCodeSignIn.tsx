import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { AgentRuntimeStatus, ClaudeCodeSignInMethod } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, ErrorState, Icon, Spinner } from '../ui';
import { consoleTicket, getRuntime, resumeConsole } from './api';
import { METHODS, PAYER } from './copy';
import { BeforeSignIn } from './RuntimeSection';
import type { ConsoleOutcome } from './SignInConsole';
import '../notifications/notifications.css';
import '../assistant/assistant.css';
import './runtime.css';

// Settings → Agents and AI → Sign in to Claude Code (F-022 "Sign-in as in a terminal", T4 #279). The
// owner picks one of the methods of Claude Code's own `claude auth login`; Flux then starts exactly that
// command in the owner's runtime and shows its terminal here. The terminal (xterm.js) loads only on
// this page.

const SignInConsole = lazy(() => import('./SignInConsole'));

type Step = { kind: 'choose' } | { kind: 'console'; method: ClaudeCodeSignInMethod; ticket: string } | { kind: 'outcome'; outcome: ConsoleOutcome; method: ClaudeCodeSignInMethod };

export function ClaudeCodeSignIn() {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [busy, setBusy] = useState<ClaudeCodeSignInMethod | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    getRuntime(controller.signal).then(async (current) => {
      setStatus(current);
      // A reload while a sign-in is pending: this session takes the same sign-in back (F-027 AST-1.5).
      if (current.auth?.claude_code) {
        const pending = await resumeConsole('claude_code').catch(() => null);
        if (pending && !controller.signal.aborted && pending.method !== 'device_code') setStep({ kind: 'console', method: pending.method as ClaudeCodeSignInMethod, ticket: pending.ticket });
      }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  async function start(method: ClaudeCodeSignInMethod) {
    setBusy(method); setError('');
    try {
      const { ticket } = await consoleTicket(method);
      setStep({ kind: 'console', method, ticket });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'The runtime could not confirm the operation. Check its current state before trying again.');
    } finally { setBusy(null); }
  }

  const back = <Link className="ui-link" to="/settings/agents">Back to Agents and AI</Link>;
  if (failed) return <div className="pane-scroll"><div className="pane-in"><ErrorState title="This page couldn’t load" actions={<Button variant="secondary" onClick={() => window.location.reload()}>Try again</Button>}><p>Nothing changed.</p></ErrorState></div></div>;
  if (!status) return <div className="pane-scroll"><div className="pane-in"><p className="inbox__loading"><Spinner label="Loading" /></p></div></div>;
  if (!status.enabled || status.clients.claude_code !== 'available') {
    return <div className="pane-scroll"><div className="pane-in nset rt-page"><p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>Claude Code in Flux isn’t offered on this Flux server.</b> The person who runs this server decides that. {back}</span></p></div></div>;
  }

  const pending = status.binding?.state === 'releasing' || Boolean(status.auth?.claude_code);
  return (
    <div className="pane-scroll">
      <div className="pane-in nset aset rt-page">
        <div className="inbox__head">
          <div>
            <h2>Sign in to Claude Code</h2>
            <p>Claude Code signs in with Anthropic exactly as it does in a terminal, inside your own runtime on this server. Flux never sees your password and doesn’t keep the code or the login.</p>
          </div>
        </div>

        {step.kind === 'choose' ? (
          <section className="nset__sec" aria-labelledby="rt-before">
            <h3 id="rt-before">Before you sign in</h3>
            <BeforeSignIn status={status} />
            <p className="nset__note">Sign-in ends when it is done, when you cancel, or after 15 minutes. A lost or cancelled operation requires safe runtime cleanup before another sign-in and may sign both clients out.</p>
            {status.binding?.recovery ? <p className="nset__problem" role="status">Runtime recovery is pending. Both clients may need to sign in again after cleanup is confirmed.</p> : status.auth?.claude_code ? <p className="nset__note" role="status">Another sign-in, check or sign-out is still in progress.</p> : null}
            {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
            <div className="aset__actions">
              <Button variant="primary" busy={busy === 'claude_account'} disabled={pending} onClick={() => void start('claude_account')}>Sign in with Claude</Button>
              {back}
            </div>
            <details className="rt-more">
              <summary>Other ways to sign in</summary>
              <ul className="sset-card rt-choices">
                {METHODS.filter((option) => option.id !== 'claude_account').map((option) => (
                  <li key={option.id}>
                    <button type="button" className="sset-row sset-row--link" disabled={pending || busy !== null} onClick={() => void start(option.id)}>
                      <span className="sset-row__b"><span className="sset-row__t">{option.title}</span><span className="sset-row__s">{option.detail} Who pays: {PAYER[option.payer]}</span></span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          </section>
        ) : null}

        {step.kind === 'console' ? (
          <Suspense fallback={<p className="inbox__loading"><Spinner label="Opening the terminal" /></p>}>
            <SignInConsole ticket={step.ticket} openLabel={step.method === 'console' ? 'Open the Anthropic Console' : 'Open claude.ai'} methodTitle={METHODS.find((option) => option.id === step.method)!.title}
              onEnd={(outcome) => { if (outcome.status) setStatus(outcome.status); setStep({ kind: 'outcome', outcome, method: step.method }); }} />
          </Suspense>
        ) : null}

        {step.kind === 'outcome' ? <Outcome outcome={step.outcome} onAgain={() => setStep({ kind: 'choose' })} back={back} /> : null}
      </div>
    </div>
  );
}

const ERRORS: Record<string, string> = {
  busy: 'Your runtime is busy with another sign-in or task. Try again in a moment.',
  unavailable: 'The runtime could not confirm the operation. Check its current state before trying again.',
  refused: 'This sign-in could not start. It may have expired or belong to another session. Start again.',
  cancelled: 'You cancelled the sign-in. Runtime access stays disabled until cleanup is confirmed; both clients may need to sign in again.',
  superseded: 'This sign-in result is no longer current and was not accepted. Check the current runtime state before starting again.',
  ended: 'The sign-in connection ended before its result was confirmed. Flux is recovering the runtime safely; both clients may need to sign in again. Check its state on Agent in Flux.',
};

function Outcome({ outcome, onAgain, back }: { outcome: ConsoleOutcome; onAgain: () => void; back: ReactNode }) {
  const connection = outcome.status?.connections.claude_code ?? null;
  if (outcome.signedIn && connection) {
    return (
      <section className="nset__sec rt-outcome" aria-labelledby="rt-done" role="status">
        <h3 id="rt-done" className="aset__state"><span className="aset__dot is-ready" aria-hidden="true" />{['Signed in', connection.plan, connection.accountLabel].filter(Boolean).join(' · ')}</h3>
        <p className="nset__lead">Claude Code reports a login{connection.accountLabel ? ` as ${connection.accountLabel}` : ''}{connection.plan ? ` (${connection.plan})` : ''}.</p>
        <p className="nset__note">Who pays: {PAYER[connection.payer ?? 'unknown']}</p>
        {connection.accountChange ? <p className="nset__problem" role="alert"><Icon name="alert" size={14} /><span><b>This is a different account than before{connection.accountChange.previousLabel ? ` (${connection.accountChange.previousLabel})` : ''}.</b> If you didn’t mean to change it, sign out on the previous page.</span></p> : null}
        <div className="aset__actions">{back}</div>
      </section>
    );
  }
  const message = outcome.error ? ERRORS[outcome.error] ?? ERRORS.ended
    : outcome.ended === 'timed_out' ? 'The sign-in ran for 15 minutes and was stopped. Claude Code did not report a login. Start again.'
      : 'Claude Code ended without reporting a login, so you are not signed in. If the code was refused, start again and paste the whole code.';
  return (
    <section className="nset__sec rt-outcome" aria-labelledby="rt-done">
      <h3 id="rt-done">{outcome.error === 'superseded' ? 'Result not accepted' : 'Not signed in'}</h3>
      <p className="nset__problem" role="alert"><Icon name="alert" size={14} /><span>{message}</span></p>
      <div className="aset__actions">
        <Button variant="primary" onClick={onAgain}>Start again</Button>
        {back}
      </div>
    </section>
  );
}
