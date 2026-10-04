import http from 'node:http';

/**
 * TEST ONLY (#179, F-020 PROV-6): a local stand-in for the two AI wire formats, run as the Compose
 * `providermock` service of `scripts/check_application.sh`. It is never a provider: nothing here
 * proves compatibility, billing or model behaviour; it lets one adapter contract suite run the same
 * cases against both wire formats in Docker.
 *
 *   POST /anthropic/v1/messages, /anthropic/v1/messages/count_tokens   Anthropic Messages
 *   POST /openai/v1/chat/completions, GET /openai/v1/models          OpenAI-compatible Chat Completions
 *   GET  /openrouter/v1/models                                       a priced model list (OpenRouter's shape)
 *   POST /__script { wire, mode, text, usage, cost, status, delayMs }   the next answers of one wire format
 *   GET  /__requests                                                 what the adapters sent
 *   POST /__reset, GET /__health
 *
 * Modes: `success`, `truncated`, `refusal`, `status` (HTTP `status`, with an error body that echoes
 * the received key, to prove adapters never surface error bodies), `hang` (never answers),
 * `malformed` (2xx that is not JSON), `no_usage`, `redirect` (302 to /__redirected, which records a
 * hit), `oversized` (2 MB body).
 */

type Wire = 'anthropic' | 'openai';
type Mode = 'success' | 'truncated' | 'refusal' | 'status' | 'hang' | 'malformed' | 'no_usage' | 'redirect' | 'oversized';
interface Script { mode: Mode; text: string; usage: { input: number; output: number }; cost: number | null; status: number; delayMs: number }
export interface RecordedProviderRequest {
  wire: Wire | 'other'; method: string; path: string; key: string | null; headers: Record<string, string | string[] | undefined>;
  body: unknown; aborted: boolean; at: number;
}

const DEFAULT: Script = { mode: 'success', text: 'Fact: the camera fails below 5 lux [S1].', usage: { input: 1_200, output: 80 }, cost: null, status: 500, delayMs: 0 };
const scripts: Record<Wire, Script> = { anthropic: { ...DEFAULT }, openai: { ...DEFAULT } };
const requests: RecordedProviderRequest[] = [];

function json(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function anthropicAnswer(script: Script, body: { model?: string }) {
  const stop = script.mode === 'truncated' ? 'max_tokens' : script.mode === 'refusal' ? 'refusal' : 'end_turn';
  return { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model,
    content: script.mode === 'refusal' ? [] : [{ type: 'text', text: script.text }], stop_reason: stop, stop_sequence: null,
    ...(script.mode === 'no_usage' ? {} : { usage: { input_tokens: script.usage.input, output_tokens: script.usage.output } }) };
}

function openAiAnswer(script: Script, body: { model?: string }) {
  const refusal = script.mode === 'refusal';
  return { id: `chatcmpl-${Date.now()}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, finish_reason: script.mode === 'truncated' ? 'length' : 'stop',
      message: { role: 'assistant', content: refusal ? null : script.text, ...(refusal ? { refusal: 'I can’t help with that.' } : {}) } }],
    ...(script.mode === 'no_usage' ? {} : { usage: { prompt_tokens: script.usage.input, completion_tokens: script.usage.output,
      total_tokens: script.usage.input + script.usage.output, ...(script.cost === null ? {} : { cost: script.cost }) } }) };
}

const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const url = new URL(request.url ?? '/', 'http://providermock');
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    if (url.pathname === '/__health') return json(response, 200, { ok: true });
    if (url.pathname === '/__requests') return json(response, 200, { requests });
    if (url.pathname === '/__reset') {
      requests.length = 0; scripts.anthropic = { ...DEFAULT }; scripts.openai = { ...DEFAULT };
      return json(response, 200, { ok: true });
    }
    if (url.pathname === '/__script') {
      const patch = body as Partial<Script> & { wire?: Wire | 'all' };
      for (const wire of patch.wire === 'all' || !patch.wire ? ['anthropic', 'openai'] as Wire[] : [patch.wire]) {
        scripts[wire] = { ...DEFAULT, ...patch, usage: { ...DEFAULT.usage, ...patch.usage } };
        delete (scripts[wire] as { wire?: unknown }).wire;
      }
      return json(response, 200, { ok: true });
    }
    const wire: Wire | 'other' = url.pathname.startsWith('/anthropic/') ? 'anthropic' : url.pathname.startsWith('/openai/') ? 'openai' : 'other';
    const key = wire === 'anthropic' ? (request.headers['x-api-key'] as string | undefined) ?? null
      : (request.headers.authorization ?? '').replace(/^Bearer /, '') || null;
    const recorded: RecordedProviderRequest = { wire, method: request.method ?? '', path: url.pathname, key, headers: request.headers, body, aborted: false, at: Date.now() };
    response.on('close', () => { if (!response.writableFinished) recorded.aborted = true; });
    requests.push(recorded);

    if (url.pathname === '/__redirected') return json(response, 200, { redirected: true });
    if (request.method === 'GET' && url.pathname === '/openai/v1/models')
      return json(response, 200, { object: 'list', data: [{ id: 'llama3.1:8b', object: 'model' }, { id: 'qwen2.5:7b-instruct', object: 'model' }, { id: 'not a valid id', object: 'model' }] });
    if (request.method === 'GET' && url.pathname === '/openrouter/v1/models')
      return json(response, 200, { data: [
        { id: 'vendor/priced-model', pricing: { prompt: '0.000003', completion: '0.000015' } },
        { id: 'vendor/free-model:free', pricing: { prompt: '0', completion: '0' } },
        { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
        { id: 'vendor/search-model:online', pricing: { prompt: '0.000001', completion: '0.000001' } },
      ] });
    if (wire === 'other') return json(response, 404, { error: 'not found' });
    const script = scripts[wire];
    const answer = () => {
      if (script.mode === 'hang') return;
      if (script.mode === 'status') return json(response, script.status, wire === 'anthropic'
        ? { type: 'error', error: { type: 'api_error', message: `scripted failure for key ${key}` } }
        : { error: { message: `scripted failure for key ${key}`, type: 'server_error' } }, { 'retry-after': '0', 'x-should-retry': 'true' });
      if (script.mode === 'redirect') { response.writeHead(302, { location: 'http://providermock:8095/__redirected' }); return response.end(); }
      if (script.mode === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(`not json {${key}`); }
      if (script.mode === 'oversized') return json(response, 200, { padding: 'x'.repeat(2_000_000) });
      if (url.pathname === '/anthropic/v1/messages/count_tokens') return json(response, 200, { input_tokens: Math.max(1, Math.ceil(raw.length / 4)) });
      if (url.pathname === '/anthropic/v1/messages') return json(response, 200, anthropicAnswer(script, body as { model?: string }));
      if (url.pathname === '/openai/v1/chat/completions') return json(response, 200, openAiAnswer(script, body as { model?: string }));
      return json(response, 404, { error: 'not found' });
    };
    if (script.delayMs) setTimeout(answer, script.delayMs); else answer();
  });
});

server.listen(8095, '0.0.0.0', () => console.log('provider mock listening on :8095'));
