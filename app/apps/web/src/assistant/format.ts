import type { AssistantRun, AssistantRunStatus, PersonalAssistantStatus } from '@flux/contracts';
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

/** The owner's working line while a run is in flight. */
export function workingText(run: AssistantRun) {
  if (run.stopRequested) return 'Stopping… nothing will be posted.';
  switch (run.status) {
    case 'queued': return 'Your assistant is getting ready…';
    case 'reading': return 'Your assistant is reading this conversation…';
    default: return 'Your assistant is thinking…';
  }
}

/** Why a run ended without an answer. Always says that nothing was posted. */
export function endedText(run: AssistantRun): string | null {
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

export const canRetry = (run: AssistantRun) => run.status === 'provider_failed' || run.status === 'stopped';

export type AskState =
  | { kind: 'ready'; note: string }
  | { kind: 'blocked'; note: string; action: 'connect' | 'resume' | 'settings' | null; actionLabel?: string };

/** What ask mode says under "Your assistant", from the caller's own status. */
export function askState(status: PersonalAssistantStatus | null, audience: string): AskState {
  if (!status) return { kind: 'blocked', note: 'Checking your assistant…', action: null };
  const cap = status.enablement ? dollars(status.enablement.perRunCents) : '';
  switch (status.state) {
    case 'ready': return { kind: 'ready', note: `Answer shown to ${audience} · paid by you, up to ${cap}` };
    case 'not_enabled': return { kind: 'blocked', note: 'You haven’t set up your assistant. Nobody else’s can be used for you.', action: 'connect', actionLabel: 'Connect your AI' };
    case 'paused': return { kind: 'blocked', note: 'Your assistant is paused.', action: 'resume', actionLabel: 'Resume' };
    case 'capped': return { kind: 'blocked', note: `Stopped at today’s ${dollars(status.today?.capCents ?? 0)} cap. It won’t use another payer.`, action: 'settings', actionLabel: 'Raise cap' };
    default: return { kind: 'blocked', note: unavailableText(status), action: 'settings', actionLabel: 'Assistant settings' };
  }
}

export function unavailableText(status: PersonalAssistantStatus) {
  switch (status.unavailableReason) {
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
