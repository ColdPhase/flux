import { maxRequestMicros, PERSONAL_RUN_LIMITS, personalRunMaxInputTokens, type AiPrice } from '@flux/contracts';
import { boundedInputTokens, conservativeTokenEstimate } from '../ai/estimate.js';
import { boundedUsageMicros } from '../ai/price.js';
import type {
  PersonalCompute, PersonalComputeRequest, PersonalComputeResult, PersonalToolCall, PersonalToolResult, PersonalToolSession, PersonalTurn, RunEndStatus, WebSearchFound,
} from './ports.js';
import { notePages, notesPages, pageRead, type PageRead } from './page-notes.js';
import { WebSearchRefusedError } from './ports.js';

// The bounded tool loop of a `server` run (F-027 AST-8, PROV-3 revised 2026-10-09). The loop only
// decides when another request may be sent and what each one cost; what a tool does belongs to
// the session behind `PersonalToolSession` (the worker's MCP client with the run token), so the
// switches, result caps, place checks and the change log live in one place. Every turn is one
// provider request with its own input bound and its own reconciliation: the sum of the observed
// charges is never above the run's reservation, and a request whose usage is outside its bounds
// is treated as a lost response (the most it could have cost stays counted, the answer is withheld).
// Nothing in here retries a request, and no limit falls back to another payer or connection.

/**
 * The provider's opaque fields of a replay (#954): Anthropic's search results carry the page content encrypted (`encrypted_content`,
 * `encrypted_index`), several bytes for every token the provider counts for it. They are sent back unchanged but are not counted
 * byte for byte: Anthropic's token count, which counts them as the provider does, may only raise the estimate, and no other wire
 * format replays any.
 */
const opaque = (key: string, value: unknown) => ((key === 'encrypted_content' || key === 'encrypted_index') && typeof value === 'string' ? '' : value);

/** The same request without the provider's own web search (#954). */
export function dropSearch(request: PersonalComputeRequest): PersonalComputeRequest {
  const copy = { ...request };
  delete copy.webSearch;
  return copy;
}

/** The parts of a request the input bound counts: the brief, the input, the tool definitions and every earlier turn. */
export function requestParts(request: Pick<PersonalComputeRequest, 'system' | 'input' | 'tools' | 'turns'>): string[] {
  const parts = [request.system, request.input];
  if (request.tools?.length) parts.push(JSON.stringify(request.tools));
  for (const turn of request.turns ?? []) parts.push(JSON.stringify([turn.text, turn.replay ?? turn.calls, turn.results], opaque));
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
 *
 * `webSearch`: the request was offered the provider's own web search (#954). Its searches are not limited (#1113) and are charged as
 * the response reports them, and what they brought is input the provider adds on its own, so such a request is held to the money the
 * run has left and not to a count of searches or a token bound. A request that was not offered the search made none: one that reports
 * any is out of its bounds.
 */
export function reconcileRequest(account: RunAccount, usage: { inputTokens: number; outputTokens: number; reportedCostMicros?: number | null; webSearches?: number },
  price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, reservedMicros: number, webSearch = false): boolean {
  const micros = boundedUsageMicros(price, usage, {
    maxInputTokens: webSearch ? Number.MAX_SAFE_INTEGER : personalRunMaxInputTokens(true), maxOutputTokens: PERSONAL_RUN_LIMITS.maxOutputTokens,
    maxWebSearches: webSearch ? Number.MAX_SAFE_INTEGER : 0, reservedMicros: reservedMicros - account.micros,
  });
  if (micros === null) { account.unknown = true; return false; }
  account.micros += micros;
  account.inputTokens += usage.inputTokens;
  account.outputTokens += usage.outputTokens;
  account.requests += 1;
  return true;
}

/**
 * Whether another request, at its largest possible cost in tokens, still fits what is left of the reservation (the room for search
 * results included when it is offered the search, #954). Its searches are not reserved (#1113): they are charged as the response
 * reports them, out of what is left; a request whose searches take the run above its reservation is a lost response, so the daily
 * budget is never passed, and the run is stopped here before any request that could not even carry its tokens.
 */
export function nextRequestFits(account: RunAccount, price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, reservedMicros: number, webSearch = false): boolean {
  return account.micros + maxRequestMicros(price, personalRunMaxInputTokens(true, webSearch), PERSONAL_RUN_LIMITS.maxOutputTokens) <= reservedMicros;
}

/** Why a run stopped at one of its own limits ("Limit reached"): the turn cap, the money reservation, one request's input bound or the clock. */
export type LoopLimit = 'turns' | 'money' | 'input' | 'time';

/** A standing check between turns: null to go on, otherwise the status the run ends in (`gone`: the row is no longer dispatching). */
export type Gate = (spentMicros: number) => Promise<{ status: RunEndStatus | 'gone' } | null>;

export type LoopEnd =
  /** The model's last answer: it did not ask for more tools. */
  | { kind: 'answer'; result: Extract<PersonalComputeResult, { kind: 'completed' }> }
  | { kind: 'failed'; result: Extract<PersonalComputeResult, { kind: 'failed' }> }
  /** A request's usage was outside its bounds: its cost is unknown. */
  | { kind: 'lost' }
  | { kind: 'limit'; limit: LoopLimit }
  | { kind: 'halted'; status: RunEndStatus | 'gone' };

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
  /**
   * Records what a response's web search brought (#954, C-30), awaited BEFORE any call of the same response runs: a result of the
   * search is then an address the run's `flux_read_web` may read. Throwing ends the run like a failed request (what it cost stays).
   */
  onWebSearch?: (found: WebSearchFound) => Promise<void>;
  /**
   * The provider refused its own search tool (#954: an organization whose admin turned it off, a model without it): the same request
   * is sent once more without the search, as `withoutSearch` writes it (its brief then says there is none), and every later request
   * of the run goes without it. The refused request was not billed. `onSearchRefused` lets the caller remember the key's refusal.
   */
  withoutSearch?: (request: PersonalComputeRequest) => PersonalComputeRequest;
  onSearchRefused?: () => void;
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
  const { compute, session, first, price, reservedMicros, maxTurns, deadline, now, gate, signal, onWebSearch, onSearchRefused } = options;
  const withoutSearch = options.withoutSearch ?? dropSearch;
  const account = emptyAccount();
  // Whether the provider's own search is still offered: it is not once the provider refused it, and its searches are not counted (#1113).
  let searching = first.webSearch === true;
  const offered = new Set(session.tools.map((tool) => tool.name));
  const done: PersonalTurn[] = [];
  // The pages the model read and has not yet noted (#1113): their text goes with the next requests until a step's words note it.
  const pages = new Map<PersonalToolResult, PageRead>();
  let base = first;
  let request = first;
  for (let turn = 1; ; turn += 1) {
    let result: PersonalComputeResult;
    try {
      result = await compute.dispatch(request, signal);
    } catch {
      // An unexpected adapter failure is a lost response: the most it could have cost stays counted.
      result = { kind: 'failed', reason: 'provider_error', billed: 'unknown' };
    }
    // The provider refused its own search tool, and nothing was billed: the same request once more without it, the same turn (#954).
    if (result.kind === 'failed' && result.searchRefused && searching && result.billed === 'none') {
      onSearchRefused?.();
      searching = false;
      base = withoutSearch(base);
      request = withoutSearch(request);
      turn -= 1;
      if (now() >= deadline) return { end: { kind: 'limit', limit: 'time' }, account, turns: turn };
      continue;
    }
    if (result.kind === 'failed') {
      if (result.billed !== 'none') account.unknown = true;
      return { end: { kind: 'failed', result }, account, turns: turn };
    }
    if (!reconcileRequest(account, result.usage, price, reservedMicros, searching)) return { end: { kind: 'lost' }, account, turns: turn };
    // What a search brought is recorded first: the calls of this response may read its results, and the answer lists them.
    if (result.webSearch && searching) {
      try {
        await onWebSearch?.(result.webSearch);
      } catch {
        return { end: { kind: 'failed', result: { kind: 'failed', reason: 'provider_error', billed: 'none' } }, account, turns: turn };
      }
    }
    const calls = result.stopReason === 'tool_use' ? result.toolCalls ?? [] : [];
    // The provider paused a long turn of its own search (#1116): its answer goes back as it is, with no tool to run, and the model goes on.
    // It is one more request like any other, so the same limits apply to it; a pause is never the answer.
    const paused = result.stopReason === 'pause_turn' && result.replay !== undefined;
    // A `tool_use` stop without a call (an adapter never sets it so) is the model's last answer, and so is a pause with nothing to send back.
    if (!calls.length && !paused) return { end: { kind: 'answer', result: result.stopReason === 'tool_use' || result.stopReason === 'pause_turn' ? { ...result, stopReason: 'end_turn' } : result }, account, turns: turn };

    // The model wants more turns: every limit is checked before anything it asked for is run.
    if (turn >= maxTurns) return { end: { kind: 'limit', limit: 'turns' }, account, turns: turn };
    if (!nextRequestFits(account, price, reservedMicros, searching)) return { end: { kind: 'limit', limit: 'money' }, account, turns: turn };
    if (now() >= deadline) return { end: { kind: 'limit', limit: 'time' }, account, turns: turn };
    const before = await gate(account.micros);
    if (before) return { end: { kind: 'halted', status: before.status }, account, turns: turn };

    const results: PersonalToolResult[] = [];
    for (const call of calls) {
      if (signal.aborted) return { end: { kind: 'failed', result: aborted }, account, turns: turn };
      results.push(await runCall(session, offered, call, signal));
    }
    if (signal.aborted) return { end: { kind: 'failed', result: aborted }, account, turns: turn };
    // The words of this step note the pages read before it (#1113): their text is not sent again. The pages this step read are new to
    // the model, which has not seen them yet, so their text goes with the next request.
    if (pages.size && notesPages(result.text)) notePages(done, pages);
    done.push({ text: result.text, calls, results, ...(result.replay !== undefined ? { replay: result.replay } : {}) });
    for (const [index, call] of calls.entries()) {
      const page = pageRead(call, results[index]!);
      if (page) pages.set(results[index]!, page);
    }
    request = { ...base, turns: [...done] };

    // The next request: the same standing checks, then its own input bound.
    const next = await gate(account.micros);
    if (next) return { end: { kind: 'halted', status: next.status }, account, turns: turn };
    let tokens = conservativeTokenEstimate(requestParts(request));
    let maxInput = personalRunMaxInputTokens(true, searching);
    if (tokens <= maxInput && compute.countInputTokens) {
      try {
        tokens = boundedInputTokens(tokens, await compute.countInputTokens(request));
      } catch (error) {
        // Counting is free and sends nothing to bill: a failed count ends the run without another request. A count that refused the
        // provider's own search tool (#954) is made again without it, and the run goes on without the search.
        if (!searching || !(error instanceof WebSearchRefusedError))
          return { end: { kind: 'failed', result: { kind: 'failed', reason: 'provider_error', billed: 'none' } }, account, turns: turn };
        onSearchRefused?.();
        searching = false;
        base = withoutSearch(base);
        request = withoutSearch(request);
        maxInput = personalRunMaxInputTokens(true, false);
        try {
          tokens = boundedInputTokens(conservativeTokenEstimate(requestParts(request)), await compute.countInputTokens(request));
        } catch {
          return { end: { kind: 'failed', result: { kind: 'failed', reason: 'provider_error', billed: 'none' } }, account, turns: turn };
        }
      }
    }
    if (tokens > maxInput) return { end: { kind: 'limit', limit: 'input' }, account, turns: turn };
    // The tools, the gate and the count above all took time: the clock is read again at the dispatch
    // boundary, so no request starts after the deadline. What the calls already changed stays.
    if (now() >= deadline) return { end: { kind: 'limit', limit: 'time' }, account, turns: turn };
  }
}
