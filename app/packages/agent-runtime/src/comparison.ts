import { AI_PROVIDERS, type AiProviderKind } from '@flux/contracts';
import { COMPARISON_OUTPUT_SCHEMA, COMPARISON_SYSTEM_PROMPT, ComparisonNotSentError, comparisonUserContent, parseComparisonAnswer,
  validModelId, type ComparisonProvider, type ComparisonProviderResponse } from '@flux/core';
import { chatBaseUrl, chatCompletion, ProviderHttpError } from './chat-completions.js';
import { PUBLIC_ONLY, type AiEndpointPolicy } from './endpoint-policy.js';
import { endpointRefusal, guardedFetch, type GuardedFetch } from './guarded-fetch.js';

// The background comparison's wire adapters (#58, O-007; F-020). Core assembles the prompt, the
// answer schema and the parsing for every provider; these only write one request in their wire
// format: no tools, no streaming, no automatic retry, the guarded transport and an explicit URL.
// Each wire format's structured-output field carries the same schema core embeds in the prompt:
// `output_config.format` for Anthropic Messages, `response_format` for Chat Completions.

const ANTHROPIC_VERSION = '2023-06-01';

interface ComparisonAdapterOptions {
  policy?: AiEndpointPolicy;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** A refusal before anything was sent ends the candidate at zero cost; other failures stay as they are. */
async function sent<T>(call: () => Promise<T>): Promise<T> {
  try { return await call(); } catch (error) {
    if (endpointRefusal(error)) throw new ComparisonNotSentError('ENDPOINT_REFUSED');
    throw error;
  }
}

function checkModel(provider: AiProviderKind, model: string) {
  if (!validModelId(provider, model)) throw new ComparisonNotSentError('MODEL_INVALID');
}

export function anthropicComparisonProvider(options: ComparisonAdapterOptions & { baseUrl?: string } = {}): ComparisonProvider {
  const { policy = PUBLIC_ONLY, timeoutMs = 20_000, maxResponseBytes = 1_000_000 } = options;
  const baseUrl = (options.baseUrl ?? AI_PROVIDERS.anthropic.baseUrl!).replace(/\/+$/, '');
  const fetch: GuardedFetch = guardedFetch(policy, { timeoutMs, maxResponseBytes });
  const requestBody = (model: string, sources: Parameters<typeof comparisonUserContent>[0]) => ({
    model, system: COMPARISON_SYSTEM_PROMPT, messages: [{ role: 'user', content: comparisonUserContent(sources) }],
    output_config: { effort: 'low', format: { type: 'json_schema', schema: COMPARISON_OUTPUT_SCHEMA } },
  });
  async function send(path: string, apiKey: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await sent(() => fetch(`${baseUrl}${path}`, { method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION, 'x-api-key': apiKey },
      body: JSON.stringify(body) }));
    if (response.status < 200 || response.status > 299) throw new ProviderHttpError(response.status);
    return response.json();
  }
  return {
    async countInputTokens({ apiKey, provider, model, sources, signal }) {
      checkModel(provider, model);
      const body = await send('/v1/messages/count_tokens', apiKey, requestBody(model, sources), signal) as { input_tokens?: unknown };
      if (!body || !Number.isSafeInteger(body.input_tokens)) throw new Error('The provider token count was invalid');
      return body.input_tokens as number;
    },
    async createMessage({ apiKey, provider, model, sources, maxTokens, effort, signal }): Promise<ComparisonProviderResponse> {
      checkModel(provider, model);
      const body = await send('/v1/messages', apiKey, { ...requestBody(model, sources), max_tokens: maxTokens,
        output_config: { effort, format: { type: 'json_schema', schema: COMPARISON_OUTPUT_SCHEMA } } }, signal) as {
        stop_reason?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown };
        content?: Array<{ type?: unknown; text?: unknown }>;
      };
      const textBlocks = Array.isArray(body?.content) ? body.content.filter((block) => block.type === 'text') : [];
      const answer = textBlocks.length === 1 ? parseComparisonAnswer(textBlocks[0]?.text) : null;
      return { stopReason: body?.stop_reason as string,
        usage: { inputTokens: body?.usage?.input_tokens as number, outputTokens: body?.usage?.output_tokens as number },
        answer };
    },
  };
}

export function openAiCompatibleComparisonProvider(options: ComparisonAdapterOptions & { baseUrls?: Partial<Record<AiProviderKind, string>> } = {}): ComparisonProvider {
  const { policy = PUBLIC_ONLY, timeoutMs = 20_000, maxResponseBytes = 1_000_000, baseUrls = {} } = options;
  const fetch = guardedFetch(policy, { timeoutMs, maxResponseBytes });
  return {
    // This wire format has no token-count endpoint: the Flux estimate alone bounds the input.
    async createMessage({ apiKey, provider, model, baseUrl, sources, maxTokens, signal }): Promise<ComparisonProviderResponse> {
      checkModel(provider, model);
      const url = chatBaseUrl(provider, baseUrl, baseUrls);
      if (!url) throw new ComparisonNotSentError('ENDPOINT_REFUSED');
      const result = await sent(() => chatCompletion(fetch, { provider, baseUrl: url, apiKey, model, system: COMPARISON_SYSTEM_PROMPT,
        user: comparisonUserContent(sources), maxTokens, schema: { name: 'flux_comparison', schema: COMPARISON_OUTPUT_SCHEMA }, signal }));
      // The same stop vocabulary as the Messages wire format, so core validates both identically.
      return { stopReason: result.stopReason, usage: result.usage,
        answer: result.stopReason === 'refusal' ? null : parseComparisonAnswer(result.text) };
    },
  };
}
