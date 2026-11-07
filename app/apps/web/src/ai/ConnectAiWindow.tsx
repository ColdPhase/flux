import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { AGENT_RUNTIME_ERRORS, type AgentRuntimeClient, type AgentRuntimeSignInMethod, type AgentRuntimeStatus, type BackgroundComputeConnection } from '@flux/contracts';
import { consoleTicket } from '../agent-runtime/api';
import { SIGN_IN_PROBLEM, signInFailure } from '../agent-runtime/copy';
import type { ConsoleOutcome } from '../agent-runtime/SignInConsole';
import { ApiError } from '../api/client';
import { AddKeyForm } from '../proactive-comparison/AddKeyForm';
import { Button, Icon, MEDIA, Overlay, Sheet, Spinner, useMediaQuery } from '../ui';
import type { AiConnectionKind } from './connections';
import '../agent-runtime/runtime.css';
import './connect-ai.css';

// Connect AI is one window in steps (#854, the guide and mockup ConnectAI): choose a Claude plan, a ChatGPT plan or an API key;
// sign in on claude.ai and paste the code, or enter the device code for ChatGPT; "Couldn't connect" with Use an API key and Try
// again; an API key with its one daily budget. The person never leaves Settings. The terminal (xterm.js) loads only for a sign-in.

const SignInConsole = lazy(() => import('../agent-runtime/SignInConsole'));

const PLANS: Record<'claude_plan' | 'chatgpt_plan', { client: AgentRuntimeClient; method: AgentRuntimeSignInMethod; title: string; lead: string; cli: 'Claude Code' | 'Codex' }> = {
  claude_plan: { client: 'claude_code', method: 'claude_account', title: 'Sign in to Claude', lead: 'You sign in on claude.ai. Flux never sees your password.', cli: 'Claude Code' },
  chatgpt_plan: { client: 'codex', method: 'device_code', title: 'Sign in to ChatGPT', lead: 'Open ChatGPT, sign in and enter the code. Flux never sees your password.', cli: 'Codex' },
};
type PlanKind = keyof typeof PLANS;

const CHOICES: { kind: AiConnectionKind; title: string; detail: string; icon: 'spark' | 'chat' | 'key' }[] = [
  { kind: 'claude_plan', title: 'Claude plan', detail: 'Pro, Max or Team · sign in with Claude', icon: 'spark' },
  { kind: 'chatgpt_plan', title: 'ChatGPT plan', detail: 'Plus, Pro or Business · sign in with ChatGPT', icon: 'chat' },
  { kind: 'api_key', title: 'API key', detail: 'Anthropic, OpenAI or another provider · one daily budget', icon: 'key' },
];

type Step =
  | { kind: 'choose' }
  | { kind: 'starting'; plan: PlanKind }
  | { kind: 'sign_in'; plan: PlanKind; ticket: string }
  | { kind: 'failed'; plan: PlanKind; message: string; href?: string; action?: string }
  | { kind: 'key' };

/**
 * The window itself. `runtime`: null while it could not be read (`runtimeFailed`), so a plan is not called unavailable by
 * mistake. `have`: what the person has connected; a plan is one connection, a key can be added again.
 */
export function ConnectAiWindow({ runtime, runtimeFailed, apiKeys, have, keys, onClose, onConnected }: {
  runtime: AgentRuntimeStatus | null; runtimeFailed: boolean; apiKeys: boolean; have: ReadonlySet<AiConnectionKind>;
  keys: readonly BackgroundComputeConnection[]; onClose: () => void; onConnected: () => void;
}) {
  const phone = useMediaQuery(MEDIA.phone);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  // A sign-in that is running ends only through its own Cancel: closing the window would leave the runtime to recover.
  const close = () => { if (step.kind !== 'sign_in') onClose(); };
  // A step replaces the one before it, and the control that held focus goes with it: focus falls to <body>, where Escape reaches nothing
  // because the rest of the app is inert (#910). Whenever focus was lost, it comes back to the window, so Escape still closes it.
  const windowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) return;
    windowRef.current?.focus({ preventScroll: true });
  }, [step.kind]);

  // A plan is offered when the server has it and its place to sign in is ready: while it is not (it is starting, or the host cannot run
  // it), a sign-in could only fail with words nobody can act on (#910).
  const notReady = !!runtime?.enabled && runtime.pool === 'starting';
  const offered = (kind: AiConnectionKind) => (kind === 'api_key' ? apiKeys : !!runtime?.enabled && !notReady && runtime.clients[PLANS[kind].client] === 'available');
  const choices = CHOICES.filter((choice) => choice.kind === 'api_key' || !have.has(choice.kind));
  const [chosen, setChosen] = useState<AiConnectionKind | null>(null);
  const selected = chosen && offered(chosen) ? chosen : choices.find((choice) => offered(choice.kind))?.kind ?? null;

  async function signIn(plan: PlanKind) {
    setStep({ kind: 'starting', plan });
    try {
      const { ticket } = await consoleTicket(PLANS[plan].method, PLANS[plan].client);
      setStep({ kind: 'sign_in', plan, ticket });
    } catch (cause) {
      // The server's own words say what to do ("starting; try again shortly"); a vague failure says only that the sign-in could not be confirmed.
      const message = cause instanceof ApiError && cause.status < 500 ? cause.message
        : cause instanceof ApiError && cause.status === 503 && cause.code === AGENT_RUNTIME_ERRORS.unavailable ? `${cause.message}. If it stays like this, ask whoever runs Flux.`
          : signInFailure({ error: 'unavailable', ended: null }, PLANS[plan].cli);
      setStep({ kind: 'failed', plan, message });
    }
  }
  function ended(plan: PlanKind, outcome: ConsoleOutcome) {
    if (outcome.signedIn) { onConnected(); return; }
    const problem = outcome.problem ? SIGN_IN_PROBLEM[outcome.problem] : null;
    setStep({ kind: 'failed', plan, message: problem?.text ?? signInFailure(outcome, PLANS[plan].cli), ...(problem?.href ? { href: problem.href, action: problem.action } : {}) });
  }

  const body = (
    <div className="cai-window" ref={windowRef} tabIndex={-1}>
      {step.kind === 'choose' ? (
        <form onSubmit={(event) => { event.preventDefault(); if (selected) { if (selected === 'api_key') setStep({ kind: 'key' }); else void signIn(selected); } }}>
          <h2 className="cai-window__title">Connect your AI</h2>
          <p className="cai-window__lead">Add a connection. You can have several, and each agent uses one. Flux adds no limits of its own.</p>
          <div className="cai-window__choices" role="radiogroup" aria-label="What to connect">
            {choices.map((choice) => {
              const on = offered(choice.kind);
              return (
                <label key={choice.kind} className={`cai-window__choice${on ? '' : ' is-off'}`} data-choice={choice.kind}>
                  <input type="radio" name="connection" checked={selected === choice.kind} disabled={!on} onChange={() => setChosen(choice.kind)} />
                  <Icon name={choice.icon} size={16} />
                  <span className="cai-window__text">
                    <span className="cai-window__name">{choice.title}</span>
                    <span className="cai-window__detail">{on ? choice.detail : runtimeFailed && choice.kind !== 'api_key' ? 'Flux couldn’t check this just now'
                      : notReady && choice.kind !== 'api_key' ? 'Not ready yet. If this stays, ask whoever runs Flux.' : 'Not offered on this Flux server'}</span>
                  </span>
                </label>
              );
            })}
          </div>
          <div className="cai-window__actions">
            <Button variant="quiet" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={!selected}>Continue</Button>
          </div>
        </form>
      ) : null}

      {step.kind === 'starting' ? <>
        <h2 className="cai-window__title">{PLANS[step.plan].title}</h2>
        <p className="inbox__loading"><Spinner label="Opening the sign-in" /></p>
      </> : null}

      {step.kind === 'sign_in' ? <>
        <h2 className="cai-window__title">{PLANS[step.plan].title}</h2>
        <p className="cai-window__lead">{PLANS[step.plan].lead}</p>
        <Suspense fallback={<p className="inbox__loading"><Spinner label="Opening the sign-in" /></p>}>
          <SignInConsole ticket={step.ticket} cliName={PLANS[step.plan].cli} input={step.plan === 'chatgpt_plan' ? 'none' : 'code'} methodTitle={PLANS[step.plan].title}
            onEnd={(outcome) => ended(step.plan, outcome)} />
        </Suspense>
      </> : null}

      {step.kind === 'failed' ? <>
        <h2 className="cai-window__title">Couldn’t connect</h2>
        <p className="cai-window__lead" role="alert">{step.message}</p>
        <div className="cai-window__actions">
          {apiKeys ? <Button variant="secondary" onClick={() => setStep({ kind: 'key' })}>Use an API key</Button> : null}
          {step.href ? <a className="ui-btn ui-btn--secondary" href={step.href} target="_blank" rel="noopener noreferrer">{step.action}</a> : null}
          <Button variant="primary" onClick={() => void signIn(step.plan)}>Try again</Button>
        </div>
      </> : null}

      {step.kind === 'key' ? <>
        <h2 className="cai-window__title">Use an API key</h2>
        <div className="background-settings cai-window__key">
          <AddKeyForm connections={keys} current={keys.find((item) => item.usedForBackground) ?? null} onCancel={() => setStep({ kind: 'choose' })} onAdded={onConnected} />
        </div>
      </> : null}
    </div>
  );
  return phone
    ? <Sheet open onClose={close} label="Connect your AI" className="cai-sheet">{body}</Sheet>
    : <Overlay placement="center" open onClose={close} label="Connect your AI" className="cai-dialog">{body}</Overlay>;
}
