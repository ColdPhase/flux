import { AI_BASE_URL_MAX_LENGTH, AI_MODEL_ID_PATTERN, AI_PRICE_MAX_MICROS_PER_MTOK, type AiProviderKind } from '@flux/contracts';

// Provider-neutral connection rules (F-020, #179). Pure functions shared by the API use cases, the
// worker and the adapters. Key formats are checked per provider so an owner cannot save a key of
// one provider under another by mistake; the format says nothing about the key's validity.

const KEY_FORMATS: Record<AiProviderKind, RegExp> = {
  anthropic: /^sk-ant-[A-Za-z0-9_-]{16,256}$/,
  // Project (sk-proj-), service-account (sk-svcacct-) and legacy user keys. An organization admin
  // key (sk-admin-) is refused: O-007 accepts no shared administrator key.
  openai: /^sk-(?!ant-|or-|admin-)[A-Za-z0-9_-]{20,300}$/,
  openrouter: /^sk-or-[A-Za-z0-9_-]{16,256}$/,
  gemini: /^AIza[0-9A-Za-z_-]{30,100}$/,
  // Whatever the endpoint expects: visible ASCII without spaces.
  openai_compatible: /^[\x21-\x7e]{8,512}$/,
};

export function validAiKey(provider: AiProviderKind, key: unknown): key is string {
  return typeof key === 'string' && KEY_FORMATS[provider].test(key);
}

/**
 * A bounded model id. OpenRouter's `:online` variants add a paid provider-hosted web search, and
 * provider-hosted tools stay off for every provider (PROV-2), so they are refused.
 */
export function validModelId(provider: AiProviderKind, model: unknown): model is string {
  if (typeof model !== 'string' || !AI_MODEL_ID_PATTERN.test(model)) return false;
  return !(provider === 'openrouter' && /:online$/i.test(model));
}

/**
 * The syntax of an owner-set base URL: absolute http(s), no credentials, query or fragment.
 * Whether its host may be reached is the endpoint policy's decision, made when it is saved and
 * again at every dispatch (PROV-4). Returns the reason for refusal, or null.
 */
export function baseUrlSyntaxProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > AI_BASE_URL_MAX_LENGTH) return 'The base URL must be 1–2048 characters';
  if (/\s/.test(value)) return 'The base URL must not contain spaces';
  let url: URL;
  try { url = new URL(value); } catch { return 'The base URL must be an absolute URL'; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'The base URL must use https';
  if (url.username || url.password || value.includes('@')) return 'The base URL must not contain credentials';
  if (url.search || url.hash || value.includes('?') || value.includes('#')) return 'The base URL must not contain a query or fragment';
  if (!url.hostname) return 'The base URL needs a host';
  return null;
}

/** `https://host/v1/` and `https://host/v1` are the same endpoint; stored without the trailing slash. */
export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function validPrice(price: unknown): price is { inputMicrosPerMTok: number; outputMicrosPerMTok: number } {
  if (!price || typeof price !== 'object' || Array.isArray(price)) return false;
  const { inputMicrosPerMTok, outputMicrosPerMTok, ...rest } = price as Record<string, unknown>;
  return Object.keys(rest).length === 0 && [inputMicrosPerMTok, outputMicrosPerMTok].every((value) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= AI_PRICE_MAX_MICROS_PER_MTOK);
}

