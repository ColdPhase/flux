import { aiEndpointPolicyFromEnv, endpointPolicyPort, keylessPriceListing, listProviderModels, type AiEndpointPolicy } from '@flux/agent-runtime';
import type { AiModelList, AiProviderKind } from '@flux/contracts';
import type { BackgroundConnectionProviders } from '@flux/core';

// What the API composes for owner AI connections (F-020, #179): the operator's endpoint policy
// (`FLUX_AI_PRIVATE_TARGETS`; public HTTPS only when empty), the save-time endpoint check, and the
// providers' keyless model listings. The API never calls a provider with a key: only the worker
// decrypts keys, and a listing is fetched without one.

export interface AiConnectionServerComposition {
  policy: AiEndpointPolicy;
  providers: BackgroundConnectionProviders;
  listModels(provider: AiProviderKind, baseUrl: string | null): Promise<AiModelList>;
}

export function aiConnectionServerComposition(env: NodeJS.ProcessEnv): AiConnectionServerComposition {
  const policy = aiEndpointPolicyFromEnv(env);
  return {
    policy,
    providers: { endpoints: endpointPolicyPort(policy), listing: keylessPriceListing({ policy }) },
    listModels: (provider, baseUrl) => listProviderModels(provider, baseUrl, { policy }),
  };
}
