import { maxRequestMicros, tablePrice, type AiPrice, type AiProviderKind } from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';

// PROV-3 prices. A reservation needs a price before any response exists, so a connection's price
// per 1M tokens comes only from Flux's dated price table or from the owner (zero allowed for a
// self-hosted endpoint). A connection with neither cannot be enabled. A cost a provider reports in
// a response (OpenRouter's `usage.cost`) never raises or bypasses the reservation; it only
// reconciles the actual charge of that run (`usageMicros`), and a charge is never stored above the
// reservation (`boundedUsageMicros`).

export function resolveConnectionPrice(input: {
  provider: AiProviderKind; model: string;
  ownerPrice: { inputMicrosPerMTok: number; outputMicrosPerMTok: number } | undefined;
}): AiPrice | null {
  const table = tablePrice(input.provider, input.model);
  if (table && input.ownerPrice)
    throw new InvalidInputError('Flux’s price table has this model; leave the price empty', 'AI_PRICE_ALREADY_KNOWN');
  if (table) return { inputMicrosPerMTok: table.inputMicrosPerMTok, outputMicrosPerMTok: table.outputMicrosPerMTok, source: 'table', checkedOn: table.checkedOn };
  if (input.ownerPrice) return { ...input.ownerPrice, source: 'owner', checkedOn: null };
  return null;
}

/** The PROV-3 reservation of one request in micro-dollars, or null without a known price. */
export function requestReservationMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'> | null, maxInputTokens: number, maxOutputTokens: number): number | null {
  return price ? maxRequestMicros(price, maxInputTokens, maxOutputTokens) : null;
}

/**
 * Micro-dollars of one completed request, for reconciliation only: the provider-reported cost when
 * the response carries one, otherwise the reported tokens at the connection's price, rounded up.
 */
export function usageMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>, usage: { inputTokens: number; outputTokens: number; reportedCostMicros?: number | null }): number {
  if (typeof usage.reportedCostMicros === 'number' && Number.isSafeInteger(usage.reportedCostMicros) && usage.reportedCostMicros >= 0) return usage.reportedCostMicros;
  return maxRequestMicros(price, usage.inputTokens, usage.outputTokens);
}

/** Whether both reported token counts are whole, non-negative and within the request's limits. */
export function usageTokensWithin(usage: { inputTokens: number; outputTokens: number }, bounds: { maxInputTokens: number; maxOutputTokens: number }): boolean {
  const within = (tokens: number, max: number) => Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= max;
  return within(usage.inputTokens, bounds.maxInputTokens) && within(usage.outputTokens, bounds.maxOutputTokens);
}

/**
 * The charge of one completed request within its consented bounds, or null when the reported usage
 * is outside them: more input or output tokens than the request allowed, or a reconciled cost
 * (reported or token-derived) above its reservation. A null charge is never stored: the caller
 * keeps the whole reservation counted as `unknown` and withholds the result (PROV-3).
 */
export function boundedUsageMicros(price: Pick<AiPrice, 'inputMicrosPerMTok' | 'outputMicrosPerMTok'>,
  usage: { inputTokens: number; outputTokens: number; reportedCostMicros?: number | null },
  bounds: { maxInputTokens: number; maxOutputTokens: number; reservedMicros: number }): number | null {
  if (!usageTokensWithin(usage, bounds)) return null;
  const charge = usageMicros(price, usage);
  return Number.isSafeInteger(charge) && charge >= 0 && charge <= bounds.reservedMicros ? charge : null;
}
