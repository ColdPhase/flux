export interface AgentRuntime {
  run(input: { prompt: string; actorId: string }): Promise<{ text: string }>;
}

export { anthropicPersonalCompute, failureOf, PersonalKeyUnavailableError, type AnthropicPersonalComputeOptions, type PersonalKeyResolver } from './anthropic.js';
export { openAiCompatiblePersonalCompute, type OpenAiCompatiblePersonalComputeOptions } from './openai-compatible.js';
export { anthropicComparisonProvider, openAiCompatibleComparisonProvider } from './comparison.js';
export { providerComparison, providerPersonalCompute, wireOf, type ProviderRegistryOptions } from './registry.js';
export { chatBaseUrl, chatCompletion, chatFailureOf, MalformedResponseError, ProviderHttpError } from './chat-completions.js';
export { aiEndpointPolicyFromEnv, checkEndpoint, classifyAddress, EndpointRefusedError, guardedLookup, literalRefusal, parsePrivateTargets,
  PRIVATE_TARGETS_ENV, PUBLIC_ONLY, systemResolver, type AiEndpointPolicy, type Resolver } from './endpoint-policy.js';
export { DEFAULT_TRANSPORT_LIMITS, endpointRefusal, guardedFetch, ResponseTooLargeError, type GuardedFetch, type TransportLimits } from './guarded-fetch.js';
export { endpointPolicyPort, listProviderModels, type ModelListOptions } from './model-list.js';
export { checkRequestLimits } from './limits.js';
