export const BACKGROUND_COMPARISON_MODEL = 'claude-sonnet-5';
export const BACKGROUND_COMPARISON_MAX_INPUT_TOKENS = 8_000;
export const BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS = 1_200;

export interface ComparisonSource {
  type: 'result' | 'message' | 'material' | 'work' | 'thought';
  id: string;
  version: number;
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
  answer: ComparisonAnswer;
}
export interface ComparisonProvider {
  countInputTokens(input: { apiKey: string; model: typeof BACKGROUND_COMPARISON_MODEL; sources: ComparisonSource[];
    signal: AbortSignal }): Promise<number>;
  createMessage(input: { apiKey: string; model: typeof BACKGROUND_COMPARISON_MODEL; maxTokens: typeof BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS;
    effort: 'low'; sources: ComparisonSource[]; signal: AbortSignal }): Promise<ComparisonProviderResponse>;
}

const validText = (value: unknown) => typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= 10_000;
const key = (source: Pick<ComparisonSource, 'type' | 'id' | 'version'>) => `${source.type}:${source.id}:${source.version}`;

/** Reject truncated, unsourced or malformed model output before any project row is created. */
export function validateComparisonResponse(response: ComparisonProviderResponse, supplied: ComparisonSource[]): ComparisonAnswer | null {
  if (!response || response.stopReason !== 'end_turn' || !response.usage
    || !Number.isSafeInteger(response.usage.inputTokens) || response.usage.inputTokens < 0
    || response.usage.inputTokens > BACKGROUND_COMPARISON_MAX_INPUT_TOKENS
    || !Number.isSafeInteger(response.usage.outputTokens) || response.usage.outputTokens < 0
    || response.usage.outputTokens > BACKGROUND_COMPARISON_MAX_OUTPUT_TOKENS
    || !response.answer || !validText(response.answer.fact)
    || !validText(response.answer.interpretation) || !validText(response.answer.suggestedAction)
    || !Array.isArray(response.answer.citations) || response.answer.citations.length < 1
    || response.answer.citations.length > supplied.length) return null;
  const allowed = new Set(supplied.map(key));
  if (response.answer.citations.some((citation) => !citation || !allowed.has(key(citation)))) return null;
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
