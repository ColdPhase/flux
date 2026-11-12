import { createHash } from 'node:crypto';
import { aiEndpointPolicyFromEnv, endpointPolicyPort, keyListingOptions, listKeyModels, listProviderModels, listsWithKey, type AiEndpointPolicy } from '@flux/agent-runtime';
import type { AiModelList, AiProviderKind } from '@flux/contracts';
import type { BackgroundConnectionProviders } from '@flux/core';

// What the API composes for owner AI connections (F-020, #179): the operator's endpoint policy
// (`FLUX_AI_PRIVATE_TARGETS`; public HTTPS only when empty), the save-time endpoint check, and the
// providers' model listings, shown to the owner only. OpenRouter and an OpenAI-compatible endpoint are listed without a key. The
// API sends a key only while it is being added (CA-2, CA-4, #1218): to list the models that key can use, which is also its test,
// before the key is sealed. A stored key is only ever opened by the worker.

export interface AiConnectionServerComposition {
  policy: AiEndpointPolicy;
  providers: BackgroundConnectionProviders;
  /** With `apiKey`, Anthropic, OpenAI and Gemini list the models of that key; without one they answer `needs_key`. */
  listModels(provider: AiProviderKind, baseUrl: string | null, apiKey?: string): Promise<AiModelList>;
}

/** How long a key's list is kept: typing the key and then pressing Connect reads it once (#1218). */
export const KEY_LIST_TTL_MS = 6 * 3600_000;
const KEY_LIST_ENTRIES = 200;

/**
 * Remembers a key's list for 6 hours, by a digest of the provider and key (the key itself is not kept), so the key's test while
 * it is typed and its save are one call to the provider. Only a list the provider gave is kept: a refusal or a failure is asked again.
 * Concurrent asks for the same key share one request.
 */
export function cachedKeyListing(list: (provider: AiProviderKind, apiKey: string) => Promise<AiModelList>, now: () => number = Date.now) {
  const kept = new Map<string, { at: number; value: Promise<AiModelList> }>();
  return (provider: AiProviderKind, apiKey: string): Promise<AiModelList> => {
    const id = createHash('sha256').update(`${provider}\0${apiKey}`).digest('hex');
    const hit = kept.get(id);
    if (hit && now() - hit.at < KEY_LIST_TTL_MS) return hit.value;
    const value = list(provider, apiKey);
    kept.delete(id);
    kept.set(id, { at: now(), value });
    while (kept.size > KEY_LIST_ENTRIES) kept.delete(kept.keys().next().value!);
    void value.then((result) => { if (result.status !== 'listed' && kept.get(id)?.value === value) kept.delete(id); },
      () => { if (kept.get(id)?.value === value) kept.delete(id); });
    return value;
  };
}

export function aiConnectionServerComposition(env: NodeJS.ProcessEnv): AiConnectionServerComposition {
  const policy = aiEndpointPolicyFromEnv(env);
  const keyed = keyListingOptions(env, policy);
  const keyModels = cachedKeyListing((provider, apiKey) => listKeyModels(provider, apiKey, keyed));
  return {
    policy,
    providers: { endpoints: endpointPolicyPort(policy), keyModels: (provider, apiKey) => listsWithKey(provider) ? keyModels(provider, apiKey) : Promise.resolve({ provider, status: 'needs_key', models: [], checkedOn: new Date().toISOString().slice(0, 10) }) },
    listModels: (provider, baseUrl, apiKey) => (listsWithKey(provider)
      ? (apiKey ? keyModels(provider, apiKey) : listProviderModels(provider, baseUrl, { policy }))
      : listProviderModels(provider, baseUrl, { policy })),
  };
}
