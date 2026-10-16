import type { AgentRuntimePayer, AssistantRun, AssistantRunStatus, PersonalAssistantStatus } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';

// Words of the personal assistant (#57 design, #68). Calm and exact: they say what happened, who
// pays and that human work goes on. They never promise what the server did not do.

export function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function micros(value: number) {
  return `$${(value / 1_000_000).toFixed(value > 0 && value < 10_000 ? 3 : 2)}`;
}

/** A price per 1M tokens in micro-dollars, with the precision small prices need ($0.075). */
export function perMillion(value: number) {
  return `$${(value / 1_000_000).toFixed(value % 10_000 === 0 ? 2 : 4)}`;
}

export const WORKING: readonly AssistantRunStatus[] = ['queued', 'reading', 'dispatching'];
export const isWorking = (run: AssistantRun) => WORKING.includes(run.status);
/** A run on the owner's own Claude Code (F-022 AIM-3); older answers and stubs have no engine. */
export const onRuntime = (run: Pick<AssistantRun, 'engine'>) => run.engine === 'runtime';

/** The vendor names of the owner's CLI (F-022 T6 #281): Claude and Claude Code, or ChatGPT and Codex. */
export type RuntimeClientName = 'claude_code' | 'codex' | null | undefined;
export const runtimeNames = (client: RuntimeClientName) => (client === 'codex'
  ? { cli: 'Codex', plan: 'ChatGPT', account: 'your ChatGPT or OpenAI account' } : { cli: 'Claude Code', plan: 'Claude', account: 'your Claude account' });
/** A run's CLI, from the vendor its consent named. */
export const runClient = (run: Pick<AssistantRun, 'runtimeClient'>): RuntimeClientName => run.runtimeClient ?? 'claude_code';

/** The payer of a runtime assistant in plain words, from the CLI's reported method (F-022 "Payer and data"). */
export function runtimePayerText(payer: AgentRuntimePayer | null | undefined, client?: RuntimeClientName) {
  switch (payer) {
    case 'claude_plan': return 'your Claude plan';
    case 'anthropic_console': return 'your Anthropic Console organization';
    case 'chatgpt_plan': return 'your ChatGPT plan';
    case 'openai_api': return 'your OpenAI API organization';
    default: return runtimeNames(client).account;
  }
}
/** The longer payer line: never zero, never a number Flux cannot see. */
export function runtimePayerDetail(payer: AgentRuntimePayer | null | undefined, client?: RuntimeClientName) {
  switch (payer) {
    case 'anthropic_console': return 'your Anthropic Console organization (API billing, cost not reported to Flux)';
    case 'claude_plan': return 'your Claude plan (plan limits or paid extra usage, not visible to Flux)';
    case 'chatgpt_plan': return 'your ChatGPT plan (plan limits or credits, not visible to Flux)';
    case 'openai_api': return 'your OpenAI API organization (API billing, cost not reported to Flux)';
    default: return `${runtimeNames(client).account} (usage not visible to Flux)`;
  }
}

/** "14:00": the reset time of a plan limit in the reader's clock. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** The owner's working line while a run is in flight. */
export function workingText(run: AssistantRun) {
  if (run.stopRequested) return 'Stopping… nothing will be posted.';
  // F-027 AST-10: one plain word while the owner's own Claude Code works.
  if (onRuntime(run)) return 'Working…';
  switch (run.status) {
    case 'queued': return 'Your assistant is getting ready…';
    case 'reading': return 'Your assistant is reading this conversation…';
    default: return 'Your assistant is thinking…';
  }
}

/**
 * Why a run on the owner's own Claude Code ended without an answer (F-027 AST-10 Journey 6, F-022 T5: each
 * end has its own words). Read-only runs change nothing, so each line says so.
 */
function runtimeEndedText(run: AssistantRun): string | null {
  const { cli, plan } = runtimeNames(runClient(run));
  switch (run.endReason) {
    case 'plan_limit': return run.planLimitResetsAt ? `Paused: your ${plan} plan’s limit is reached until ${clock(run.planLimitResetsAt)}.`
      : `Paused: your ${plan} plan’s limit is reached. ${plan} didn’t say until when.`;
    case 'sign_in_again': return `Sign in to ${plan} again to keep using your assistant.`;
    case 'refused': return `${plan} refused this request. Nothing was changed.`;
    case 'no_event': case 'crashed': return `${plan} isn’t answering right now. Nothing was changed.`;
    case 'unknown': return `${plan} stopped answering partway. Nothing was changed, and it won’t run again by itself.`;
    case 'wall_clock': return 'I stopped after 5 minutes, the limit for one request. Nothing was posted.';
    case 'max_turns': return 'I stopped at the most steps for one request. Nothing was posted.';
    case 'answer_too_large': return 'Limit reached: the answer was too long to post. Nothing was posted.';
    case 'local_tool': return `Stopped: ${cli} offered tools Flux doesn’t allow. Nothing was posted.`;
    case 'slot_busy': return `Your ${cli} was busy (signing in or checking). Nothing was posted. Try again in a moment.`;
    default: return null;
  }
}

/** Why a run ended without an answer. Always says that nothing was posted. */
export function endedText(run: AssistantRun): string | null {
  if (run.endReason === 'mcp_results_too_large') return 'Limit reached: this needed more reading than one request allows. Nothing was posted.';
  if (onRuntime(run)) {
    const words = runtimeEndedText(run);
    if (words) return words;
    if (run.status === 'cap_reached') return 'That’s your daily limit of requests. Nothing was posted.';
  }
  switch (run.status) {
    case 'stopped': return 'Stopped. Nothing was posted.';
    case 'denied': return 'Your assistant can no longer read or post in this project. Nothing was posted.';
    case 'paused': return 'Your assistant was paused before it answered. Nothing was posted.';
    case 'revoked': return 'Your assistant was turned off before it answered. Nothing was posted.';
    case 'cap_reached': return 'Stopped at today’s cap. It won’t use another payer. Nothing was posted.';
    case 'unavailable': return 'Your assistant is unavailable right now. Nothing was posted.';
    case 'input_too_large': return 'This conversation is too long for one request. Nothing was sent.';
    case 'provider_failed': return 'The AI provider didn’t answer. Nothing was posted.';
    default: return null;
  }
}

export const canRetry = (run: AssistantRun) => run.status === 'provider_failed' || run.status === 'stopped'
  || (onRuntime(run) && (run.endReason === 'slot_busy' || run.endReason === 'wall_clock' || run.endReason === 'max_turns'));

export type AskState =
  | { kind: 'ready'; note: string }
  | { kind: 'blocked'; note: string; action: 'connect' | 'resume' | 'settings' | null; actionLabel?: string };

/** What ask mode says under "Your assistant", from the caller's own status. */
export function askState(status: PersonalAssistantStatus | null, audience: string): AskState {
  if (!status) return { kind: 'blocked', note: 'Checking your assistant…', action: null };
  const cap = status.enablement ? dollars(status.enablement.perRunCents) : '';
  const runtime = status.enablement?.engine === 'runtime';
  switch (status.state) {
    case 'ready': return { kind: 'ready', note: runtime ? `Answer shown to ${audience} · on ${runtimePayerText(status.setup.runtime?.payer, status.setup.runtime?.client)}` : `Answer shown to ${audience} · paid by you, up to ${cap}` };
    case 'not_enabled': return { kind: 'blocked', note: 'You haven’t set up your assistant. Nobody else’s can be used for you.', action: 'connect', actionLabel: 'Connect your AI' };
    case 'paused': return { kind: 'blocked', note: 'Your assistant is paused.', action: 'resume', actionLabel: 'Resume' };
    case 'capped': return runtime ? { kind: 'blocked', note: 'That’s 20 requests today, your daily limit. It won’t use another account.', action: 'settings', actionLabel: 'Assistant settings' }
      : { kind: 'blocked', note: `Stopped at today’s ${dollars(status.today?.capCents ?? 0)} cap. It won’t use another payer.`, action: 'settings', actionLabel: 'Raise cap' };
    default: return { kind: 'blocked', note: unavailableText(status), action: 'settings', actionLabel: 'Assistant settings' };
  }
}

export function unavailableText(status: PersonalAssistantStatus) {
  switch (status.unavailableReason) {
    case 'runtime_sign_in': return `Sign in to ${runtimeNames(status.setup.runtime?.client).plan} again to keep using your assistant.`;
    case 'runtime_off': return 'This Flux doesn’t allow signing in with a subscription yet.';
    case 'provider_off': return 'In-app AI is turned off on this Flux server, so nothing is sent.';
    case 'connection_changed': return 'The AI connection your assistant used was removed. Another one needs its own consent: remove your assistant, then turn it on with that connection.';
    case 'price_unknown': return 'Your AI connection has no known price, so nothing is sent.';
    case 'run_cost_over_limit': return 'One request to your model can cost more than your per-request limit, so nothing is sent. Raise the limit or choose a cheaper model.';
    default: return 'Your AI key isn’t connected, so nothing is sent.';
  }
}

/** The one-line state of the owner's assistant, for settings and Details. */
export function stateLine(status: PersonalAssistantStatus) {
  switch (status.state) {
    case 'ready': return 'Ready · only you can use it';
    case 'paused': return 'Paused · nothing runs';
    case 'capped': return 'Stopped at today’s cap';
    case 'unavailable': return `Unavailable · ${unavailableText(status)}`;
    default: return 'Not set up';
  }
}

/** A refused ask or retry in words, with no internal codes. */
export function askError(error: unknown): string {
  if (error instanceof NetworkError) return 'Flux can’t be reached. Your question is still here; try again.';
  if (!(error instanceof ApiError)) return 'Your assistant couldn’t start. Try again.';
  switch (error.code) {
    case 'PERSONAL_RUN_NOT_ENABLED': return 'You haven’t set up your assistant.';
    case 'PERSONAL_RUN_PAUSED': return 'Your assistant is paused.';
    case 'PERSONAL_RUN_UNAVAILABLE': return 'Your assistant is unavailable right now. Nothing was sent.';
    case 'PERSONAL_RUN_NO_AGENT': return 'Choose your assistant for this workspace in assistant settings first.';
    case 'PERSONAL_RUN_NO_PROJECT_ACCESS': return 'Your assistant can’t read this project yet.';
    case 'PERSONAL_RUN_IN_FLIGHT': return 'Your assistant is already working on a request.';
    case 'PERSONAL_RUN_CAPPED': return 'Stopped at today’s cap. It won’t use another payer.';
    default: return error.status === 403 ? 'You can read this project, but cannot ask here.' : error.status === 404 ? 'This conversation is no longer available to you.' : 'Your assistant couldn’t start. Try again.';
  }
}
