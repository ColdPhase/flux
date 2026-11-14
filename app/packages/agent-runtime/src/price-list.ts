import { AI_PRICE_LIST_URL, type AiPriceList } from '@flux/contracts';
import { parsePriceList, PRICE_LIST_MAX_BYTES, PRICE_LIST_TIMEOUT_MS } from '@flux/core';
import { PUBLIC_ONLY, type AiEndpointPolicy, type Resolver, systemResolver } from './endpoint-policy.js';
import { endpointRefusal, guardedFetch, ResponseTooLargeError } from './guarded-fetch.js';
import { keyListingOptions } from './model-list.js';

// Flux's daily price list (#1465): one anonymous GET of the maintained public list through the same egress guard as every AI request
// (public HTTPS only, every resolved address checked, no redirect), bounded in size and time. Nothing is sent but the request itself.

export interface PriceListFetchOptions {
  /** Test only: another address of a file of the same shape. */
  url?: string;
  policy?: AiEndpointPolicy;
  timeoutMs?: number;
  maxResponseBytes?: number;
  resolve?: Resolver;
  now?: () => Date;
}

export type PriceListFetch = { ok: true; list: AiPriceList } | { ok: false; reason: 'refused' | 'unavailable' | 'too_large' | 'invalid' };

export async function fetchPriceList(options: PriceListFetchOptions = {}): Promise<PriceListFetch> {
  const { url = AI_PRICE_LIST_URL, policy = PUBLIC_ONLY, timeoutMs = PRICE_LIST_TIMEOUT_MS, maxResponseBytes = PRICE_LIST_MAX_BYTES, resolve = systemResolver } = options;
  const fetchedOn = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  let text: string;
  try {
    const response = await guardedFetch(policy, { timeoutMs, maxResponseBytes }, resolve)(url,
      { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) return { ok: false, reason: 'unavailable' };
    text = await response.text();
  } catch (error) {
    if (endpointRefusal(error)) return { ok: false, reason: 'refused' };
    for (let current: unknown = error, depth = 0; current && depth < 5; current = (current as { cause?: unknown }).cause, depth++)
      if (current instanceof ResponseTooLargeError) return { ok: false, reason: 'too_large' };
    return { ok: false, reason: 'unavailable' };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: 'invalid' }; }
  const list = parsePriceList(raw, fetchedOn, url);
  return list ? { ok: true, list } : { ok: false, reason: 'invalid' };
}

/**
 * The worker's fetch options. TEST ONLY: with `FLUX_TEST_PROVIDER_LISTS` (the mock provider's origin, refused without
 * `FLUX_TEST_FAILURE_INJECTION=true`, see `keyListingOptions`) the list is asked of `<mock>/price-list`, so a check stack never reaches
 * the internet and keeps the shipped list unless its mock answers one.
 */
export function priceListFetchOptions(env: NodeJS.ProcessEnv, policy: AiEndpointPolicy): Pick<PriceListFetchOptions, 'url' | 'policy'> {
  const listing = keyListingOptions(env, policy);
  const mock = env.FLUX_TEST_PROVIDER_LISTS ?? '';
  return mock ? { url: `${mock}/price-list`, policy: listing.policy! } : { policy };
}
