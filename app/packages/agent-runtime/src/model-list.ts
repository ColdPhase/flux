import { AI_PRICE_MAX_MICROS_PER_MTOK, AI_PROVIDERS, aiModelFamily, compareModelsNewestFirst, type AiListedModel, type AiModelList, type AiProviderKind } from '@flux/contracts';
import { validModelId, type AiEndpointPolicyPort } from '@flux/core';
import { chatBaseUrl } from './chat-completions.js';
import { checkEndpoint, parsePrivateTargets, PUBLIC_ONLY, type AiEndpointPolicy, type Resolver, systemResolver } from './endpoint-policy.js';
import { endpointRefusal, guardedFetch } from './guarded-fetch.js';

// A provider's model list (F-020 PROV-1, CA-2). OpenRouter lists its models and their prices publicly, and an OpenAI-compatible
// server usually answers `GET /models` without a key (`listProviderModels`). Anthropic, OpenAI and Gemini list only the models a key
// can use, with that key (`listKeyModels`, #1218): the API while the key is being added (the same call is its test), the worker for a
// stored key, the only process that opens one (CA-4). The same guarded transport bounds every listing. A listed price is only a
// suggestion the owner may enter; it is never a reservation price (PROV-3).

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

function withoutTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end -= 1;
  return value.slice(0, end);
}

/** The API version the Anthropic SDK 1.x sends (#1240; provider-adapters.test.ts asserts it on the adapter): the listing sends the same. */
const ANTHROPIC_API_VERSION = '2026-10-21';

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
      models.set(id, { id, family: aiModelFamily(provider, id), price: input !== null && output !== null ? { inputMicrosPerMTok: input, outputMicrosPerMTok: output } : null });
      if (models.size >= MAX_MODELS) break;
    }
    return result('listed', [...models.values()].sort((a, b) => a.id.localeCompare(b.id)));
  } catch (error) {
    return result(endpointRefusal(error) ? 'refused' : 'unavailable');
  }
}

/** Providers whose models are listed with the owner's key (#1218). */
export const KEY_LISTED_PROVIDERS = ['anthropic', 'openai', 'gemini'] as const satisfies readonly AiProviderKind[];
export const listsWithKey = (provider: AiProviderKind): provider is (typeof KEY_LISTED_PROVIDERS)[number] =>
  (KEY_LISTED_PROVIDERS as readonly AiProviderKind[]).includes(provider);

/**
 * OpenAI lists every model of the key, chat or not (embeddings, speech, images, moderation, realtime). Only the text models its
 * Responses API answers are offered; a dated snapshot is left out beside its alias.
 */
const OPENAI_CHAT = /^(gpt-\d|o\d|chatgpt-)/;
const NOT_CHAT = /(audio|realtime|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|instruct|computer-use|codex|diarize|sora|babbage|davinci)/;
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;
/** Gemini: text models that `generateContent`, without the audio, image, video, embedding and robotics ones, or `-latest` aliases. */
const GEMINI_NOT_CHAT = /(tts|image|embedding|live|audio|robotics|transcribe|omni|banana|lyria|veo|imagen|aqa|-latest$)/;

const text = (value: unknown, max = 200) => (typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null);
const isoDate = (value: unknown): string | null => {
  const at = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null;
};

/**
 * The models one key can use, read from its provider with that key (#1218). `key_refused`: the provider refused the key (401 or 403,
 * and Gemini's 400 `API_KEY_INVALID`); `unavailable`: a timeout, another status or an answer that is not a model list. The key goes
 * only into its provider's own header (`Authorization` for Anthropic and OpenAI, `x-goog-api-key` for Gemini), never into the address, and nothing of it
 * comes back in the result.
 */
export async function listKeyModels(provider: AiProviderKind, apiKey: string, options: ModelListOptions = {}): Promise<AiModelList> {
  const { policy = PUBLIC_ONLY, baseUrls = {}, timeoutMs = 8_000, maxResponseBytes = 4_000_000, resolve = systemResolver } = options;
  const checkedOn = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const result = (status: AiModelList['status'], models: AiListedModel[] = []): AiModelList => ({ provider, status, models, checkedOn });
  if (!listsWithKey(provider)) return result('needs_key');
  const root = withoutTrailingSlashes(baseUrls[provider] ?? AI_PROVIDERS[provider].baseUrl!);
  const send = guardedFetch(policy, { timeoutMs, maxResponseBytes }, resolve);
  const deadline = AbortSignal.timeout(timeoutMs);
  const models = new Map<string, AiListedModel>();
  const add = (id: unknown, name: unknown, createdAt: unknown, line?: unknown) => {
    if (typeof id !== 'string' || !validModelId(provider, id) || models.has(id) || models.size >= MAX_MODELS) return;
    models.set(id, { id, name: text(name), family: aiModelFamily(provider, id, text(line, 20)), createdAt: isoDate(createdAt), price: null });
  };
  try {
    let next: string | null = '';
    for (let page = 0; next !== null && page < 3; page += 1) {
      let url: string; let headers: Record<string, string>;
      if (provider === 'anthropic') {
        url = `${root}/v1/models?limit=1000${next ? `&after_id=${encodeURIComponent(next)}` : ''}`;
        // As the adapter calls Anthropic since SDK 1.x (#1240, #1285): the key as a bearer token and the current API version.
        headers = { authorization: `Bearer ${apiKey}`, 'anthropic-version': ANTHROPIC_API_VERSION };
      } else if (provider === 'openai') {
        url = `${root}/models`;
        headers = { authorization: `Bearer ${apiKey}` };
      } else {
        // Gemini's own `models.list` beside its OpenAI-compatible root: it names each model and what it can do.
        url = `${root.replace(/\/openai$/, '')}/models?pageSize=1000${next ? `&pageToken=${encodeURIComponent(next)}` : ''}`;
        headers = { 'x-goog-api-key': apiKey };
      }
      const response = await send(url, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal: deadline });
      if (response.status === 401 || response.status === 403) return result('key_refused');
      if (provider === 'gemini' && response.status === 400 && /API_KEY_INVALID|API key not valid/.test(await response.text())) return result('key_refused');
      if (response.status !== 200) return result('unavailable');
      const body = await response.json() as Record<string, unknown> | null;
      next = null;
      if (provider === 'anthropic') {
        if (!body || !Array.isArray(body.data)) return result('unavailable');
        for (const item of body.data as Record<string, unknown>[]) {
          if (item?.lifecycle === 'retired') continue;
          add(item?.id, item?.display_name, item?.created_at, item?.line);
        }
        next = body.has_more === true && typeof body.last_id === 'string' ? body.last_id : null;
      } else if (provider === 'openai') {
        if (!body || !Array.isArray(body.data)) return result('unavailable');
        const ids = new Set((body.data as Record<string, unknown>[]).map((item) => item?.id).filter((id): id is string => typeof id === 'string'));
        for (const item of body.data as Record<string, unknown>[]) {
          const id = typeof item?.id === 'string' ? item.id : '';
          if (!OPENAI_CHAT.test(id) || NOT_CHAT.test(id) || (SNAPSHOT.test(id) && ids.has(id.replace(SNAPSHOT, '')))) continue;
          add(id, null, item.created);
        }
      } else {
        if (!body || !Array.isArray(body.models)) return result('unavailable');
        for (const item of body.models as Record<string, unknown>[]) {
          const id = typeof item?.name === 'string' ? item.name.replace(/^models\//, '') : '';
          const methods = Array.isArray(item?.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
          if (!id.startsWith('gemini-') || GEMINI_NOT_CHAT.test(id) || !methods.includes('generateContent')) continue;
          add(id, item.displayName, null);
        }
        next = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : null;
      }
    }
    return result('listed', [...models.values()].sort(compareModelsNewestFirst));
  } catch (error) {
    return result(endpointRefusal(error) ? 'refused' : 'unavailable');
  }
}

/**
 * TEST ONLY (#1218): `FLUX_TEST_PROVIDER_LISTS`, the http origin of a mock that answers the key listings of Anthropic
 * (`/lists/anthropic/v1/models`), OpenAI (`/lists/openai/v1/models`) and Gemini (`/lists/gemini/v1beta/models`), so the check stacks never send a test
 * key to a real provider. Refused unless `FLUX_TEST_FAILURE_INJECTION=true`; empty in production, where a key is only ever sent to
 * its provider's fixed address. Returns the listing options for the API and the worker alike.
 */
export function keyListingOptions(env: NodeJS.ProcessEnv, policy: AiEndpointPolicy): Pick<ModelListOptions, 'policy' | 'baseUrls'> {
  const mock = env.FLUX_TEST_PROVIDER_LISTS ?? '';
  if (!mock) return { policy };
  if (env.FLUX_TEST_FAILURE_INJECTION !== 'true') throw new Error('FLUX_TEST_PROVIDER_LISTS is test only and needs FLUX_TEST_FAILURE_INJECTION=true');
  const origin = /^http:\/\/([a-z0-9.-]+)(:\d+)?$/.exec(mock);
  if (!origin) throw new Error('FLUX_TEST_PROVIDER_LISTS must be the http origin of the mock provider');
  return {
    policy: parsePrivateTargets([env.FLUX_AI_PRIVATE_TARGETS ?? '', origin[1]].join(',')),
    baseUrls: { anthropic: `${mock}/lists/anthropic`, openai: `${mock}/lists/openai/v1`, gemini: `${mock}/lists/gemini/v1beta/openai` },
  };
}

/** Core's endpoint policy port over the guard: the save-time half of the check (PROV-4). */
export function endpointPolicyPort(policy: AiEndpointPolicy, resolve: Resolver = systemResolver): AiEndpointPolicyPort {
  return { check: (baseUrl) => checkEndpoint(baseUrl, policy, resolve) };
}
