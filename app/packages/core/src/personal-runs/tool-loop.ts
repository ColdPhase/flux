import { maxRequestMicros, PERSONAL_RUN_LIMITS, type AiPrice } from '@flux/contracts';
import { boundedInputTokens, conservativeTokenEstimate } from '../ai/estimate.js';
import { boundedUsageMicros } from '../ai/price.js';
import type {
  PersonalCompute, PersonalComputeRequest, PersonalComputeResult, PersonalToolCall, PersonalToolResult, PersonalToolSession, PersonalTurn, RunRecord,
} from './ports.js';

// The bounded tool loop of a `server` run (F-027 AST-8, PROV-3 revised 2026-10-09). The loop only
// decides when another request may be sent and what each one cost; what a tool does belongs to
// the session behind `PersonalToolSession` (the worker's MCP client with the run token), so the
// switches, result caps, place checks and the change log live in one place. Every turn is one
// provider request with its own input bound and its own reconciliation: the sum of the observed
// charges is never above the run's reservation, and a request whose usage is outside its bounds
// is treated as a lost response (the whole reservation stays counted, the answer is withheld).
// Nothing in here retries a request, and no limit falls back to another payer or connection.

/** The parts of a request the input bound counts: the brief, the input, the tool definitions and every earlier turn. */
export function requestParts(request: Pick<PersonalComputeRequest, 'system' | 'input' | 'tools' | 'turns'>): string[] {
  const parts = [request.system, request.input];
  if (request.tools?.length) parts.push(JSON.stringify(request.tools));
  for (const turn of request.turns ?? []) parts.push(JSON.stringify([turn.text, turn.replay ?? turn.calls, turn.results]));
  return parts;
}

/** What a run with a tool loop has spent so far, request by request (PROV-3 applied per request). */
export interface RunAccount {
  /** Reconciled micro-dollars of the requests whose usage was within its bounds. */
  micros: number;
  inputTokens: number;
  outputTokens: number;
  /** Requests whose usage was observed. */
  requests: number;
  /** A request was sent whose cost cannot be known: lost, out of its bounds or failed after it may have been billed. */
  unknown: boolean;
}

export const emptyAccount = (): RunAccount => ({ micros: 0, inputTokens: 0, outputTokens: 0, requests: 0, unknown: false });

/**
 * Reconciles one completed request against what is left of the run's reservation. False when the
 * reported usage is outside the request's token limits or would take the run above its
 * reservation: that request is a lost response and the account is `unknown`.
 */
export function reconcileRequest(account: RunAccount, usage: { inputTokens: number; outputTokens: number; reportedCostMicros?: number | null },
  price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, reservedMicros: number): boolean {
  const micros = boundedUsageMicros(price, usage, {
    maxInputTokens: PERSONAL_RUN_LIMITS.maxToolInputTokens, maxOutputTokens: PERSONAL_RUN_LIMITS.maxOutputTokens, reservedMicros: reservedMicros - account.micros,
  });
  if (micros === null) { account.unknown = true; return false; }
  account.micros += micros;
  account.inputTokens += usage.inputTokens;
  account.outputTokens += usage.outputTokens;
  account.requests += 1;
  return true;
}

/** Whether another request, at its largest possible cost, still fits what is left of the reservation. */
export function nextRequestFits(account: RunAccount, price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, reservedMicros: number): boolean {
  return account.micros + maxRequestMicros(price, PERSONAL_RUN_LIMITS.maxToolInputTokens, PERSONAL_RUN_LIMITS.maxOutputTokens) <= reservedMicros;
}

/** Why a run stopped at one of its own limits ("Limit reached"): the turn cap, the money reservation, one request's input bound or the clock. */
export type LoopLimit = 'turns' | 'money' | 'input' | 'time';

/** A standing check between turns: null to go on, otherwise the status the run ends in (`gone`: the row is no longer dispatching). */
export type Gate = () => Promise<{ status: RunRecord['status'] | 'gone' } | null>;

export type LoopEnd =
  /** The model's last answer: it did not ask for more tools. */
  | { kind: 'answer'; result: Extract<PersonalComputeResult, { kind: 'completed' }> }
  | { kind: 'failed'; result: Extract<PersonalComputeResult, { kind: 'failed' }> }
  /** A request's usage was outside its bounds: its cost is unknown. */
  | { kind: 'lost' }
  | { kind: 'limit'; limit: LoopLimit }
  | { kind: 'halted'; status: RunRecord['status'] | 'gone' };

export interface LoopResult { end: LoopEnd; account: RunAccount; turns: number }

export interface LoopOptions {
  compute: PersonalCompute;
  session: PersonalToolSession;
  /** The fitted first request, with the tools. */
  first: PersonalComputeRequest;
  price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>;
  /** The run's reservation: the most it may cost. */
  reservedMicros: number;
  maxTurns: number;
  /** Epoch milliseconds after which no further request starts. */
  deadline: number;
  now: () => number;
  gate: Gate;
  signal: AbortSignal;
}

const aborted: Extract<PersonalComputeResult, { kind: 'failed' }> = { kind: 'failed', reason: 'aborted', billed: 'none' };

async function runCall(session: PersonalToolSession, offered: ReadonlySet<string>, call: PersonalToolCall, signal: AbortSignal): Promise<PersonalToolResult> {
  // A call the provider could not state as a JSON object, or outside the offered tools, is never sent.
  if (call.invalid) return { callId: call.id, content: 'The arguments were not a JSON object. Nothing was run.', isError: true };
  if (!offered.has(call.name)) return { callId: call.id, content: `There is no tool named ${call.name}. Nothing was run.`, isError: true };
  try {
    const result = await session.call(call, signal);
    return { callId: call.id, content: typeof result.content === 'string' ? result.content : '', isError: result.isError === true };
  } catch {
    // Whether the call changed anything is not known here; the change log of the route is the record.
    return { callId: call.id, content: 'The call failed.', isError: true };
  }
}

/**
 * Sends the first request and, while the model asks for tools, runs them and sends the next turn:
 * at most `maxTurns` requests; before each further request the standing gate, the money reservation
 * (the largest possible next request must still fit), the clock and the per-request input bound are
 * checked, and a limit ends the run without sending it. The clock is read once more after the calls,
 * the gate and the input count, at the dispatch boundary. Calls already made stay made.
 */
export async function runToolLoop(options: LoopOptions): Promise<LoopResult> {
  const { compute, session, first, price, reservedMicros, maxTurns, deadline, now, gate, signal } = options;
  const account = emptyAccount();
  const offered = new Set(session.tools.map((tool) => tool.name));
  const done: PersonalTurn[] = [];
  let request = first;
  for (let turn = 1; ; turn += 1) {
    let result: PersonalComputeResult;
    try {
      result = await compute.dispatch(request, signal);
    } catch {
      // An unexpected adapter failure is a lost response: the reservation stays counted.
      result = { kind: 'failed', reason: 'provider_error', billed: 'unknown' };
    }
    if (result.kind === 'failed') {
      if (result.billed !== 'none') account.unknown = true;
      return { end: { kind: 'failed', result }, account, turns: turn };
    }
    if (!reconcileRequest(account, result.usage, price, reservedMicros)) return { end: { kind: 'lost' }, account, turns: turn };
    const calls = result.stopReason === 'tool_use' ? result.toolCalls ?? [] : [];
    // A `tool_use` stop without a call (an adapter never sets it so) is the model's last answer.
    if (!calls.length) return { end: { kind: 'answer', result: result.stopReason === 'tool_use' ? { ...result, stopReason: 'end_turn' } : result }, account, turns: turn };

    // The model wants more turns: every limit is checked before anything it asked for is run.
    if (turn >= maxTurns) return { end: { kind: 'limit', limit: 'turns' }, account, turns: turn };
    if (!nextRequestFits(account, price, reservedMicros)) return { end: { kind: 'limit', limit: 'money' }, account, turns: turn };
    if (now() >= deadline) return { end: { kind: 'limit', limit: 'time' }, account, turns: turn };
    const before = await gate();
    if (before) return { end: { kind: 'halted', status: before.status }, account, turns: turn };

    const results: PersonalToolResult[] = [];
    for (const call of calls) {
      if (signal.aborted) return { end: { kind: 'failed', result: aborted }, account, turns: turn };
      results.push(await runCall(session, offered, call, signal));
    }
    if (signal.aborted) return { end: { kind: 'failed', result: aborted }, account, turns: turn };
    done.push({ text: result.text, calls, results, ...(result.replay !== undefined ? { replay: result.replay } : {}) });
    request = { ...first, turns: [...done] };

    // The next request: the same standing checks, then its own input bound.
    const next = await gate();
    if (next) return { end: { kind: 'halted', status: next.status }, account, turns: turn };
    let tokens = conservativeTokenEstimate(requestParts(request));
    if (tokens <= PERSONAL_RUN_LIMITS.maxToolInputTokens && compute.countInputTokens) {
      try {
        tokens = boundedInputTokens(tokens, await compute.countInputTokens(request));
      } catch {
        // Counting is free and sends nothing to bill: a failed count ends the run without another request.
        return { end: { kind: 'failed', result: { kind: 'failed', reason: 'provider_error', billed: 'none' } }, account, turns: turn };
      }
    }
    if (tokens > PERSONAL_RUN_LIMITS.maxToolInputTokens) return { end: { kind: 'limit', limit: 'input' }, account, turns: turn };
    // The tools, the gate and the count above all took time: the clock is read again at the dispatch
    // boundary, so no request starts after the deadline. What the calls already changed stays.
    if (now() >= deadline) return { end: { kind: 'limit', limit: 'time' }, account, turns: turn };
  }
}
