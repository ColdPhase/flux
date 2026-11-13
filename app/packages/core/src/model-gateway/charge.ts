import { maxRequestMicros, PROMPT_CACHE_RATES, type AiPrice, type AiProviderKind } from '@flux/contracts';
import { boundedUsageMicros } from '../ai/price.js';
import type { AdmittedRequest } from './admission.js';
import type { GatewayUsage } from './usage.js';

// The money of one request through the model gateway (#1441, CA-3), with the prices and cache rules of a server run (PROV-3, #1410,
// #1426): before it is sent, the most it can cost is held; after it, the reported usage is charged, never above what was held.

type Price = Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>;

/**
 * The most one request can cost: every input token it can be billed for, at the provider's cache-write rate where it has one (a
 * provider may write the whole prompt to its cache, asked or not), and its output bound.
 */
export function gatewayHoldMicros(price: Price, provider: AiProviderKind, request: Pick<AdmittedRequest, 'inputBoundTokens' | 'maxOutputTokens'>): number {
  const write = Math.max(1, PROMPT_CACHE_RATES[provider]?.write ?? 1);
  return maxRequestMicros(price, Math.ceil(request.inputBoundTokens * write), request.maxOutputTokens);
}

export interface GatewayCharge {
  micros: number;
  /** False when the usage could not be used (none, malformed, beyond the request's bounds): the request is charged all it held. */
  known: boolean;
}

/**
 * What a request is charged: its reported usage at the run model's price, cache writes at the write rate and cache reads at the read
 * rate only when the request asked for caching (otherwise at the full price, #1426); counts that cannot be right count the input twice
 * (`billedInputTokens`); OpenRouter's reported cost reconciles. No usable usage, more tokens than the request's bounds, any web search
 * (none can be asked) or a charge above the hold: all it held.
 */
export function gatewayChargeMicros(price: Price, provider: AiProviderKind, request: Pick<AdmittedRequest, 'inputBoundTokens' | 'maxOutputTokens' | 'cacheAsked'>,
  holdMicros: number, usage: GatewayUsage | null): GatewayCharge {
  if (!usage) return { micros: holdMicros, known: false };
  const rates = PROMPT_CACHE_RATES[provider];
  const cache = usage.cache
    ? { readTokens: usage.cache.readTokens, writeTokens: usage.cache.writeTokens, readRate: request.cacheAsked && rates ? rates.read : 1, writeRate: rates?.write ?? 1 }
    : undefined;
  const micros = boundedUsageMicros(price, {
    inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(usage.webSearches ? { webSearches: usage.webSearches } : {}),
    ...(usage.reportedCostMicros !== undefined ? { reportedCostMicros: usage.reportedCostMicros } : {}), ...(cache ? { cache } : {}),
  }, { maxInputTokens: request.inputBoundTokens, maxOutputTokens: request.maxOutputTokens, maxWebSearches: 0, reservedMicros: holdMicros });
  return micros === null ? { micros: holdMicros, known: false } : { micros, known: true };
}
