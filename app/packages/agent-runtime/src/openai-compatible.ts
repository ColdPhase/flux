import type { AiProviderKind } from '@flux/contracts';
import type { PersonalCompute } from '@flux/core';
import { chatBaseUrl, chatCompletion, chatFailureOf } from './chat-completions.js';
import { PUBLIC_ONLY, type AiEndpointPolicy } from './endpoint-policy.js';
import { guardedFetch } from './guarded-fetch.js';
import { checkRequestLimits, PersonalKeyUnavailableError, type PersonalKeyResolver } from './limits.js';

// The Chat Completions adapter behind core's `PersonalCompute` port (F-020, #179): OpenAI,
// OpenRouter, Gemini's OpenAI-compatible endpoint and any OpenAI-compatible server. It matches the
// Anthropic adapter: one bounded request with the same prompt, output bound and no tools, no
// retries, abort through the AbortSignal, an explicit base URL, the guarded transport, and the same
// closed failure set and billing hints. There is no token-count endpoint on this wire format, so
// the conservative Flux estimate alone bounds the input. "Low effort" has no equivalent that every
// compatible model accepts (non-reasoning models reject `reasoning_effort`), so none is sent; the
// output bound, which includes any reasoning tokens, stays the cost bound.

export interface OpenAiCompatiblePersonalComputeOptions {
  enabled: boolean;
  resolveKey: PersonalKeyResolver;
  policy?: AiEndpointPolicy;
  /** Test only: replaces a named provider's fixed URL (the compatible kind always uses the connection's URL). */
  baseUrls?: Partial<Record<AiProviderKind, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export function openAiCompatiblePersonalCompute({ enabled, resolveKey, policy = PUBLIC_ONLY, baseUrls = {}, timeoutMs = 120_000,
  maxResponseBytes = 1_000_000 }: OpenAiCompatiblePersonalComputeOptions): PersonalCompute {
  const fetch = guardedFetch(policy, { timeoutMs, maxResponseBytes });
  return {
    enabled,
    async dispatch(request, signal) {
      checkRequestLimits(request, 'openai_chat_completions');
      try {
        const baseUrl = chatBaseUrl(request.connection.provider, request.connection.baseUrl, baseUrls);
        const apiKey = await resolveKey(request.connection.keyRef);
        if (!apiKey || !baseUrl) throw new PersonalKeyUnavailableError();
        const result = await chatCompletion(fetch, { provider: request.connection.provider, baseUrl, apiKey, model: request.model,
          system: request.system, user: request.input, maxTokens: request.maxTokens, signal });
        return { kind: 'completed', text: result.text, stopReason: result.stopReason, usage: result.usage };
      } catch (error) {
        if (error instanceof PersonalKeyUnavailableError) return { kind: 'failed', reason: 'provider_error', billed: 'none' };
        return { kind: 'failed', ...chatFailureOf(error, signal) };
      }
    },
  };
}
