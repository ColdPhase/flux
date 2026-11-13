import { assistantModelName, type AgentRuntimePayer, type AssistantRun, type AssistantRunStatus, type PersonalAssistantStatus } from '@flux/contracts';
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

/** What a run recorded, in the words of the list: "Sonnet", or the plan's default for a run before the choice existed. */
export const runModelName = (model: string) => (model === 'claude-code' || model === 'codex' ? "your plan's default" : assistantModelName(model));

export const WORKING: readonly AssistantRunStatus[] = ['queued', 'reading', 'dispatching'];
export const isWorking = (run: AssistantRun) => WORKING.includes(run.status);
/** A run on the owner's own Claude Code (F-022 AIM-3); older answers and stubs have no engine. */
export const onRuntime = (run: Pick<AssistantRun, 'engine'>) => run.engine === 'runtime';

/** The name of one of the person's connections (#854): "Claude plan", "ChatGPT plan" or "API key". */
export const connectionName = (connection: string) => (connection === 'claude_plan' ? 'Claude plan' : connection === 'chatgpt_plan' ? 'ChatGPT plan' : 'API key');

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
/** "14:00": the reset time of a plan limit in the reader's clock. */
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
/** "at 14:00" today, otherwise "tomorrow at 0:00" or the day: when a paused request starts again. */
export function resumeWords(iso: string) {
  const at = new Date(iso);
  const now = new Date();
  if (at.toDateString() === now.toDateString()) return `at ${clock(iso)}`;
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  return at.toDateString() === tomorrow.toDateString() ? `tomorrow at ${clock(iso)}` : at.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}
/** #854: "Claude limit reached, resumes at 14:00", or without a time when the plan gave none. */
export const planLimitLine = (plan: string, resetsAt: string | null | undefined) =>
  resetsAt ? `${plan} limit reached, resumes ${resumeWords(resetsAt)}` : `${plan} limit reached`;
/** A request that ended at the plan's limit and will not start again by itself: it may have changed things (#854). */
const planEndedLine = (plan: string, resetsAt: string | null | undefined) =>
  resetsAt ? `${plan} limit reached until ${resumeWords(resetsAt).replace(/^at /, '')}.` : `${plan} limit reached.`;
/** The line of a request paused by its connection's limit, waiting to start again by itself (#854). */
export function pausedLine(run: Pick<AssistantRun, 'endReason' | 'resumesAt' | 'planLimitResetsAt' | 'runtimeClient'>): string | null {
  if (!run.resumesAt) return null;
  if (run.endReason === 'budget') return `Not enough left of your API key’s daily budget, resumes ${resumeWords(run.resumesAt)}`;
  // Without a time from the plan the line has none: Flux tries again later, and that is not the plan's reset.
  return planLimitLine(runtimeNames(run.runtimeClient ?? 'claude_code').plan, run.planLimitResetsAt);
}

/** The owner's working line while a run is in flight. */
export function workingText(run: AssistantRun) {
  if (run.stopRequested) return 'Stopping… nothing will be posted.';
  // #860: the server runs as many agents as fit in its memory; the others wait for room.
  if (run.endReason === 'no_room') return 'Waiting for room on the server';
  // A request paused by its connection's limit says when it starts again (#854); there is no button to switch.
  const paused = pausedLine(run);
  if (paused) return paused;
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
    // #854: one calm line; the request waits and starts again by itself when the plan resets. Nothing switches to another connection.
    case 'plan_limit': return planEndedLine(plan, run.planLimitResetsAt);
    case 'sign_in_again': return `Sign in to ${plan} again to keep using your assistant.`;
    case 'refused': return `${plan} refused this request. Nothing was changed.`;
    case 'model_unavailable': return `Your ${plan} plan didn’t accept ${runModelName(run.model)}. Nothing was changed.`;
    case 'no_event': case 'crashed': return `${plan} isn’t answering right now. Nothing was changed.`;
    case 'unknown': return `${plan} stopped answering partway. Nothing was changed, and it won’t run again by itself.`;
    case 'wall_clock': return 'I stopped after an hour without finishing. Nothing was posted.';
    case 'max_turns': return 'I stopped after very many steps without finishing. Nothing was posted.';
    case 'answer_too_large': return 'Limit reached: the answer was too long to post. Nothing was posted.';
    case 'local_tool': return `Stopped: ${cli} offered tools Flux doesn’t allow. Nothing was posted.`;
    case 'slot_busy': return `Your ${cli} was busy (signing in or checking). Nothing was posted. Try again in a moment.`;
    default: return null;
  }
}

/**
 * Why a run ended without an answer. It says that nothing was posted, unless the run changed things before it ended: then the same line
 * says how many changes were made, and the run's message below lists them with Undo (AST-6 "No silent edits").
 */
export function endedText(run: AssistantRun, changed = 0): string | null {
  const words = endedWords(run);
  if (!words || changed <= 0) return words;
  const made = `${changed === 1 ? '1 change was' : `${changed} changes were`} made before it ended.`;
  return /Nothing was (?:posted|changed|sent)\.?$/.test(words) ? words.replace(/\s*Nothing was (?:posted|changed|sent)\.?$/, ` ${made}`) : `${words} ${made}`;
}

function endedWords(run: AssistantRun): string | null {
  // AG-10: turning AI off in the space stops a run at once, and its owner is told in the thread where they asked.
  if (run.endReason === 'ai_off') return 'AI was turned off in this space, so your assistant stopped.';
  if (run.endReason === 'mcp_results_too_large') return 'This needed more reading than one request can carry. Nothing was posted.';
  if (run.endReason === 'budget') return 'Not enough left of your API key’s daily budget. Nothing more was sent today.';
  if (run.endReason === 'credits') return 'API credits used up. API requests stop until your next monthly credits arrive.';
  if (onRuntime(run)) {
    const words = runtimeEndedText(run);
    if (words) return words;
  }
  switch (run.status) {
    case 'stopped': return 'Stopped. Nothing was posted.';
    case 'denied': return 'Your assistant can no longer read or post in this project. Nothing was posted.';
    case 'paused': return 'Your assistant was paused before it answered. Nothing was posted.';
    case 'revoked': return 'Your assistant was turned off before it answered. Nothing was posted.';
    case 'cap_reached': return 'I stopped before finishing. Nothing was posted.';
    case 'unavailable': return 'Your assistant is unavailable right now. Nothing was posted.';
    case 'input_too_large': return 'This conversation is too long for one request. Nothing was sent.';
    case 'provider_failed': return 'The AI provider didn’t answer. Nothing was posted.';
    default: return null;
  }
}

export const canRetry = (run: AssistantRun) => run.endReason !== 'ai_off' && (run.status === 'provider_failed' || run.status === 'stopped')
  || (onRuntime(run) && (run.endReason === 'slot_busy' || run.endReason === 'wall_clock' || run.endReason === 'max_turns' || run.endReason === 'plan_limit'));

export type AskState =
  | { kind: 'ready'; note: string }
  | { kind: 'blocked'; note: string; action: 'connect' | 'settings' | 'tell' | 'join' | null; actionLabel?: string;
      /** A second way out (Journey 6: "Connect an API key"). */
      also?: { action: 'key'; label: string } };

/**
 * What ask mode says under "Your assistant", from the caller's own status. `outside` is a company owner or admin who can open this
 * space without being in it: their assistant works only where they are (C-15), so nothing else matters until they add themselves.
 * A guest has no AI (AG-2): there is nothing to connect or ask, so no action, whatever the status says (#1034).
 */
export function askState(status: PersonalAssistantStatus | null, outside = false, guest = false): AskState {
  if (guest) return { kind: 'blocked', note: 'Guests don’t have AI.', action: null };
  if (outside) return { kind: 'blocked', note: 'Your assistant works only in spaces you’re in.', action: 'join', actionLabel: 'Add me' };
  if (!status) return { kind: 'blocked', note: 'Checking your assistant…', action: null };
  const runtime = status.enablement?.engine === 'runtime';
  switch (status.state) {
    case 'ready': return { kind: 'ready', note: `Only you see the answer, until you choose Show everyone · on ${runtime ? runtimePayerText(status.setup.runtime?.payer, status.setup.runtime?.client) : 'your API key'}` };
    case 'not_enabled': return { kind: 'blocked', note: 'You haven’t set up your assistant. Nobody else’s can be used for you.', action: 'connect', actionLabel: 'Connect your AI' };
    // #854: the API key's one daily budget; a request asked now waits for the key's next day.
    case 'capped': return { kind: 'ready', note: `Not enough left of your API key’s ${dollars(status.today?.budgetCents ?? 0)} daily budget. A request now starts ${status.today ? resumeWords(status.today.resetsAt) : 'tomorrow'}.` };
    default:
      // Journey 6: this Flux does not allow subscription sign-in. Tell whoever runs it, or use a key of your own.
      if (status.unavailableReason === 'runtime_off') return { kind: 'blocked', note: unavailableText(status), action: 'tell', actionLabel: 'Tell whoever runs Flux', also: { action: 'key', label: 'Connect an API key' } };
      return { kind: 'blocked', note: unavailableText(status), action: 'settings', actionLabel: 'Assistant settings' };
  }
}

export function unavailableText(status: PersonalAssistantStatus) {
  switch (status.unavailableReason) {
    case 'runtime_sign_in': return `Sign in to ${runtimeNames(status.setup.runtime?.client).plan} again to keep using your assistant.`;
    case 'runtime_off': return 'This Flux doesn’t allow signing in with a subscription yet.';
    case 'provider_off': return 'In-app AI is turned off on this Flux server, so nothing is sent.';
    case 'connection_changed': return 'The connection your assistant’s model belonged to was removed. Choose a model of another connection to go on.';
    case 'price_unknown': return 'Your API key’s model has no known price, so its daily budget can’t hold and nothing is sent.';
    case 'model_retired': return 'Your assistant’s model is no longer offered by its provider. Choose another model to go on.';
    default: return 'Your AI key isn’t connected, so nothing is sent.';
  }
}

/** A refused ask or retry in words, with no internal codes. */
export function askError(error: unknown): string {
  if (error instanceof NetworkError) return 'Flux can’t be reached. Your question is still here; try again.';
  if (!(error instanceof ApiError)) return 'Your assistant couldn’t start. Try again.';
  switch (error.code) {
    case 'PERSONAL_RUN_NOT_ENABLED': return 'You haven’t set up your assistant.';
    case 'PERSONAL_RUN_UNAVAILABLE': return 'Your assistant is unavailable right now. Nothing was sent.';
    case 'PERSONAL_RUN_NO_AGENT': return 'Your agent isn’t available. Check it in Settings › AI.';
    case 'PERSONAL_RUN_NO_PROJECT_ACCESS': return 'Your assistant can’t read this project yet.';
    case 'PERSONAL_RUN_IN_FLIGHT': return 'Your assistant is already working on many requests. Try again when one is done.';
    default: return error.status === 403 ? 'You no longer have access to this space, so you can’t ask here.' : error.status === 404 ? 'This conversation is no longer available to you.' : 'Your assistant couldn’t start. Try again.';
  }
}

/** One status line for in-app AI this server does not run (Spokój E04 ③, #763 SG-2). */
export const SERVER_AI_OFF_LINE = 'Off on this Flux server · ask your admin to turn it on';
