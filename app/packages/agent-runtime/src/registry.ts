import { AI_PROVIDERS, type AiProviderKind, type AiWireFormat } from '@flux/contracts';
import type { PersonalCompute } from '@flux/core';
import { anthropicPersonalCompute } from './anthropic.js';
import { PUBLIC_ONLY, type AiEndpointPolicy } from './endpoint-policy.js';
import type { PersonalKeyResolver } from './limits.js';
import { openAiCompatiblePersonalCompute } from './openai-compatible.js';
import { openAiResponsesPersonalCompute } from './responses.js';

// The adapter registry (F-020 PROV-2): one adapter per wire format, selected by the connection's
// provider kind. Every provider takes the same Flux path in core; this is the only place that
// chooses how a request is written on the wire.

export interface ProviderRegistryOptions {
  policy?: AiEndpointPolicy;
  /** Test only: replaces the named providers' fixed URLs with a local mock. */
  baseUrls?: Partial<Record<AiProviderKind, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export const wireOf = (provider: AiProviderKind): AiWireFormat => AI_PROVIDERS[provider].wire;

/**
 * `PersonalCompute` over the three wire formats. Only the Anthropic wire format has a token-count endpoint. `webSearch` is the
 * operator's `FLUX_WEB_READS` (#954, C-29): whether a run with tools is offered its provider's own web search, where it has one.
 */
export function providerPersonalCompute(options: ProviderRegistryOptions & { enabled: boolean; resolveKey: PersonalKeyResolver; webSearch?: boolean }): PersonalCompute {
  const { policy = PUBLIC_ONLY, baseUrls = {}, timeoutMs, maxResponseBytes, enabled, resolveKey, webSearch = false } = options;
  const adapters: Record<AiWireFormat, PersonalCompute> = {
    anthropic_messages: anthropicPersonalCompute({ enabled, resolveKey, policy, timeoutMs, maxResponseBytes,
      ...(baseUrls.anthropic ? { baseURL: baseUrls.anthropic } : {}) }),
    openai_responses: openAiResponsesPersonalCompute({ enabled, resolveKey, policy, timeoutMs, maxResponseBytes,
      ...(baseUrls.openai ? { baseUrl: baseUrls.openai } : {}) }),
    openai_chat_completions: openAiCompatiblePersonalCompute({ enabled, resolveKey, policy, baseUrls, timeoutMs, maxResponseBytes }),
  };
  return {
    enabled,
    webSearch,
    async countInputTokens(request) {
      const adapter = adapters[wireOf(request.connection.provider)];
      return adapter.countInputTokens ? adapter.countInputTokens(request) : null;
    },
    // Chat Completions answers whole (#1248): its compatible servers differ in how they stream usage and calls, so its words appear at the end.
    dispatch: (request, signal, onText) => adapters[wireOf(request.connection.provider)].dispatch(request, signal, onText),
  };
}
