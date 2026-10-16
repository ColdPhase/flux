import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { AgentRuntimeStatus, CodexSignInMethod } from '@flux/contracts';
import { ApiError } from '../api/client';
import { Button, ErrorState, Icon, Spinner } from '../ui';
import { consoleTicket, getRuntime } from './api';
import { CODEX_METHODS, PAYER, SIGN_IN_PROBLEM } from './copy';
import { BeforeSignIn } from './RuntimeSection';
import type { ConsoleOutcome } from './SignInConsole';
import '../notifications/notifications.css';
import '../assistant/assistant.css';
import './runtime.css';

// Settings → Agents and AI → Sign in with ChatGPT (F-022 T6 #281; F-027 AST-1 card A12). Flux runs Codex's
// own `codex login --device-auth` in the owner's runtime: the card shows the one-time code large with
// "Copy and open ChatGPT", and Flux reads completion from `codex login status`; nothing is pasted back.
// An OpenAI API key or an access token are under "Other ways to sign in", each read by Codex itself.

const SignInConsole = lazy(() => import('./SignInConsole'));

type Step = { kind: 'choose' } | { kind: 'console'; method: CodexSignInMethod; ticket: string } | { kind: 'outcome'; outcome: ConsoleOutcome };

export function CodexSignIn() {
  const [status, setStatus] = useState<AgentRuntimeStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [busy, setBusy] = useState<CodexSignInMethod | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    getRuntime(controller.signal).then(setStatus).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);

  async function start(method: CodexSignInMethod) {
    setBusy(method); setError('');
    try {
      const { ticket } = await consoleTicket(method, 'codex');
      setStep({ kind: 'console', method, ticket });
    } catch (cause) {
      setError(cause instanceof ApiError && cause.status < 500 ? cause.message : 'The runtime could not confirm the operation. Check its current state before trying again.');
    } finally { setBusy(null); }
  }

  const back = <Link className="ui-link" to="/settings/agents">Back to Agents and AI</Link>;
  if (failed) return <div className="pane-scroll"><div className="pane-in"><ErrorState title="This page couldn’t load" actions={<Button variant="secondary" onClick={() => window.location.reload()}>Try again</Button>}><p>Nothing changed.</p></ErrorState></div></div>;
  if (!status) return <div className="pane-scroll"><div className="pane-in"><p className="inbox__loading"><Spinner label="Loading" /></p></div></div>;
  if (!status.enabled || status.clients.codex !== 'available') {
    return <div className="pane-scroll"><div className="pane-in nset rt-page"><p className="nset__problem" role="note"><Icon name="alert" size={14} /><span><b>This Flux doesn’t allow signing in with a subscription yet.</b> The person who runs this server decides that. {back}</span></p></div></div>;
  }
  const pending = Boolean(status.auth?.codex) || status.binding?.state === 'releasing';
  const [device, ...others] = CODEX_METHODS;

  return (
    <div className="pane-scroll">
      <div className="pane-in nset aset rt-page">
        <div className="inbox__head">
          <div>
            <h2>Sign in to ChatGPT</h2>
            <p>Codex signs in with OpenAI exactly as it does in a terminal, inside your own runtime on this server. Flux never sees your password and doesn’t keep the code or the login.</p>
          </div>
        </div>

        {step.kind === 'choose' ? (
          <section className="nset__sec" aria-labelledby="rt-before">
            <h3 id="rt-before">Before you sign in</h3>
            <BeforeSignIn status={status} client="codex" />
            {status.binding?.recovery ? <p className="nset__problem" role="status">Runtime recovery is pending. Both clients may need to sign in again after cleanup.</p> : status.auth?.codex ? <p className="nset__note" role="status">Another sign-in, check or sign-out is still in progress.</p> : null}
            {error ? <p className="nset__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
            <div className="aset__actions">
              <Button variant="primary" busy={busy === device!.id} disabled={pending} onClick={() => void start(device!.id)}>Get a code</Button>
              {back}
            </div>
            <details className="rt-more">
              <summary>Other ways to sign in</summary>
              <ul className="sset-card rt-choices">
                {others.map((option) => (
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
          <Suspense fallback={<p className="inbox__loading"><Spinner label="Opening the sign-in" /></p>}>
            <SignInConsole ticket={step.ticket} cliName="Codex" input={step.method === 'device_code' ? 'none' : 'key'}
              methodTitle={step.method === 'device_code' ? 'Sign in to ChatGPT' : CODEX_METHODS.find((option) => option.id === step.method)!.title}
              onEnd={(outcome) => { if (outcome.status) setStatus(outcome.status); setStep({ kind: 'outcome', outcome }); }} />
          </Suspense>
        ) : null}

        {step.kind === 'outcome' ? <Outcome outcome={step.outcome} onAgain={() => void start('device_code')} onChoose={() => setStep({ kind: 'choose' })} back={back} /> : null}
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
  ended: 'The sign-in connection ended before its result was confirmed. Flux is recovering the runtime safely; both clients may need to sign in again.',
};

function Outcome({ outcome, onAgain, onChoose, back }: { outcome: ConsoleOutcome; onAgain: () => void; onChoose: () => void; back: ReactNode }) {
  const connection = outcome.status?.connections.codex ?? null;
  if (outcome.signedIn && connection) {
    return (
      <section className="nset__sec rt-outcome" aria-labelledby="rt-done" role="status">
        <h3 id="rt-done" className="aset__state"><span className="aset__dot is-ready" aria-hidden="true" />Signed in</h3>
        <p className="nset__lead">Codex reports a login{connection.accountLabel ? ` as ${connection.accountLabel}` : ''}{connection.plan ? ` (${connection.plan})` : ''}.</p>
        <p className="nset__note">Who pays: {PAYER[connection.payer ?? 'unknown']}</p>
        <div className="aset__actions">{back}</div>
      </section>
    );
  }
  // Journey 6: the two ChatGPT sign-in rows, each with its one next step.
  if (outcome.problem) {
    const row = SIGN_IN_PROBLEM[outcome.problem];
    return (
      <section className="nset__sec rt-outcome" aria-labelledby="rt-done">
        <h3 id="rt-done">Not signed in</h3>
        <p className="nset__problem" role="alert"><Icon name="alert" size={14} /><span>{row.text}</span></p>
        <div className="aset__actions">
          {outcome.problem === 'device_auth_disabled'
            ? <a className="ui-btn ui-btn--primary" href={row.href} target="_blank" rel="noopener noreferrer">{row.action}</a>
            : <Button variant="primary" onClick={onAgain}>{row.action}</Button>}
          {back}
        </div>
      </section>
    );
  }
  const message = outcome.error ? ERRORS[outcome.error] ?? ERRORS.ended
    : outcome.ended === 'timed_out' ? 'The sign-in ran for 15 minutes and was stopped. Codex did not report a login. Start again.'
      : 'Codex ended without reporting a login, so you are not signed in. Start again.';
  return (
    <section className="nset__sec rt-outcome" aria-labelledby="rt-done">
      <h3 id="rt-done">{outcome.error === 'superseded' ? 'Result not accepted' : 'Not signed in'}</h3>
      <p className="nset__problem" role="alert"><Icon name="alert" size={14} /><span>{message}</span></p>
      <div className="aset__actions">
        <Button variant="primary" onClick={onChoose}>Start again</Button>
        {back}
      </div>
    </section>
  );
}
