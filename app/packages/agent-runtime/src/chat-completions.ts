import { AI_PROVIDERS, type AiProviderKind } from '@flux/contracts';
import type { PersonalTool, PersonalToolCall, PersonalTurn } from '@flux/core';
import { MalformedResponseError } from './errors.js';
import { endpointRefusal, ResponseTooLargeError, type GuardedFetch } from './guarded-fetch.js';
import { chatMessages, chatToolCalls, chatTools } from './tool-wire.js';

// The OpenAI-compatible Chat Completions wire format (F-020): OpenAI, OpenRouter, Gemini's
// OpenAI-compatible endpoint and self-hosted servers (Ollama, vLLM, LM Studio, gateways). A small
// fetch client instead of a vendor SDK: one POST per request with no retries, an explicit base URL
// (no environment variable is read, so none can redirect a key), the guarded transport, and a
// closed mapping of every outcome. Error bodies are never read into errors or logs.

/**
 * The output bound's field name. OpenAI's reasoning models accept only `max_completion_tokens`
 * (which includes reasoning tokens); the other compatible servers document `max_tokens`.
 */
const MAX_TOKENS_FIELD: Record<Exclude<AiProviderKind, 'anthropic'>, 'max_tokens' | 'max_completion_tokens'> = {
  openai: 'max_completion_tokens', openrouter: 'max_tokens', gemini: 'max_tokens', openai_compatible: 'max_tokens',
};

/** A provider answer outside 2xx (including a redirect, which is never followed). The body is not kept. */
export class ProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`The provider answered HTTP ${status}`);
    this.name = 'ProviderHttpError';
  }
}

export { MalformedResponseError };

/** Where a Chat Completions request goes: the owner's URL for a compatible endpoint, else the provider's fixed URL. */
export function chatBaseUrl(provider: AiProviderKind, connectionBaseUrl: string | null, overrides: Partial<Record<AiProviderKind, string>> = {}): string | null {
  if (AI_PROVIDERS[provider].wire !== 'openai_chat_completions') return null;
  if (provider === 'openai_compatible') return connectionBaseUrl;
  return overrides[provider] ?? AI_PROVIDERS[provider].baseUrl;
}

export interface ChatRequest {
  provider: AiProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** A JSON schema the answer must follow (the comparison's structured answer); plain text otherwise. */
  schema?: { name: string; schema: unknown };
  /** The Flux tools of a run with a tool loop (F-027 AST-8), and the earlier turns with their results. Resent on every request. */
  tools?: readonly PersonalTool[];
  turns?: readonly PersonalTurn[];
  signal: AbortSignal;
}

export type ChatStopReason = 'end_turn' | 'max_tokens' | 'refusal' | 'tool_use';

export interface ChatResult {
  text: string;
  stopReason: ChatStopReason;
  usage: { inputTokens: number; outputTokens: number; reportedCostMicros?: number };
  /** Only with `stopReason: 'tool_use'`. `replay` is the provider's assistant message, sent back unchanged with the results. */
  toolCalls?: PersonalToolCall[];
  replay?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  // Some servers return content parts; only text parts are an answer.
  if (Array.isArray(content)) return content.flatMap((part) => (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text'
    && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : [])).join('\n').trim();
  return '';
}

const tokens = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);

/** Sends one Chat Completions request and maps its answer. Throws the typed errors above. */
export async function chatCompletion(fetch: GuardedFetch, request: ChatRequest): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: chatMessages(request.system, request.user, request.turns),
    ...(request.tools?.length ? { tools: chatTools(request.tools) } : {}),
    [MAX_TOKENS_FIELD[request.provider as Exclude<AiProviderKind, 'anthropic'>] ?? 'max_tokens']: request.maxTokens,
  };
  if (request.schema) body.response_format = { type: 'json_schema', json_schema: { name: request.schema.name, strict: true, schema: request.schema.schema } };
  // OpenRouter reports each response's cost in `usage.cost` (its usage accounting).
  if (AI_PROVIDERS[request.provider].reportsCost) body.usage = { include: true };
  const response = await fetch(`${request.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', signal: request.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${request.apiKey}` },
    body: JSON.stringify(body),
  });
  if (response.status < 200 || response.status > 299) throw new ProviderHttpError(response.status);
  let parsed: { choices?: unknown; usage?: Record<string, unknown> };
  try { parsed = await response.json() as typeof parsed; } catch { throw new MalformedResponseError('not JSON'); }
  const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] as { message?: { content?: unknown; refusal?: unknown; tool_calls?: unknown }; finish_reason?: unknown } | undefined : undefined;
  const inputTokens = tokens(parsed?.usage?.prompt_tokens);
  const outputTokens = tokens(parsed?.usage?.completion_tokens);
  if (!choice || inputTokens === null || outputTokens === null) throw new MalformedResponseError('no choice or usage');
  const refused = (typeof choice.message?.refusal === 'string' && choice.message.refusal.trim() !== '') || choice.finish_reason === 'content_filter';
  const cutOff = choice.finish_reason === 'length';
  // Tool calls count only when tools were offered and the answer was neither refused nor cut off: a
  // partial call (its arguments may be cut mid-string) is never executable. Many compatible servers
  // end such an answer with `stop`, so any complete list of calls counts, not only `tool_calls`.
  const toolCalls = request.tools?.length && !refused && !cutOff ? chatToolCalls(choice.message) : [];
  const stopReason: ChatStopReason = refused ? 'refusal' : cutOff ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end_turn';
  const cost = parsed.usage?.cost;
  const reportedCostMicros = AI_PROVIDERS[request.provider].reportsCost && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
    ? Math.ceil(cost * 1_000_000) : undefined;
  return { text: refused ? '' : textOf(choice.message?.content), stopReason,
    usage: { inputTokens, outputTokens, ...(reportedCostMicros !== undefined ? { reportedCostMicros } : {}) },
    ...(stopReason === 'tool_use' ? { toolCalls, replay: choice.message } : {}) };
}

export type ChatFailureReason = 'rate_limited' | 'overloaded' | 'provider_error' | 'timeout' | 'aborted';

/**
 * The closed failure set of the wire format, with the same billing hints as the Anthropic adapter:
 * `none` only when nothing was sent (a refused endpoint); every failure after the request may have
 * reached the provider is `unknown`.
 */
export function chatFailureOf(error: unknown, signal: AbortSignal): { reason: ChatFailureReason; billed: 'none' | 'unknown' } {
  if (endpointRefusal(error)) return { reason: 'provider_error', billed: 'none' };
  if (signal.aborted) return { reason: 'aborted', billed: 'unknown' };
  if (error instanceof DOMException && error.name === 'TimeoutError') return { reason: 'timeout', billed: 'unknown' };
  if (error instanceof ProviderHttpError) {
    if (error.status === 429) return { reason: 'rate_limited', billed: 'unknown' };
    if (error.status === 503 || error.status === 529) return { reason: 'overloaded', billed: 'unknown' };
  }
  if (error instanceof ResponseTooLargeError || error instanceof MalformedResponseError) return { reason: 'provider_error', billed: 'unknown' };
  return { reason: 'provider_error', billed: 'unknown' };
}
