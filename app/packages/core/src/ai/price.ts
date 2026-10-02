import { maxRequestMicros, tablePrice, type AiPrice, type AiProviderKind } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';

// PROV-3 prices. A connection's price per 1M tokens comes from the first source that applies:
// the provider's own listing (OpenRouter reports per-model prices, and each response's cost), Flux's
// dated price table, or the owner. A connection without a known price cannot be enabled.

/** The provider's own model listing, read by the server without a key through the endpoint guard. */
export interface AiPriceListing {
  /** The listed price of `model`, or null when the provider lists none or cannot be reached. Never throws. */
  listedPrice(provider: AiProviderKind, model: string, baseUrl: string | null): Promise<{ inputMicrosPerMTok: number; outputMicrosPerMTok: number } | null>;
}

export const noPriceListing: AiPriceListing = { listedPrice: async () => null };

export async function resolveConnectionPrice(input: {
  provider: AiProviderKind; model: string; baseUrl: string | null;
  ownerPrice: { inputMicrosPerMTok: number; outputMicrosPerMTok: number } | undefined;
  listing: AiPriceListing; today: string;
}): Promise<AiPrice | null> {
  const listed = await input.listing.listedPrice(input.provider, input.model, input.baseUrl).catch(() => null);
  const table = tablePrice(input.provider, input.model);
  if ((listed || table) && input.ownerPrice)
    throw new InvalidInputError(listed ? 'The provider reports this model’s price; leave the price empty' : 'Flux’s price table has this model; leave the price empty', 'AI_PRICE_ALREADY_KNOWN');
  if (listed) return { ...listed, source: 'provider_reported', checkedOn: input.today };
  if (table) return { inputMicrosPerMTok: table.inputMicrosPerMTok, outputMicrosPerMTok: table.outputMicrosPerMTok, source: 'table', checkedOn: table.checkedOn };
  if (input.ownerPrice) return { ...input.ownerPrice, source: 'owner', checkedOn: null };
  return null;
}

/** The PROV-3 reservation of one request in micro-dollars, or null without a known price. */
export function requestReservationMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'> | null, maxInputTokens: number, maxOutputTokens: number): number | null {
  return price ? maxRequestMicros(price, maxInputTokens, maxOutputTokens) : null;
}

/**
 * Micro-dollars of one completed request: the provider-reported cost when the response carries it
 * (PROV-3 source 1), otherwise the reported tokens at the connection's price, rounded up.
 */
export function usageMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, usage: { inputTokens: number; outputTokens: number; reportedCostMicros?: number | null }): number {
  if (typeof usage.reportedCostMicros === 'number' && Number.isSafeInteger(usage.reportedCostMicros) && usage.reportedCostMicros >= 0) return usage.reportedCostMicros;
  return maxRequestMicros(price, usage.inputTokens, usage.outputTokens);
}

/** YYYY-MM-DD in UTC. */
export const isoDay = (date: Date) => date.toISOString().slice(0, 10);
