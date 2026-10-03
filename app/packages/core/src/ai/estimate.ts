// The conservative Flux token estimate (F-020 PROV-3): the same input bound for every provider.
//
// Tokenizers differ by provider and model, and Flux cannot run each one. Byte-level and
// SentencePiece tokenizers produce at most one token per UTF-8 byte; prose in the major
// tokenizers takes three or more bytes per token (about four for English), and a CJK character is
// three bytes and one to two tokens. Counting one token per two UTF-8 bytes therefore stays above
// the provider's own count for prose in every language Flux serves, with a fixed allowance per
// message and for the request frame. A provider's token-count endpoint may only tighten this
// (`boundedInputTokens`): its count is used when it is higher, never to admit a longer input.

const FRAME_TOKENS = 16;
const PART_TOKENS = 8;

export function conservativeTokenEstimate(parts: readonly string[]): number {
  return FRAME_TOKENS + parts.reduce((sum, part) => sum + PART_TOKENS + Math.ceil(Buffer.byteLength(part, 'utf8') / 2), 0);
}

/** The input size a run is bounded by: the Flux estimate, raised (never lowered) by a provider count. */
export function boundedInputTokens(estimate: number, providerCount: number | null): number {
  return providerCount === null ? estimate : Math.max(estimate, providerCount);
}
