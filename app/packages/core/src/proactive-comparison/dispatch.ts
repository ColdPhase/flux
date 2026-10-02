import { WORK_LIMITS } from '@flux/contracts';
export const BACKGROUND_COMPARISON_MODEL = 'claude-sonnet-5';
export const BACKGROUND_COMPARISON_MAX_INPUT_TOKENS = 8_000;
export const BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS = 1_200;

export interface ComparisonSource {
  type: 'result' | 'message' | 'material' | 'work' | 'thought';
  id: string;
  version: number;
  conversationId?: string;
  sketchId?: string;
  title?: string;
  text: string;
  /** Explicitly marked bounded excerpt, not the complete source. */
  excerpted?: boolean;
  originalCharacters?: number;
}
export interface ComparisonAnswer {
  fact: string;
  interpretation: string;
  suggestedAction: string;
  citations: Array<Pick<ComparisonSource, 'type' | 'id' | 'version' | 'sketchId' | 'title'>>;
}
export interface ComparisonProviderResponse {
  stopReason: string;
  usage: { inputTokens: number; outputTokens: number };
  answer: ({ kind: 'comparison' } & ComparisonAnswer) | { kind: 'insufficient_evidence'; reason: string } | null;
}
export interface ComparisonProvider {
  countInputTokens(input: { apiKey: string; model: typeof BACKGROUND_COMPARISON_MODEL; sources: ComparisonSource[];
    signal: AbortSignal }): Promise<number>;
  createMessage(input: { apiKey: string; model: typeof BACKGROUND_COMPARISON_MODEL; maxTokens: typeof BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS;
    effort: 'low'; sources: ComparisonSource[]; signal: AbortSignal }): Promise<ComparisonProviderResponse>;
}

const validText = (value: unknown) => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 10_000;
const key = (source: Pick<ComparisonSource, 'type' | 'id' | 'version'>) => `${source.type}:${source.id}:${source.version}`;

/** Observed token-derived estimate, only when both reported token counts are within the consented bounds. */
export function comparisonObservedUsage(response: ComparisonProviderResponse): { inputTokens: number; outputTokens: number; estimatedCents: number } | null {
  if (!response?.usage || !Number.isSafeInteger(response.usage.inputTokens) || response.usage.inputTokens < 0
    || response.usage.inputTokens > BACKGROUND_COMPARISON_MAX_INPUT_TOKENS
    || !Number.isSafeInteger(response.usage.outputTokens) || response.usage.outputTokens < 0
    || response.usage.outputTokens > BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS) return null;
  return { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
    estimatedCents: estimatedUsageCents(response.usage.inputTokens, response.usage.outputTokens) };
}

/** The provider's insufficient branch is plain bounded text; malformed/truncated answers use fixed safe copy. */
export function insufficientComparisonReason(response: ComparisonProviderResponse): string {
  const answer = response?.answer;
  if (response?.stopReason === 'end_turn' && answer?.kind === 'insufficient_evidence'
    && Object.keys(answer).every((field) => field === 'kind' || field === 'reason')
    && typeof answer.reason === 'string' && answer.reason.trim().length >= 1 && answer.reason.trim().length <= 1000)
    return answer.reason.trim();
  return 'The response did not provide a complete, valid comparison grounded in the inspected sources.';
}

/** Reject truncated, unsourced or malformed model output before any project row is created. */
export function validateComparisonResponse(response: ComparisonProviderResponse, supplied: ComparisonSource[]): ComparisonAnswer | null {
  if (!response || response.stopReason !== 'end_turn' || !comparisonObservedUsage(response)
    || !response.answer || response.answer.kind !== 'comparison'
    || Object.keys(response.answer).some((field) => !['kind', 'fact', 'interpretation', 'suggestedAction', 'citations'].includes(field))
    || !validText(response.answer.fact)
    || !validText(response.answer.interpretation) || !validText(response.answer.suggestedAction)
    // The suggested step can become a work outcome, which has its own limit.
    || response.answer.suggestedAction.trim().length > WORK_LIMITS.outcome
    || !Array.isArray(response.answer.citations) || response.answer.citations.length < 1
    || response.answer.citations.length > supplied.length) return null;
  const allowed = new Set(supplied.map(key));
  if (response.answer.citations.some((citation) => !citation || typeof citation !== 'object' || Array.isArray(citation)
    || typeof citation.id !== 'string' || !Number.isSafeInteger(citation.version) || citation.version < 1
    || !allowed.has(key(citation)))) return null;
  if (new Set(response.answer.citations.map(key)).size !== response.answer.citations.length) return null;
  if (!response.answer.citations.some((citation) => citation.type === 'result' && citation.id === supplied[0]?.id)) return null;
  return { fact: response.answer.fact.trim(), interpretation: response.answer.interpretation.trim(),
    suggestedAction: response.answer.suggestedAction.trim(),
    citations: response.answer.citations.map(({ type, id, version }) => {
      const source = supplied.find((item) => key(item) === key({ type, id, version }))!;
      return { type, id, version, ...(source.title ? { title: source.title } : {}),
        ...(type === 'thought' ? { sketchId: source.sketchId } : {}) };
    }) };
}

/** Dated standard-rate estimate; separate from the provider invoice. */
export function estimatedUsageCents(inputTokens: number, outputTokens: number): number {
  return Math.ceil((inputTokens * 2 + outputTokens * 10) / 10_000);
}
