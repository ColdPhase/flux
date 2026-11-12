import http from 'node:http';
import zlib from 'node:zlib';
import { handleCliVendor } from './cli-vendor-mock.js';

/**
 * TEST ONLY (#179, F-020 PROV-6): a local stand-in for the two AI wire formats, run as the Compose
 * `providermock` service of `scripts/check_application.sh`. It is never a provider: nothing here
 * proves compatibility, billing or model behaviour; it lets one adapter contract suite run the same
 * cases against both wire formats in Docker.
 *
 *   POST /anthropic/v1/messages, /anthropic/v1/messages/count_tokens   Anthropic Messages
 *   POST /openai/v1/chat/completions, GET /openai/v1/models          OpenAI-compatible Chat Completions
 *   POST /openai/v1/responses                                        OpenAI's Responses API (#954)
 *   GET  /openrouter/v1/models                                       a priced model list (OpenRouter's shape)
 *   POST /__script { wire, mode, text, usage, cost, status, delayMs, search }   the next answers of one wire format
 *   GET  /__requests                                                 what the adapters sent
 *   POST /__reset, GET /__health
 *   /cli/…, /__cli/…                                                the REAL Claude Code and Codex of the runtime (#1125, cli-vendor-mock.ts)
 *
 * Modes: `success`, `truncated`, `refusal`, `status` (HTTP `status`, with an error body that echoes
 * the received key, to prove adapters never surface error bodies), `hang` (never answers),
 * `malformed` (2xx that is not JSON), `no_usage`, `redirect` (302 to /__redirected, which records a
 * hit), `oversized` (2 MB body), `paused` (Anthropic: the answer stops with `pause_turn`, the server's own search loop limit, #1116).
 *
 * A request with `stream: true` (#1248) is answered as the provider streams it: the same answer as Server-Sent Events (Anthropic's
 * `message_start` … `message_stop`, the Responses API's `response.output_text.delta` … `response.completed`), its text in small pieces,
 * `streamGapMs` apart (default 5).
 *
 * `search` (#954): the answer also carries the provider's own web search in its wire format: `{ query, results: [url…], cite: url }`
 * becomes a `server_tool_use` and a `web_search_tool_result` block and a text block citing `cite` (`web_search_result_location`), with
 * `usage.server_tool_use.web_search_requests: 1` on Anthropic; a `web_search_call` item with `action.sources` and a message whose
 * `output_text` has a `url_citation` annotation on the Responses API. `errorMessage` gives a `status` answer the provider's own words.
 */

type Wire = 'anthropic' | 'openai';
type Mode = 'success' | 'truncated' | 'refusal' | 'status' | 'hang' | 'malformed' | 'no_usage' | 'redirect' | 'oversized' | 'paused';
interface Search { query: string; results: string[]; cite: string }
interface Script { mode: Mode; text: string; usage: { input: number; output: number }; cost: number | null; status: number; delayMs: number; search: Search | null; errorMessage: string | null; streamGapMs: number; crlf: boolean }
export interface RecordedProviderRequest {
  wire: Wire | 'other'; method: string; path: string; key: string | null; headers: Record<string, string | string[] | undefined>;
  body: unknown; aborted: boolean; at: number;
}

const DEFAULT: Script = { mode: 'success', text: 'Fact: the camera fails below 5 lux [S1].', usage: { input: 1_200, output: 80 }, cost: null, status: 500, delayMs: 0, search: null, errorMessage: null, streamGapMs: 5, crlf: false };
const scripts: Record<Wire, Script> = { anthropic: { ...DEFAULT }, openai: { ...DEFAULT } };
const requests: RecordedProviderRequest[] = [];

function json(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (response.destroyed) return;
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function anthropicAnswer(script: Script, body: { model?: string }) {
  const stop = script.mode === 'truncated' ? 'max_tokens' : script.mode === 'refusal' ? 'refusal' : script.mode === 'paused' ? 'pause_turn' : 'end_turn';
  const search = script.search;
  // The documented shape of a search (docs.claude.com web search tool, read 2026-11-08): the query, the results with their encrypted
  // content, then the answer split around the cited sentence.
  const searched = search ? [
    { type: 'text', text: 'I will search for that.' },
    { type: 'server_tool_use', id: 'srvtoolu_mock_1', name: 'web_search', input: { query: search.query } },
    { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_mock_1', content: search.results.map((url, index) => ({
      type: 'web_search_result', url, title: `Result ${index + 1}`, encrypted_content: `enc-${index}`, page_age: 'November 1, 2026' })) },
    { type: 'text', text: 'Based on the search, ' },
    { type: 'text', text: script.text, citations: [{ type: 'web_search_result_location', url: search.cite, title: 'Cited page', encrypted_index: 'enc-index', cited_text: 'cited words' }] },
    { type: 'text', text: ' That is all.' },
  ] : [{ type: 'text', text: script.text }];
  return { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: body.model,
    content: script.mode === 'refusal' ? [] : searched, stop_reason: stop, stop_sequence: null,
    ...(script.mode === 'no_usage' ? {} : { usage: { input_tokens: script.usage.input, output_tokens: script.usage.output,
      ...(search ? { server_tool_use: { web_search_requests: 1 } } : {}) } }) };
}

/** The Responses API's documented shape (developers.openai.com, read 2026-11-08): output items, `status`, `usage.input_tokens`. */
function responsesAnswer(script: Script, body: { model?: string }) {
  const search = script.search;
  const refusal = script.mode === 'refusal';
  const message = { id: 'msg_mock_1', type: 'message', status: 'completed', role: 'assistant', content: refusal
    ? [{ type: 'refusal', refusal: 'I can’t help with that.' }]
    : [{ type: 'output_text', text: script.text, annotations: search ? [{ type: 'url_citation', start_index: 0, end_index: script.text.length, url: search.cite, title: 'Cited page' }] : [] }] };
  return { id: `resp_${Date.now()}`, object: 'response', model: body.model,
    status: script.mode === 'truncated' ? 'incomplete' : 'completed',
    incomplete_details: script.mode === 'truncated' ? { reason: 'max_output_tokens' } : null,
    output: [
      ...(search ? [{ id: 'ws_mock_1', type: 'web_search_call', status: 'completed', action: { type: 'search', query: search.query,
        sources: search.results.map((url) => ({ type: 'url', url })) } }] : []),
      message,
    ],
    ...(script.mode === 'no_usage' ? {} : { usage: { input_tokens: script.usage.input, output_tokens: script.usage.output, total_tokens: script.usage.input + script.usage.output } }) };
}

/** Words of a text in small pieces, as a provider streams them. */
const textPieces = (text: string) => text.match(/\S*\s*/g)!.filter(Boolean).flatMap((word) => (word.length > 8 ? word.match(/.{1,8}/gs)! : [word]));

/** Writes Server-Sent Events `gapMs` apart, then ends the response (#1248). */
function sse(response: http.ServerResponse, events: { event: string; data: unknown }[], gapMs: number, crlf = false) {
  if (response.destroyed) return;
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let index = 0;
  const next = () => {
    if (response.destroyed) return;
    if (index >= events.length) { response.end(); return; }
    const { event, data } = events[index++]!;
    if (!crlf) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // `crlf`: the line ends a server may write, the last one split across two writes (#1248).
    else { response.write(`event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r`); setTimeout(() => { if (!response.destroyed) response.write('\n'); }, Math.max(1, gapMs / 2)); }
    setTimeout(next, gapMs);
  };
  next();
}

/** An Anthropic answer as its stream: the blocks opened, text in pieces (a citation as its own delta), the stop and usage at the end. */
function anthropicEvents(answer: ReturnType<typeof anthropicAnswer>) {
  const { content, usage, stop_reason } = answer as { content: Record<string, unknown>[]; usage?: Record<string, unknown>; stop_reason: string };
  const events: { event: string; data: unknown }[] = [{ event: 'message_start', data: { type: 'message_start', message: { ...answer, content: [], stop_reason: null,
    ...(usage ? { usage: { input_tokens: usage.input_tokens, output_tokens: 1 } } : {}) } } }];
  content.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { type: 'text', text: '', ...(block.citations ? { citations: [] } : {}) } } });
      for (const citation of (block.citations as unknown[] | undefined) ?? []) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'citations_delta', citation } } });
      for (const text of textPieces(String(block.text))) events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } } });
    } else if (block.type === 'server_tool_use' || block.type === 'tool_use') {
      events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: { ...block, input: {} } } });
      events.push({ event: 'content_block_delta', data: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } } });
    } else events.push({ event: 'content_block_start', data: { type: 'content_block_start', index, content_block: block } });
    events.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index } });
  });
  events.push({ event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: usage ? { output_tokens: usage.output_tokens, ...(usage.server_tool_use ? { server_tool_use: usage.server_tool_use } : {}) } : {} } });
  events.push({ event: 'message_stop', data: { type: 'message_stop' } });
  return events;
}

/** A Responses answer as its stream: created, the message's text in pieces, then the whole response as `response.completed` (or `response.incomplete`). */
function responsesEvents(answer: ReturnType<typeof responsesAnswer>) {
  const { output, status } = answer as { output: { type: string; content?: { type: string; text?: string }[] }[]; status: string };
  const events: { event: string; data: unknown }[] = [{ event: 'response.created', data: { type: 'response.created', sequence_number: 0, response: { ...answer, status: 'in_progress', output: [] } } }];
  for (const item of output) for (const part of item.type === 'message' ? item.content ?? [] : []) if (part.type === 'output_text')
    for (const delta of textPieces(part.text ?? '')) events.push({ event: 'response.output_text.delta', data: { type: 'response.output_text.delta', sequence_number: events.length, item_id: 'msg_mock_1', output_index: 0, content_index: 0, delta } });
  const final = status === 'incomplete' ? 'response.incomplete' : 'response.completed';
  events.push({ event: final, data: { type: final, sequence_number: events.length, response: answer } });
  return events;
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
    // The Anthropic SDK with a bare origin as its base URL (the worker's FLUX_TEST_ANTHROPIC_URL) sends /v1/messages.
    if (url.pathname.startsWith('/v1/messages')) url.pathname = `/anthropic${url.pathname}`;
    // Codex compresses its requests in ChatGPT mode (its `enable_request_compression` feature, #1125): read them as the vendor would.
    const bytes = Buffer.concat(chunks);
    const encoding = String(request.headers['content-encoding'] ?? '').toLowerCase();
    let raw: string;
    try {
      raw = (encoding === 'zstd' ? zlib.zstdDecompressSync(bytes) : encoding === 'gzip' ? zlib.gunzipSync(bytes) : encoding === 'br' ? zlib.brotliDecompressSync(bytes)
        : encoding === 'deflate' ? zlib.inflateSync(bytes) : bytes).toString('utf8');
    } catch { raw = bytes.toString('utf8'); }
    let body: unknown = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    if (url.pathname === '/__health') return json(response, 200, { ok: true });
    if (handleCliVendor(request, response, url, raw, body)) return;
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
      // `errorMessage` (#954): the provider's own words of a refusal, e.g. a web search that is not enabled.
      if (script.mode === 'status') return json(response, script.status, wire === 'anthropic'
        ? { type: 'error', error: { type: script.errorMessage ? 'invalid_request_error' : 'api_error', message: script.errorMessage ?? `scripted failure for key ${key}` } }
        : { error: { message: script.errorMessage ?? `scripted failure for key ${key}`, type: script.errorMessage ? 'invalid_request_error' : 'server_error' } },
        script.errorMessage ? {} : { 'retry-after': '0', 'x-should-retry': 'true' });
      if (script.mode === 'redirect') { response.writeHead(302, { location: 'http://providermock:8095/__redirected' }); return response.end(); }
      if (script.mode === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }); return response.end(`not json {${key}`); }
      if (script.mode === 'oversized') return json(response, 200, { padding: 'x'.repeat(2_000_000) });
      if (url.pathname === '/anthropic/v1/messages/count_tokens') return json(response, 200, { input_tokens: Math.max(1, Math.ceil(raw.length / 4)) });
      const streamed = (body as { stream?: unknown } | null)?.stream === true;
      if (url.pathname === '/anthropic/v1/messages' && streamed) return sse(response, anthropicEvents(anthropicAnswer(script, body as { model?: string })), script.streamGapMs);
      if (url.pathname === '/anthropic/v1/messages') return json(response, 200, anthropicAnswer(script, body as { model?: string }));
      if (url.pathname === '/openai/v1/chat/completions') return json(response, 200, openAiAnswer(script, body as { model?: string }));
      if (url.pathname === '/openai/v1/responses' && streamed) return sse(response, responsesEvents(responsesAnswer(script, body as { model?: string })), script.streamGapMs, script.crlf);
      if (url.pathname === '/openai/v1/responses') return json(response, 200, responsesAnswer(script, body as { model?: string }));
      return json(response, 404, { error: 'not found' });
    };
    if (script.delayMs) setTimeout(answer, script.delayMs); else answer();
  });
});

server.listen(8095, '0.0.0.0', () => console.log('provider mock listening on :8095'));
