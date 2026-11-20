import { geminiSearchBilledPerPrompt } from '@flux/contracts';
import type { PersonalComputeResult } from '@flux/core';
import { MalformedResponseError, ProviderHttpError } from './chat-completions.js';
import type { GuardedFetch } from './guarded-fetch.js';

// Gemini's web search (#1585, C-72): Google Search grounding, which Google offers on its own `generateContent` API and not on the
// OpenAI-compatible endpoint Flux speaks to Gemini otherwise (aistudio.google.com/docs/openai lists grounding only for image generation,
// read 2026-11-20). Only `flux_web_search`'s one request goes here: Flux's instruction, the query, the `google_search` tool and nothing
// else, to the same host as the key's other requests (`/v1beta/models/<model>:generateContent`, the key in `x-goog-api-key`), with the
// guarded transport and no retries. The request and response shapes are the documented ones (aistudio.google.com/docs/google-search,
// read 2026-11-20): the answer's `groundingMetadata` names the queries the model ran (`webSearchQueries`), the sources (`groundingChunks`,
// each `web.uri` and `web.title`) and which of them each part of the answer rests on (`groundingSupports`).

export interface GeminiSearchRequest {
  /** Gemini's API root, `…/v1beta` (the compatible endpoint's base without its `/openai`). */
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  signal: AbortSignal;
}

/** Gemini's API root from the base URL of its OpenAI-compatible endpoint: `…/v1beta/openai` → `…/v1beta`. */
export function geminiApiRoot(compatibleBaseUrl: string): string {
  let base = compatibleBaseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return base.endsWith('/openai') ? base.slice(0, -'/openai'.length) : base;
}

const tokens = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
const REFUSED = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

interface Candidate {
  content?: { parts?: { text?: unknown; thought?: unknown }[] };
  finishReason?: unknown;
  groundingMetadata?: { webSearchQueries?: unknown; groundingChunks?: unknown; groundingSupports?: unknown };
}

/** The search's queries, its sources and the sources the answer rests on, from a candidate's `groundingMetadata`. */
function grounding(metadata: Candidate['groundingMetadata']) {
  const queries = Array.isArray(metadata?.webSearchQueries) ? metadata.webSearchQueries.filter((query): query is string => typeof query === 'string' && query.trim() !== '') : [];
  const chunks = Array.isArray(metadata?.groundingChunks) ? metadata.groundingChunks as { web?: { uri?: unknown } }[] : [];
  const sources = chunks.map((chunk) => (typeof chunk?.web?.uri === 'string' ? chunk.web.uri : null));
  const cited = new Set<string>();
  for (const support of Array.isArray(metadata?.groundingSupports) ? metadata.groundingSupports as { groundingChunkIndices?: unknown }[] : [])
    for (const index of Array.isArray(support?.groundingChunkIndices) ? support.groundingChunkIndices : [])
      if (Number.isSafeInteger(index) && sources[index as number]) cited.add(sources[index as number]!);
  return { queries, results: sources.filter((uri): uri is string => uri !== null), cited: [...cited] };
}

/** Sends one grounded request and maps its answer. Throws the typed errors of Chat Completions. */
export async function geminiSearch(fetch: GuardedFetch, request: GeminiSearchRequest): Promise<Extract<PersonalComputeResult, { kind: 'completed' }>> {
  const body = {
    systemInstruction: { parts: [{ text: request.system }] },
    contents: [{ role: 'user', parts: [{ text: request.user }] }],
    tools: [{ google_search: {} }],
    generationConfig: { maxOutputTokens: request.maxTokens },
  };
  let base = request.baseUrl;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const response = await fetch(`${base}/models/${encodeURIComponent(request.model)}:generateContent`, {
    method: 'POST', signal: request.signal,
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-goog-api-key': request.apiKey },
    body: JSON.stringify(body),
  });
  if (response.status < 200 || response.status > 299) throw new ProviderHttpError(response.status);
  let parsed: { candidates?: unknown; usageMetadata?: Record<string, unknown>; promptFeedback?: { blockReason?: unknown } };
  try { parsed = await response.json() as typeof parsed; } catch { throw new MalformedResponseError('not JSON'); }
  const usage = parsed?.usageMetadata;
  const prompt = tokens(usage?.promptTokenCount);
  if (prompt === null) throw new MalformedResponseError('no usage');
  // Input: the prompt and the search results Google gave the model (`toolUsePromptTokenCount`); output: the answer and its thinking.
  const inputTokens = prompt + (tokens(usage?.toolUsePromptTokenCount) ?? 0);
  const outputTokens = (tokens(usage?.candidatesTokenCount) ?? 0) + (tokens(usage?.thoughtsTokenCount) ?? 0);
  const candidate = Array.isArray(parsed.candidates) ? parsed.candidates[0] as Candidate | undefined : undefined;
  const refused = parsed.promptFeedback?.blockReason !== undefined || (typeof candidate?.finishReason === 'string' && REFUSED.has(candidate.finishReason));
  if (!candidate && !refused) throw new MalformedResponseError('no candidate');
  const text = (candidate?.content?.parts ?? []).flatMap((part) => (part?.thought !== true && typeof part?.text === 'string' ? [part.text] : [])).join('').trim();
  const found = grounding(candidate?.groundingMetadata);
  // Google bills Gemini 3 and newer for each query the model ran, and 2.5 and older for each grounded prompt (C-72).
  const grounded = found.queries.length > 0 || found.results.length > 0;
  const webSearches = geminiSearchBilledPerPrompt(request.model) ? (grounded ? 1 : 0) : new Set(found.queries.map((query) => query.trim())).size;
  return {
    kind: 'completed', text: refused ? '' : text,
    stopReason: refused ? 'refusal' : candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
    usage: { inputTokens, outputTokens, ...(webSearches ? { webSearches } : {}) },
    webSearch: found,
  };
}
