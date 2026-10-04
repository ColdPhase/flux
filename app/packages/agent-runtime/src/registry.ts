import { AI_PROVIDERS, type AiProviderKind, type AiWireFormat } from '@flux/contracts';
import type { ComparisonProvider, PersonalCompute } from '@flux/core';
import { anthropicPersonalCompute } from './anthropic.js';
import { anthropicComparisonProvider, openAiCompatibleComparisonProvider } from './comparison.js';
import { PUBLIC_ONLY, type AiEndpointPolicy } from './endpoint-policy.js';
import type { PersonalKeyResolver } from './limits.js';
import { openAiCompatiblePersonalCompute } from './openai-compatible.js';

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

/** `PersonalCompute` over both wire formats. Only the Anthropic wire format has a token-count endpoint. */
export function providerPersonalCompute(options: ProviderRegistryOptions & { enabled: boolean; resolveKey: PersonalKeyResolver }): PersonalCompute {
  const { policy = PUBLIC_ONLY, baseUrls = {}, timeoutMs, maxResponseBytes, enabled, resolveKey } = options;
  const adapters: Record<AiWireFormat, PersonalCompute> = {
    anthropic_messages: anthropicPersonalCompute({ enabled, resolveKey, policy, timeoutMs, maxResponseBytes,
      ...(baseUrls.anthropic ? { baseURL: baseUrls.anthropic } : {}) }),
    openai_chat_completions: openAiCompatiblePersonalCompute({ enabled, resolveKey, policy, baseUrls, timeoutMs, maxResponseBytes }),
  };
  return {
    enabled,
    async countInputTokens(request) {
      const adapter = adapters[wireOf(request.connection.provider)];
      return adapter.countInputTokens ? adapter.countInputTokens(request) : null;
    },
    dispatch: (request, signal) => adapters[wireOf(request.connection.provider)].dispatch(request, signal),
  };
}

/** `ComparisonProvider` over both wire formats, selected by the request's provider kind. */
export function providerComparison(options: ProviderRegistryOptions = {}): ComparisonProvider {
  const { policy = PUBLIC_ONLY, baseUrls = {}, timeoutMs, maxResponseBytes } = options;
  const adapters: Record<AiWireFormat, ComparisonProvider> = {
    anthropic_messages: anthropicComparisonProvider({ policy, timeoutMs, maxResponseBytes, ...(baseUrls.anthropic ? { baseUrl: baseUrls.anthropic } : {}) }),
    openai_chat_completions: openAiCompatibleComparisonProvider({ policy, baseUrls, timeoutMs, maxResponseBytes }),
  };
  return {
    async countInputTokens(input) {
      const adapter = adapters[wireOf(input.provider)];
      return adapter.countInputTokens ? adapter.countInputTokens(input) : null;
    },
    createMessage: (input) => adapters[wireOf(input.provider)].createMessage(input),
  };
}
