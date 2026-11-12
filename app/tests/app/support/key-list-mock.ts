import type http from 'node:http';

/**
 * TEST ONLY (#1218): the key listings of Anthropic, OpenAI and Gemini, served by the provider mock under `/lists/…`
 * (`FLUX_TEST_PROVIDER_LISTS`). Never a provider. The key decides the answer: one containing `refused` is refused (401; Gemini's 400
 * `API_KEY_INVALID`), `broken` fails (500), `slow` answers after 12 seconds (past the 8-second bound); any other key gets the lists
 * below. `POST /__key-lists { key, omit: [ids], fail: true }` scripts the answers to that one key (suites run side by side): models left
 * out (a model the provider retired), or a failure (500) until it is posted again without `fail`. `GET /__key-lists` returns what was
 * asked.
 */
export interface KeyListRequest { provider: 'anthropic' | 'openai' | 'gemini'; path: string; key: string | null; at: number; /** Anthropic's `anthropic-version` header. */ version: string | null }
export const keyListRequests: KeyListRequest[] = [];
const scripted = new Map<string, { omit: Set<string>; fail: boolean }>();

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
    const script = body as { key?: string; omit?: string[]; fail?: boolean } | null;
    if (request.method === 'POST' && script?.key) scripted.set(script.key, { omit: new Set((script.omit ?? []).map(String)), fail: script.fail === true });
    json(response, 200, { requests: keyListRequests });
    return true;
  }
  const match = /^\/lists\/(anthropic|openai|gemini)\//.exec(url.pathname);
  if (!match) return false;
  const provider = match[1] as KeyListRequest['provider'];
  // Anthropic and OpenAI take the key as a bearer token (Anthropic's SDK 1.x does, #1240); Gemini in its own header.
  const key = provider === 'gemini' ? (request.headers['x-goog-api-key'] as string | undefined) ?? null
    : String(request.headers.authorization ?? '').replace(/^Bearer /, '') || null;
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
