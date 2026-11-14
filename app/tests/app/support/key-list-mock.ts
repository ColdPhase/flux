import type http from 'node:http';
import { offeredTools, toolAnswer, toolWireOf } from './tool-answers.js';

/**
 * TEST ONLY (#1218): the key listings of Anthropic, OpenAI and Gemini, served by the provider mock under `/lists/…`
 * (`FLUX_TEST_PROVIDER_LISTS`). Never a provider. The key decides the answer: one containing `refused` is refused (401; Gemini's 400
 * `API_KEY_INVALID`), `broken` fails (500), `slow` answers after 12 seconds (past the 8-second bound); any other key gets the lists
 * below. `POST /__key-lists { key, omit: [ids], fail: true }` scripts the answers to that one key (suites run side by side): models left
 * out (a model the provider retired), or a failure (500) until it is posted again without `fail`; `noTools: [ids]` makes those models answer the
 * check below in words only. `GET /__key-lists` returns what was asked.
 *
 * #1441 (RT-1 rule 2): the same roots answer the check that a key's model calls tools, in the wire format of each provider (Anthropic
 * `POST /lists/anthropic/v1/messages`, OpenAI `…/openai/v1/responses`, Gemini `…/gemini/v1beta/openai/chat/completions`, OpenRouter
 * `…/openrouter/v1/chat/completions`): the model calls the first tool it is offered (`ping`), unless its id contains `no-tools` (it answers
 * in words) or `check-fails` (500); a key containing `refused` is refused (401) as by its listing; the key's `fail` and `broken`/`slow` apply to its
 * listing only. Usage is `TOOL_ANSWER_USAGE`. OpenRouter's public priced list is `GET /lists/openrouter/v1/models` (#1465). `GET /__key-lists` also returns `checks`: what each check carried.
 */
export interface KeyListRequest { provider: 'anthropic' | 'openai' | 'gemini' | 'openrouter'; path: string; key: string | null; at: number; /** Anthropic's `anthropic-version` header. */ version: string | null }
export const keyListRequests: KeyListRequest[] = [];
/** One check that a model calls tools (#1441): the model, the tools the request offered and its output bound, with the key it carried. */
export interface ToolCheckRequest { provider: KeyListRequest['provider']; path: string; key: string | null; model: string | null; tools: string[]; body: unknown; at: number }
export const toolCheckRequests: ToolCheckRequest[] = [];
/**
 * OpenRouter's public model list with its prices (#1465): the list a key of OpenRouter pays by, read without a key. The same answer is
 * `GET /lists/openrouter/v1/models`, where a check stack reads it, and the provider mock's `/openrouter/v1/models`.
 */
export const OPENROUTER_MODELS = { data: [
  { id: 'vendor/priced-model', pricing: { prompt: '0.000003', completion: '0.000015' } },
  // A higher price from a prompt length on, as OpenRouter lists Gemini's and OpenAI's long-context prices.
  { id: 'vendor/long-model', pricing: { prompt: '0.000002', completion: '0.00001', overrides: [{ min_prompt_tokens: 200000, prompt: '0.000004', completion: '0.000018' }] } },
  { id: 'vendor/odd-tier-model', pricing: { prompt: '0.000002', completion: '0.00001', overrides: [{ min_prompt_tokens: 'many', prompt: '0.000004' }] } },
  { id: 'vendor/free-model:free', pricing: { prompt: '0', completion: '0' } },
  { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
  { id: 'vendor/search-model:online', pricing: { prompt: '0.000001', completion: '0.000001' } },
] };
const scripted = new Map<string, { omit: Set<string>; fail: boolean; noTools: Set<string> }>();

const ANTHROPIC = [
  { id: 'claude-sonnet-5-7', display_name: 'Claude Sonnet 5.7', line: 'sonnet', created_at: '2026-11-10T00:00:00Z', lifecycle: 'active' },
  { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2', line: 'fable', created_at: '2026-11-05T00:00:00Z', lifecycle: 'active' },
  { id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', line: 'sonnet', created_at: '2026-09-28T00:00:00Z', lifecycle: 'active' },
  { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', line: 'opus', created_at: '2026-09-21T00:00:00Z', lifecycle: 'active' },
  { id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1', line: 'fable', created_at: '2026-07-01T00:00:00Z', lifecycle: 'active' },
  { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5', line: 'sonnet', created_at: '2026-06-01T00:00:00Z', lifecycle: 'active' },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', line: 'haiku', created_at: '2025-10-01T00:00:00Z', lifecycle: 'deprecated' },
  { id: 'claude-opus-4-1-20250805', display_name: 'Claude Opus 4.1', line: 'opus', created_at: '2025-08-05T00:00:00Z', lifecycle: 'retired' },
];
const OPENAI = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6.1-terra', 'gpt-6-luna', 'gpt-4o', 'gpt-4o-2024-08-06', 'o3', 'text-embedding-3-large', 'tts-1', 'gpt-realtime', 'dall-e-3']
  .map((id, index) => ({ id, object: 'model', created: 1_790_000_000 - index * 1000, owned_by: 'openai' }));
const GEMINI = [
  { name: 'models/gemini-4-carbon', displayName: 'Gemini 4 Carbon', supportedGenerationMethods: ['generateContent', 'countTokens'] },
  { name: 'models/gemini-3.1-pro-preview', displayName: 'Gemini 3.1 Pro Preview', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-3.5-flash-lite', displayName: 'Gemini 3.5 Flash-Lite', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', supportedGenerationMethods: ['generateContent'] },
  { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
];

function json(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** Answers a key listing or a control request; false when the path is not one of them. */
export function handleKeyLists(request: http.IncomingMessage, response: http.ServerResponse, url: URL, body: unknown): boolean {
  if (url.pathname === '/__key-lists') {
    const script = body as { key?: string; omit?: string[]; fail?: boolean; noTools?: string[] } | null;
    if (request.method === 'POST' && script?.key)
      scripted.set(script.key, { omit: new Set((script.omit ?? []).map(String)), fail: script.fail === true, noTools: new Set((script.noTools ?? []).map(String)) });
    json(response, 200, { requests: keyListRequests, checks: toolCheckRequests });
    return true;
  }
  const match = /^\/lists\/(anthropic|openai|gemini|openrouter)\//.exec(url.pathname);
  if (!match) return false;
  const provider = match[1] as KeyListRequest['provider'];
  // Anthropic and OpenAI take the key as a bearer token (Anthropic's SDK 1.x does, #1240); Gemini in its own header.
  // Gemini's OpenAI-compatible endpoint (the tool check, #1441) takes it as a bearer, as the Chat Completions adapter sends it.
  const bearer = String(request.headers.authorization ?? '').replace(/^Bearer /, '') || null;
  const key = provider === 'gemini' ? (request.headers['x-goog-api-key'] as string | undefined) ?? bearer : bearer;
  const wire = request.method === 'POST' ? toolWireOf(url.pathname) : null;
  if (wire) {
    // The check that the key's model calls tools (#1441).
    const model = typeof (body as { model?: unknown } | null)?.model === 'string' ? (body as { model: string }).model : null;
    toolCheckRequests.push({ provider, path: url.pathname, key, model, tools: offeredTools(wire, body), body, at: Date.now() });
    if (!key || key.includes('refused')) {
      if (provider === 'gemini') json(response, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
      else json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    } else if (model?.includes('check-fails')) json(response, 500, { error: { message: 'scripted failure', type: 'server_error' } });
    else json(response, 200, toolAnswer(wire, body, { call: !model?.includes('no-tools') && !scripted.get(key)?.noTools.has(model ?? '') }));
    return true;
  }
  // OpenRouter's list is public: it is answered without a key, and a key is never needed to read it (#1465).
  if (provider === 'openrouter' && request.method === 'GET' && url.pathname === '/lists/openrouter/v1/models') {
    keyListRequests.push({ provider, path: `${url.pathname}${url.search}`, key, at: Date.now(), version: null });
    json(response, 200, OPENROUTER_MODELS);
    return true;
  }
  keyListRequests.push({ provider, path: `${url.pathname}${url.search}`, key, at: Date.now(), version: (request.headers['anthropic-version'] as string | undefined) ?? null });
  const { omit, fail } = scripted.get(key ?? '') ?? { omit: new Set<string>(), fail: false };
  const answer = () => {
    if (!key || key.includes('refused')) {
      if (provider === 'gemini') return json(response, 400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } });
      return json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    }
    if (key.includes('broken') || fail) return json(response, 500, { error: 'scripted failure' });
    if (provider === 'anthropic' && url.pathname === '/lists/anthropic/v1/models')
      return json(response, 200, { data: ANTHROPIC.filter((model) => !omit.has(model.id)).map((model) => ({ type: 'model', ...model })), has_more: false, first_id: null, last_id: null });
    if (provider === 'openai' && url.pathname === '/lists/openai/v1/models')
      return json(response, 200, { object: 'list', data: OPENAI.filter((model) => !omit.has(model.id)) });
    if (provider === 'gemini' && url.pathname === '/lists/gemini/v1beta/models')
      return json(response, 200, { models: GEMINI.filter((model) => !omit.has(model.name.replace(/^models\//, ''))) });
    return json(response, 404, { error: 'not found' });
  };
  if (key?.includes('slow')) setTimeout(answer, 12_000); else answer();
  return true;
}
