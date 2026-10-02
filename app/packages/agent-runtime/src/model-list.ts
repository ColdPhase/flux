import { AI_PRICE_MAX_MICROS_PER_MTOK, AI_PROVIDERS, type AiListedModel, type AiModelList, type AiProviderKind } from '@flux/contracts';
import { validModelId, type AiEndpointPolicyPort, type AiPriceListing } from '@flux/core';
import { chatBaseUrl } from './chat-completions.js';
import { checkEndpoint, PUBLIC_ONLY, type AiEndpointPolicy, type Resolver, systemResolver } from './endpoint-policy.js';
import { endpointRefusal, guardedFetch } from './guarded-fetch.js';

// A provider's model list, read by the server without a key (F-020 PROV-1): OpenRouter lists its
// models and their prices publicly, and an OpenAI-compatible server usually answers `GET /models`
// without one. The other named providers list models only with a key, which only the worker may
// use, so the owner types the model id. The same guarded transport bounds every listing.

export interface ModelListOptions {
  policy?: AiEndpointPolicy;
  /** Test only: replaces a named provider's fixed URL. */
  baseUrls?: Partial<Record<AiProviderKind, string>>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolve?: Resolver;
  now?: () => Date;
}

const MAX_MODELS = 1_000;

/** OpenRouter states prices as USD per token in decimal strings; "-1" marks a variable price. */
function perMillion(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d+(\.\d+)?(e-?\d+)?$/i.test(value.trim()) ? Number(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(number) || number < 0) return null;
  const micros = Math.round(number * 1e12);
  return micros <= AI_PRICE_MAX_MICROS_PER_MTOK ? micros : null;
}

export async function listProviderModels(provider: AiProviderKind, baseUrl: string | null, options: ModelListOptions = {}): Promise<AiModelList> {
  const { policy = PUBLIC_ONLY, baseUrls = {}, timeoutMs = 8_000, maxResponseBytes = 4_000_000, resolve = systemResolver } = options;
  const checkedOn = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const result = (status: AiModelList['status'], models: AiListedModel[] = []): AiModelList => ({ provider, status, models, checkedOn });
  if (!AI_PROVIDERS[provider].keylessModelList) return result('needs_key');
  const url = chatBaseUrl(provider, baseUrl, baseUrls);
  if (!url) return result('refused');
  if (provider === 'openai_compatible' && await checkEndpoint(url, policy, resolve)) return result('refused');
  try {
    const response = await guardedFetch(policy, { timeoutMs, maxResponseBytes }, resolve)(`${url.replace(/\/+$/, '')}/models`,
      { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return result('unavailable');
    const body = await response.json() as { data?: unknown };
    if (!body || !Array.isArray(body.data)) return result('unavailable');
    const models = new Map<string, AiListedModel>();
    for (const item of body.data.slice(0, MAX_MODELS * 2)) {
      const id = (item as { id?: unknown })?.id;
      if (!validModelId(provider, id) || models.has(id)) continue;
      const pricing = (item as { pricing?: { prompt?: unknown; completion?: unknown } }).pricing;
      const input = provider === 'openrouter' ? perMillion(pricing?.prompt) : null;
      const output = provider === 'openrouter' ? perMillion(pricing?.completion) : null;
      models.set(id, { id, price: input !== null && output !== null ? { inputMicrosPerMTok: input, outputMicrosPerMTok: output } : null });
      if (models.size >= MAX_MODELS) break;
    }
    return result('listed', [...models.values()].sort((a, b) => a.id.localeCompare(b.id)));
  } catch (error) {
    return result(endpointRefusal(error) ? 'refused' : 'unavailable');
  }
}

/** Core's price listing over the provider's own keyless listing: OpenRouter reports per-model prices. */
export function keylessPriceListing(options: ModelListOptions = {}): AiPriceListing {
  return {
    async listedPrice(provider, model, baseUrl) {
      if (!AI_PROVIDERS[provider].reportsCost) return null;
      const list = await listProviderModels(provider, baseUrl, options).catch(() => null);
      return list?.models.find((entry) => entry.id === model)?.price ?? null;
    },
  };
}

/** Core's endpoint policy port over the guard: the save-time half of the check (PROV-4). */
export function endpointPolicyPort(policy: AiEndpointPolicy, resolve: Resolver = systemResolver): AiEndpointPolicyPort {
  return { check: (baseUrl) => checkEndpoint(baseUrl, policy, resolve) };
}
