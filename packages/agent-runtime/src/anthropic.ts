import Anthropic from '@anthropic-ai/sdk';
import { PERSONAL_RUN_LIMITS } from '@flux/contracts';
import type { PersonalCompute, PersonalComputeRequest, PersonalComputeResult } from '@flux/core';

// The Anthropic adapter behind core's `PersonalCompute` port (#68, O-008 §3–§4). One run is one
// Messages API request on the pinned model with `max_tokens` 1500, low effort and no tools; the
// preflight uses the token-counting endpoint. The SDK's automatic retries are off, a stop aborts
// the HTTP request through the AbortSignal, and every failure maps to the port's closed set of
// reasons with a billing hint. The key is resolved from the connection's opaque `keyRef` only
// for the request at hand and is never logged, returned or kept.

/** Turns a connection's `keyRef` into its key, or null when it cannot be used (#124 custody). */
export type PersonalKeyResolver = (keyRef: string) => Promise<string | null>;

export interface AnthropicPersonalComputeOptions {
  /** The instance operator's provider switch (O-008 §6). */
  enabled: boolean;
  resolveKey: PersonalKeyResolver;
  /** Defaults to the public API. Set explicitly so an `ANTHROPIC_BASE_URL` in the environment never redirects keys. */
  baseURL?: string;
  /** Per request; timeouts are not retried. */
  timeoutMs?: number;
}

const PUBLIC_API = 'https://api.anthropic.com';

/** The key could not be resolved: nothing was sent. */
export class PersonalKeyUnavailableError extends Error {
  constructor() {
    super('The personal connection has no usable key');
    this.name = 'PersonalKeyUnavailableError';
  }
}

/** Refuses anything outside the O-008 request limits before a key is even resolved. */
function checkLimits(request: PersonalComputeRequest) {
  if (request.model !== PERSONAL_RUN_LIMITS.model) throw new Error(`Only the pinned model ${PERSONAL_RUN_LIMITS.model} may be used`);
  if (request.maxTokens > PERSONAL_RUN_LIMITS.maxOutputTokens || request.maxTokens < 1) throw new Error('max_tokens exceeds the O-008 limit');
  if (request.effort !== PERSONAL_RUN_LIMITS.effort) throw new Error('Only low effort is allowed');
}

type StopReason = Extract<PersonalComputeResult, { kind: 'completed' }>['stopReason'];

function stopReason(value: Anthropic.StopReason | null): StopReason {
  switch (value) {
    // The context window ends the output early as the output limit does: shown as truncated.
    case 'max_tokens': case 'model_context_window_exceeded': return 'max_tokens';
    case 'stop_sequence': return 'stop_sequence';
    case 'refusal': return 'refusal';
    // No tools are offered, so `tool_use` and `pause_turn` cannot continue anything; the text so far is the answer.
    default: return 'end_turn';
  }
}

/**
 * The failure of one dispatch. `billed: 'none'` only when nothing was sent: no usable key (and
 * the O-008 limits, which throw before a key is resolved). Once a request has reached the
 * provider, no published guarantee says a rejected one is free (checked 2026-09-30: the error
 * and pricing references define 429/529/4xx but promise no billing outcome), so every
 * post-entry failure — 4xx, 429, 529, 5xx, timeouts, lost connections and aborts — is
 * `unknown` and the reservation stays counted against the owner's cap (O-008 §3).
 */
export function failureOf(error: unknown, signal: AbortSignal): Extract<PersonalComputeResult, { kind: 'failed' }> {
  if (error instanceof PersonalKeyUnavailableError) return { kind: 'failed', reason: 'provider_error', billed: 'none' };
  if (error instanceof Anthropic.APIUserAbortError || signal.aborted) return { kind: 'failed', reason: 'aborted', billed: 'unknown' };
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { kind: 'failed', reason: 'timeout', billed: 'unknown' };
  if (error instanceof Anthropic.APIConnectionError) return { kind: 'failed', reason: 'provider_error', billed: 'unknown' };
  if (error instanceof Anthropic.RateLimitError) return { kind: 'failed', reason: 'rate_limited', billed: 'unknown' };
  if (error instanceof Anthropic.APIError && error.status === 529) return { kind: 'failed', reason: 'overloaded', billed: 'unknown' };
  return { kind: 'failed', reason: 'provider_error', billed: 'unknown' };
}

export function anthropicPersonalCompute({ enabled, resolveKey, baseURL = PUBLIC_API, timeoutMs = 120_000 }: AnthropicPersonalComputeOptions): PersonalCompute {
  async function client(keyRef: string) {
    const apiKey = await resolveKey(keyRef);
    if (!apiKey) throw new PersonalKeyUnavailableError();
    // One client per request: each run uses its owner's own key. Retries are off (O-008 §4).
    return new Anthropic({ apiKey, authToken: null, baseURL, maxRetries: 0, timeout: timeoutMs });
  }

  return {
    enabled,

    async countInputTokens(request) {
      checkLimits(request);
      const api = await client(request.connection.keyRef);
      const counted = await api.messages.countTokens({
        model: request.model, system: request.system, messages: [{ role: 'user', content: request.input }],
      });
      return counted.input_tokens;
    },

    async dispatch(request, signal) {
      checkLimits(request);
      try {
        const api = await client(request.connection.keyRef);
        const message = await api.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.input }],
          output_config: { effort: request.effort },
        }, { signal });
        const text = message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim();
        // No caching is requested, so these should be zero. If a workspace default caches anyway, they
        // are counted conservatively in base-input equivalents: a read as full input (priced 0.1x) and a
        // 5-minute write at 1.25x (pricing page, checked 2026-09-30).
        const usage = message.usage;
        const inputTokens = usage.input_tokens + Math.ceil((usage.cache_creation_input_tokens ?? 0) * 1.25) + (usage.cache_read_input_tokens ?? 0);
        return { kind: 'completed', text, stopReason: stopReason(message.stop_reason), usage: { inputTokens, outputTokens: usage.output_tokens } };
      } catch (error) {
        return failureOf(error, signal);
      }
    },
  };
}
