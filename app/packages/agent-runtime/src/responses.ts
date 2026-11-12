import { AI_PROVIDERS } from '@flux/contracts';
import type { PersonalCompute, PersonalComputeResult } from '@flux/core';
import { chatFailureOf, MalformedResponseError, ProviderHttpError } from './chat-completions.js';
import { openAiSearchRefusal, SearchRefusedError } from './errors.js';
import { PUBLIC_ONLY, type AiEndpointPolicy } from './endpoint-policy.js';
import { guardedFetch, type GuardedFetch } from './guarded-fetch.js';
import { checkRequestLimits, PersonalKeyUnavailableError, type PersonalKeyResolver } from './limits.js';
import { responsesInput, responsesReplay, responsesText, responsesToolCalls, responsesTools, responsesWebSearch } from './tool-wire.js';

// OpenAI's Responses API behind core's `PersonalCompute` port (#954). Flux speaks it to OpenAI because OpenAI's own web search is a
// Responses tool (and GPT-6 Astra and GPT-6.1 Sol call tools only there); OpenRouter, Gemini's compatible endpoint and self-hosted
// servers stay on Chat Completions. It matches the other adapters: one POST per request with no retries, an explicit base URL (no
// environment variable is read), the guarded transport, the Flux system prompt as `instructions`, the output bound as
// `max_output_tokens`, and the same closed outcomes and billing hints as Chat Completions. Nothing is stored at OpenAI (`store: false`):
// a run's earlier turns travel in every request as the model's words and its function calls (`responsesReplay`); reasoning is not
// carried between turns, and no encrypted reasoning is asked for (non-reasoning models refuse it; the review of #1073).
// No effort is sent (non-reasoning models reject it); the output bound, which includes reasoning tokens, stays the cost bound.
// Request and response shapes were read from developers.openai.com (function calling and web search guides, 2026-11-08, undated).

/**
 * OpenAI's own web search (#954, C-29), on its cached index only (`external_web_access: false`): no live page request leaves on the
 * agent's word except through Flux's `flux_read_web`, whose addresses C-30 bounds. No `max_tool_calls`: the calls of a request are not
 * limited (founder direction 2026-11-09, #1113), and each is charged as counted.
 */
export const OPENAI_WEB_SEARCH_TOOL = { type: 'web_search', external_web_access: false } as const;

export interface ResponsesRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  tools?: Parameters<typeof responsesTools>[0];
  turns?: Parameters<typeof responsesInput>[1];
  webSearch?: boolean;
  signal: AbortSignal;
  /** The answer's words as they are written (#1248): the request is streamed, and its final response read as a whole one. */
  onText?: (delta: string) => void;
}

const tokens = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Sends one Responses request and maps its answer to a completed result. Throws the typed errors of Chat Completions. */
export async function openAiResponse(fetch: GuardedFetch, request: ResponsesRequest): Promise<Extract<PersonalComputeResult, { kind: 'completed' }>> {
  const tools = request.tools?.length ? request.tools : null;
  const search = !!tools && request.webSearch === true;
  const body: Record<string, unknown> = {
    model: request.model,
    instructions: request.system,
    input: responsesInput(request.user, request.turns),
    max_output_tokens: request.maxTokens,
    store: false,
    ...(tools ? { tools: [...responsesTools(tools), ...(search ? [OPENAI_WEB_SEARCH_TOOL] : [])] } : {}),
    // Every address a search returned, so a cited one is listed (C-30).
    ...(search ? { include: ['web_search_call.action.sources'] } : {}),
    ...(request.onText ? { stream: true } : {}),
  };
  // The trailing slashes of the base go without a regular expression (no backtracking on a long run of them).
  let base = request.baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const response = await fetch(`${base}/responses`, {
    method: 'POST', signal: request.signal,
    headers: { 'content-type': 'application/json', accept: request.onText ? 'text/event-stream' : 'application/json', authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify(body),
  });
  // A model or project that has no web search refuses the request that offers it (#954): recognised from the error's words, which are
  // read into this one decision and kept nowhere, and sent again by the tool loop without the search.
  if (response.status === 400 && search && openAiSearchRefusal(await response.text().catch(() => ''))) throw new SearchRefusedError();
  if (response.status < 200 || response.status > 299) throw new ProviderHttpError(response.status);
  let parsed: { status?: unknown; incomplete_details?: { reason?: unknown } | null; output?: unknown; usage?: Record<string, unknown> };
  if (/^text\/event-stream\b/i.test(response.headers.get('content-type') ?? '')) parsed = await streamedResponse(response, request.onText) as typeof parsed;
  else try { parsed = await response.json() as typeof parsed; } catch { throw new MalformedResponseError('not JSON'); }
  const inputTokens = tokens(parsed?.usage?.input_tokens);
  const outputTokens = tokens(parsed?.usage?.output_tokens);
  if (!Array.isArray(parsed?.output) || inputTokens === null || outputTokens === null) throw new MalformedResponseError('no output or usage');
  if (parsed.status !== 'completed' && parsed.status !== 'incomplete') throw new MalformedResponseError('a response that did not complete');
  const output = parsed.output as unknown[];
  const reason = parsed.status === 'incomplete' ? parsed.incomplete_details?.reason : null;
  const { text, refused: refusedPart } = responsesText(output);
  const refused = refusedPart || reason === 'content_filter';
  const cutOff = reason === 'max_output_tokens';
  // A call counts only when tools were offered and the answer was neither refused nor cut off: a partial call is never executable.
  const toolCalls = tools && !refused && !cutOff ? responsesToolCalls(output) : [];
  const stopReason = refused ? 'refusal' : cutOff ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end_turn';
  // Every search call is counted, offered or not (one that was not offered makes the usage out of its bounds); what it found is
  // read only when the run was offered the search.
  const searched = responsesWebSearch(output);
  return {
    kind: 'completed', text: refused ? '' : text, stopReason,
    usage: { inputTokens, outputTokens, ...(searched.calls ? { webSearches: searched.calls } : {}) },
    ...(stopReason === 'tool_use' ? { toolCalls, replay: responsesReplay(output) } : {}),
    ...(search && searched.found ? { webSearch: searched.found } : {}),
  };
}

/**
 * A streamed response (#1248): each `response.output_text.delta` is handed to `onText` as it arrives, and the answer is the response the
 * last event carries (`response.completed` or `response.incomplete`), the same object a whole answer is. A `response.failed` or `error`
 * event, or a stream that ends without its response, is an answer that cannot be read.
 */
async function streamedResponse(response: Response, onText: ((delta: string) => void) | undefined): Promise<unknown> {
  if (!response.body) throw new MalformedResponseError('no stream');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let final: unknown = null;
  const event = (block: string) => {
    const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let value: { type?: unknown; delta?: unknown; response?: unknown };
    try { value = JSON.parse(data) as typeof value; } catch { throw new MalformedResponseError('not JSON'); }
    if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') { try { onText?.(value.delta); } catch { /* the view only */ } return; }
    if (value.type === 'response.completed' || value.type === 'response.incomplete') { final = value.response; return; }
    if (value.type === 'response.failed' || value.type === 'error') throw new MalformedResponseError('a response that did not complete');
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // Events end at a blank line, written with `\n` or `\r\n`; a line end may be split across two chunks, so the split is made on what is joined.
    pending += value;
    for (let blank = /\r?\n\r?\n/.exec(pending); blank; blank = /\r?\n\r?\n/.exec(pending)) {
      event(pending.slice(0, blank.index));
      pending = pending.slice(blank.index + blank[0].length);
    }
  }
  if (pending.trim()) event(pending);
  if (!final) throw new MalformedResponseError('a stream without its response');
  return final;
}

export interface OpenAiResponsesPersonalComputeOptions {
  enabled: boolean;
  resolveKey: PersonalKeyResolver;
  policy?: AiEndpointPolicy;
  /** Test only: replaces OpenAI's fixed URL with a local mock. */
  baseUrl?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export function openAiResponsesPersonalCompute({ enabled, resolveKey, policy = PUBLIC_ONLY, baseUrl = AI_PROVIDERS.openai.baseUrl!, timeoutMs = 120_000,
  maxResponseBytes = 1_000_000 }: OpenAiResponsesPersonalComputeOptions): PersonalCompute {
  const fetch = guardedFetch(policy, { timeoutMs, maxResponseBytes });
  return {
    enabled,
    async dispatch(request, signal, onText) {
      checkRequestLimits(request, 'openai_responses');
      try {
        const apiKey = await resolveKey(request.connection.keyRef);
        if (!apiKey) throw new PersonalKeyUnavailableError();
        return await openAiResponse(fetch, { baseUrl, apiKey, model: request.model, system: request.system, user: request.input,
          maxTokens: request.maxTokens, tools: request.tools, turns: request.turns, webSearch: request.webSearch === true, signal, ...(onText ? { onText } : {}) });
      } catch (error) {
        if (error instanceof PersonalKeyUnavailableError) return { kind: 'failed', reason: 'provider_error', billed: 'none' };
        if (error instanceof SearchRefusedError) return { kind: 'failed', reason: 'provider_error', billed: 'none', searchRefused: true };
        return { kind: 'failed', ...chatFailureOf(error, signal) };
      }
    },
  };
}
