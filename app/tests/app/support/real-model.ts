import type http from 'node:http';
import { randomBytes } from 'node:crypto';

/**
 * TEST ONLY (scripts/check_ai_real_model.sh): the model hosts of the REAL Claude Code and Codex answered by a REAL local model (an
 * OpenAI-compatible Chat Completions server: on Hubert's host the `strata` container, a llama.cpp-based engine on the GPU) instead of the
 * scripted steps of cli-vendor-mock.ts. `providermock` runs it when `FLUX_CLI_REAL_MODEL_URL` is set; sign-in, token refresh, usage and
 * every other vendor endpoint stay the mock's. Never a provider and never deployed.
 *
 * What it changes between the CLI and the model, and nothing else:
 * - Wire format. Claude Code's Anthropic Messages and Codex's OpenAI Responses requests become one Chat Completions request (the model's own
 *   chat template and tool-call parser), and the answer goes back in the vendor's streamed format. The CLIs' system prompts, Flux's brief and
 *   tool list, the tool results and the CLI's own history pass unchanged, as text. The stream opens at once and carries the vendor's
 *   keepalives (Anthropic `ping`, Responses `response.in_progress`) while the local model works, so a slow model does not trip a CLI's
 *   idle timeout.
 * - Sampling: temperature 0 and a fixed seed on every request, and at most `MAX_OUTPUT` tokens out (a guard against a greedy loop).
 * - Web search, which a vendor runs on its side: Claude Code's `WebSearch` sub-request (Anthropic's `web_search` server tool) and Codex's
 *   standalone `web.run` (`alpha/search`) are answered from linkmock's Polish fixture corpus (`GET /__search`, web-corpus-pl.ts), in the
 *   vendor's own result format: result entries with their addresses, and a text with each result's opening words.
 * Every exchange is kept in memory for the evidence (`GET /__real/transcript?since=n`); Flux itself keeps no transcript (RT-5).
 */

type Json = Record<string, unknown>;
const MODEL_URL = (process.env.FLUX_CLI_REAL_MODEL_URL ?? '').replace(/\/+$/, '');
/** The local server's own key (strata always wants one). Not a vendor credential; never logged or kept in the transcript. */
const MODEL_KEY = process.env.FLUX_CLI_REAL_MODEL_KEY ?? '';
const KEEPALIVE_MS = 10_000;
const SEARCH_URL = process.env.FLUX_CLI_REAL_SEARCH_URL ?? 'http://linkmock:8098/__search';
const SEED = Number(process.env.FLUX_CLI_REAL_SEED ?? '42');
export const MAX_OUTPUT = Number(process.env.FLUX_CLI_REAL_MAX_OUTPUT ?? '12000');
export const realModelOn = () => MODEL_URL !== '';

interface ChatMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; reasoning_content?: string; tool_calls?: ChatCall[]; tool_call_id?: string }
interface ChatCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface ChatTool { type: 'function'; function: { name: string; description: string; parameters: unknown } }
interface ChatAnswer { content: string; reasoning: string; calls: ChatCall[]; finish: string; usage: { input: number; output: number; cached: number } }

export interface TranscriptEntry {
  n: number; at: number; ms: number; client: 'claude' | 'codex'; kind: 'main' | 'side' | 'web_search' | 'error';
  /** What went to the model (the converted Chat Completions request), or the search query. */
  request: unknown;
  /** What the model answered (or the search results), before it went back to the CLI in the vendor's format. */
  response: unknown;
  /** What the CLI asked for that the conversion does not carry (Claude Code's model, thinking and output limit). */
  vendor?: unknown;
}
const transcript: TranscriptEntry[] = [];
let counter = 0;
const id = (prefix: string) => `${prefix}_${randomBytes(10).toString('hex')}`;

/** The model's reasoning before a tool call, kept here by the call's id: a CLI that drops it gets it back on its next request (gpt-oss wants it). */
const reasoningOf = new Map<string, string>();

const textOf = (content: unknown): string => typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((part) => typeof part === 'string' ? part
    : typeof (part as Json).text === 'string' ? (part as Json).text as string
      : textOf((part as Json).content)).filter(Boolean).join('\n') : '';

const auth = (): Record<string, string> => (MODEL_KEY ? { authorization: `Bearer ${MODEL_KEY}` } : {});
let modelName: Promise<string> | null = null;
/** The server's own model name, from its `/v1/models` (once). */
function served(): Promise<string> {
  modelName ??= fetch(`${MODEL_URL}/v1/models`, { headers: auth() }).then(async (response) => {
    const listed = ((await response.json()) as { data?: { id?: string }[] }).data ?? [];
    return listed[0]?.id ?? 'local';
  }).catch(() => 'local');
  return modelName;
}

/** The model's reasoning or words as they arrive, for a CLI that shows them while the model works. */
type Delta = (part: 'reasoning' | 'content', text: string) => void;

/**
 * Reads a Chat Completions event stream into one message, telling `onDelta` the reasoning and the words as they come. Words that begin
 * with `<think>` (a server that leaves the thinking in the content) are not passed on: they are sorted out when the message is whole.
 */
async function readStream(response: Response, onDelta: Delta | undefined): Promise<Json> {
  if (!(response.headers.get('content-type') ?? '').includes('event-stream')) return (await response.json()) as Json;
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finish = 'stop';
  let usage: Json = {};
  let timings: Json = {};
  let plain: boolean | null = null;
  let passed = 0;
  const calls: { id: string; name: string; arguments: string }[] = [];
  const take = (event: Json) => {
    const choice = ((event.choices as Json[] | undefined) ?? [])[0];
    if (event.usage) usage = event.usage as Json;
    if (event.timings) timings = event.timings as Json;
    if (!choice) return;
    if (choice.finish_reason) finish = String(choice.finish_reason);
    const delta = (choice.delta ?? {}) as Json;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) { reasoning += delta.reasoning_content; onDelta?.('reasoning', delta.reasoning_content); }
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      const opening = content.trimStart();
      if (plain === null && (opening.length >= 7 || (opening.length > 0 && !'<think>'.startsWith(opening)))) plain = !opening.startsWith('<think>');
      if (plain) { onDelta?.('content', content.slice(passed)); passed = content.length; }
    }
    for (const call of (delta.tool_calls as Json[] | undefined) ?? []) {
      const index = Number(call.index ?? calls.length);
      const fn = (call.function ?? {}) as Json;
      calls[index] ??= { id: '', name: '', arguments: '' };
      if (typeof call.id === 'string' && call.id) calls[index].id = call.id;
      if (typeof fn.name === 'string') calls[index].name += fn.name;
      if (typeof fn.arguments === 'string') calls[index].arguments += fn.arguments;
    }
  };
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data && data !== '[DONE]') { try { take(JSON.parse(data) as Json); } catch { /* a keepalive or a comment */ } }
    }
  }
  return { choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content, reasoning_content: reasoning,
    tool_calls: calls.filter(Boolean).map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } }], usage, timings };
}

async function chat(client: 'claude' | 'codex', kind: 'main' | 'side', body: { messages: ChatMessage[]; tools: ChatTool[]; maxTokens: number; toolChoice?: unknown },
  onDelta?: Delta, vendor?: Json): Promise<ChatAnswer> {
  // A CLI's history without the reasoning of its earlier tool calls gets it back from what this shim saw.
  for (const message of body.messages) {
    if (message.role === 'assistant' && !message.reasoning_content && message.tool_calls?.length) {
      const kept = message.tool_calls.map((call) => reasoningOf.get(call.id)).find(Boolean);
      if (kept) message.reasoning_content = kept;
    }
  }
  const request: Json = {
    model: await served(), messages: body.messages, stream: true, stream_options: { include_usage: true }, temperature: 0, seed: SEED,
    max_tokens: Math.min(body.maxTokens || MAX_OUTPUT, MAX_OUTPUT),
    ...(body.tools.length ? { tools: body.tools, tool_choice: body.toolChoice ?? 'auto', parallel_tool_calls: false } : {}),
  };
  const started = Date.now();
  const response = await fetch(`${MODEL_URL}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify(request) });
  let answer: Json;
  if (!response.ok) {
    const raw = await response.text();
    try { answer = JSON.parse(raw) as Json; } catch { answer = { error: { message: raw } }; }
  } else answer = await readStream(response, onDelta);
  transcript.push({ n: ++counter, at: started, ms: Date.now() - started, client, kind: response.ok ? kind : 'error', request, response: answer, ...(vendor ? { vendor } : {}) });
  if (!response.ok) throw Object.assign(new Error(String((answer.error as Json | undefined)?.message ?? JSON.stringify(answer))), { status: response.status });
  const choice = ((answer.choices as Json[] | undefined) ?? [])[0] ?? {};
  const message = (choice.message ?? {}) as Json;
  const calls = ((message.tool_calls as ChatCall[] | undefined) ?? []).map((call) => ({ id: call.id || id('call'), type: 'function' as const,
    function: { name: call.function.name, arguments: call.function.arguments || '{}' } }));
  // A server that leaves the model's thinking in the content (`<think>…</think>`) gets it moved where a reasoning field would have put it.
  let content = typeof message.content === 'string' ? message.content : '';
  let reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const thought = /^\s*<think>([\s\S]*?)<\/think>\s*/.exec(content);
  if (thought) { reasoning = [reasoning, thought[1]!.trim()].filter(Boolean).join('\n'); content = content.slice(thought[0].length); }
  for (const call of calls) if (reasoning) reasoningOf.set(call.id, reasoning);
  const usage = (answer.usage ?? {}) as Json;
  const timings = (answer.timings ?? {}) as Json;
  return { content, reasoning, calls, finish: String(choice.finish_reason ?? 'stop'),
    usage: { input: Number(usage.prompt_tokens ?? 0), output: Number(usage.completion_tokens ?? 0), cached: Number(timings.cache_n ?? 0) } };
}

interface Hit { url: string; title: string; snippet: string }
async function search(client: 'claude' | 'codex', query: string): Promise<Hit[]> {
  const started = Date.now();
  const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`);
  const hits = ((await response.json()) as { results: Hit[] }).results;
  transcript.push({ n: ++counter, at: started, ms: Date.now() - started, client, kind: 'web_search', request: { query }, response: hits });
  return hits;
}
/** What a vendor's search tells the model besides the addresses: each result's title, address and opening words. */
const searchText = (query: string, hits: Hit[]) => hits.length
  ? `Search results for "${query}":\n${hits.map((hit, index) => `${index + 1}. ${hit.title} (${hit.url}): ${hit.snippet}`).join('\n')}`
  : `No results for "${query}".`;

/** A vendor's event stream, opened before the model answers; `keepalive` sends the vendor's own idle event until it is closed. */
class Stream {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly response: http.ServerResponse) {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  }
  event(name: string, data: unknown) { if (!this.response.destroyed) this.response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); }
  keepalive(name: string, data: unknown) { this.timer = setInterval(() => this.event(name, data), KEEPALIVE_MS); }
  end() { if (this.timer) clearInterval(this.timer); this.timer = null; this.response.end(); }
}
function sse(response: http.ServerResponse, events: [string, unknown][]) {
  const stream = new Stream(response);
  for (const [name, data] of events) stream.event(name, data);
  stream.end();
}

// --- Claude Code: Anthropic Messages ⇄ Chat Completions.

function anthropicToChat(body: Json): { messages: ChatMessage[]; tools: ChatTool[] } {
  const system = textOf(body.system);
  const messages: ChatMessage[] = system ? [{ role: 'system', content: system }] : [];
  for (const message of (Array.isArray(body.messages) ? body.messages : []) as Json[]) {
    const blocks = (typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : Array.isArray(message.content) ? message.content : []) as Json[];
    if (message.role === 'assistant') {
      const calls = blocks.filter((block) => block.type === 'tool_use').map((block) => ({ id: String(block.id), type: 'function' as const,
        function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) } }));
      const reasoning = blocks.filter((block) => block.type === 'thinking').map((block) => String(block.thinking ?? '')).join('\n');
      messages.push({ role: 'assistant', content: blocks.filter((block) => block.type === 'text').map((block) => String(block.text)).join('\n'),
        ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    for (const block of blocks.filter((item) => item.type === 'tool_result'))
      messages.push({ role: 'tool', tool_call_id: String(block.tool_use_id), content: `${block.is_error ? 'Error: ' : ''}${textOf(block.content)}` });
    const words = blocks.filter((block) => block.type === 'text').map((block) => String(block.text)).join('\n');
    if (words) messages.push({ role: 'user', content: words });
  }
  const tools = ((Array.isArray(body.tools) ? body.tools : []) as Json[]).filter((tool) => !tool.type || tool.type === 'custom')
    .map((tool) => ({ type: 'function' as const, function: { name: String(tool.name), description: String(tool.description ?? ''), parameters: tool.input_schema ?? { type: 'object' } } }));
  return { messages, tools };
}

const usageOf = (answer: ChatAnswer) => ({ input_tokens: answer.usage.input, output_tokens: answer.usage.output, cache_read_input_tokens: answer.usage.cached, cache_creation_input_tokens: 0 });

const messageStart = (model: string) => ({ type: 'message_start', message: { id: id('msg'), type: 'message', role: 'assistant', content: [], model,
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

/**
 * An Anthropic message's content blocks, written as the model's output arrives: its thinking (when the request asked for thinking) and its
 * words stream as deltas, as the API's do; the rest of the answer, and the tool calls, come when the model is done.
 */
class Blocks {
  private index = 0;
  private open: 'thinking' | 'text' | null = null;
  private said = { thinking: '', text: '' };
  constructor(private readonly stream: Stream, private readonly thinking: boolean) {}
  private start(block: Json) { this.stream.event('content_block_start', { type: 'content_block_start', index: this.index, content_block: block }); }
  private delta(delta: Json) { this.stream.event('content_block_delta', { type: 'content_block_delta', index: this.index, delta }); }
  private close() {
    if (!this.open) return;
    if (this.open === 'thinking') this.delta({ type: 'signature_delta', signature: 'local-model' });
    this.stream.event('content_block_stop', { type: 'content_block_stop', index: this.index });
    this.index += 1;
    this.open = null;
  }
  /** Part of the model's reasoning or words. */
  add(part: 'reasoning' | 'content', text: string) {
    if (!text) return;
    const kind = part === 'reasoning' ? 'thinking' : 'text';
    if (kind === 'thinking' && (!this.thinking || this.said.text)) return;
    if (this.open !== kind) { this.close(); this.start(kind === 'thinking' ? { type: 'thinking', thinking: '', signature: '' } : { type: 'text', text: '' }); this.open = kind; }
    this.delta(kind === 'thinking' ? { type: 'thinking_delta', thinking: text } : { type: 'text_delta', text });
    this.said[kind] += text;
  }
  /** The whole answer: what did not stream yet, the tool calls, and the end of the message. */
  finish(answer: ChatAnswer) {
    if (answer.reasoning.startsWith(this.said.thinking)) this.add('reasoning', answer.reasoning.slice(this.said.thinking.length));
    if (answer.content.startsWith(this.said.text)) this.add('content', answer.content.slice(this.said.text.length));
    this.close();
    for (const call of answer.calls) {
      this.start({ type: 'tool_use', id: call.id, name: call.function.name, input: {} });
      this.delta({ type: 'input_json_delta', partial_json: call.function.arguments });
      this.stream.event('content_block_stop', { type: 'content_block_stop', index: this.index });
      this.index += 1;
    }
    if (this.index === 0) { this.start({ type: 'text', text: '' }); this.stream.event('content_block_stop', { type: 'content_block_stop', index: 0 }); }
    const stop = answer.calls.length ? 'tool_use' : answer.finish === 'length' ? 'max_tokens' : 'end_turn';
    this.stream.event('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: usageOf(answer) });
    this.stream.event('message_stop', { type: 'message_stop' });
  }
}

/** Claude Code's `WebSearch` runs as a sub-request with Anthropic's `web_search` server tool: Anthropic searches, here the corpus does. */
async function claudeSearch(response: http.ServerResponse, body: Json) {
  const model = String(body.model ?? 'local');
  const asked = textOf(((body.messages as Json[] | undefined) ?? []).at(-1)?.content);
  const query = (/query:\s*([^\n]+)/i.exec(asked)?.[1] ?? asked).trim();
  const hits = await search('claude', query);
  const useId = id('srvtoolu');
  sse(response, [
    ['message_start', { type: 'message_start', message: { id: id('msg'), type: 'message', role: 'assistant', content: [], model, stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: useId, name: 'web_search', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: useId,
      content: hits.map((hit) => ({ type: 'web_search_result', url: hit.url, title: hit.title, encrypted_content: 'local-corpus', page_age: null })) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: searchText(query, hits) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40, server_tool_use: { web_search_requests: 1 } } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

/** A failed model request, in the vendor's words, on the stream that is already open: Anthropic's `error` event, Responses' `response.failed`. */
function failed(stream: Stream, client: 'claude' | 'codex', error: unknown, responseId: string) {
  const message = error instanceof Error ? error.message : String(error);
  const tooLong = /context|too long|exceed/i.test(message);
  if (client === 'claude') stream.event('error', { type: 'error', error: { type: tooLong ? 'invalid_request_error' : 'overloaded_error', message: tooLong ? `prompt is too long: ${message}` : message } });
  else stream.event('response.failed', { type: 'response.failed', response: { id: responseId, error: { code: tooLong ? 'context_length_exceeded' : 'server_error', message } } });
  stream.end();
}

export async function claudeReal(response: http.ServerResponse, body: Json): Promise<void> {
  const tools = (Array.isArray(body.tools) ? body.tools : []) as Json[];
  if (tools.some((tool) => String(tool.type ?? '').startsWith('web_search_'))) return claudeSearch(response, body);
  const stream = new Stream(response);
  stream.event('message_start', messageStart(String(body.model ?? 'local')));
  stream.keepalive('ping', { type: 'ping' });
  try {
    const { messages, tools: chatTools } = anthropicToChat(body);
    const side = !chatTools.some((tool) => tool.function.name.startsWith('mcp__flux__') || tool.function.name === 'WebSearch');
    const choice = body.tool_choice as Json | undefined;
    const toolChoice = choice?.type === 'any' ? 'required' : choice?.type === 'tool' ? { type: 'function', function: { name: choice.name } } : 'auto';
    const thinking = typeof body.thinking === 'object' && body.thinking !== null && (body.thinking as Json).type !== 'disabled';
    const blocks = new Blocks(stream, thinking);
    const answer = await chat('claude', side ? 'side' : 'main', { messages, tools: chatTools, maxTokens: Number(body.max_tokens ?? MAX_OUTPUT), toolChoice },
      (part, text) => blocks.add(part, text), { model: body.model ?? null, thinking: body.thinking ?? null, max_tokens: body.max_tokens ?? null });
    blocks.finish(answer);
    stream.end();
  } catch (error) {
    failed(stream, 'claude', error, '');
  }
}

// --- Codex: OpenAI Responses ⇄ Chat Completions.

/** A Responses tool by its flat Chat Completions name: Codex groups tools in namespaces (`mcp__flux`, `web`), a chat template does not. */
type Named = { name: string; namespace: string | null };
const FLAT = '__';

function codexTools(body: Json): { tools: ChatTool[]; names: Map<string, Named>; skipped: string[] } {
  const groups = [...(Array.isArray(body.tools) ? body.tools : []),
    ...((Array.isArray(body.input) ? body.input : []) as Json[]).filter((item) => item.type === 'additional_tools').flatMap((item) => (Array.isArray(item.tools) ? item.tools : []))] as Json[];
  const tools: ChatTool[] = [];
  const names = new Map<string, Named>();
  const skipped: string[] = [];
  const walk = (list: Json[], namespace: string | null) => {
    for (const tool of list) {
      if (Array.isArray(tool.tools)) { walk(tool.tools as Json[], String(tool.name)); continue; }
      if ((tool.type ?? 'function') !== 'function' || typeof tool.name !== 'string') { skipped.push(String(tool.name ?? tool.type)); continue; }
      const flat = namespace ? `${namespace}${FLAT}${tool.name}` : tool.name;
      names.set(flat, { name: tool.name, namespace });
      tools.push({ type: 'function', function: { name: flat, description: String(tool.description ?? ''), parameters: tool.parameters ?? { type: 'object', properties: {} } } });
    }
  };
  walk(groups, null);
  return { tools, names, skipped };
}

function responsesToChat(body: Json): ChatMessage[] {
  const system: string[] = [];
  if (typeof body.instructions === 'string' && body.instructions.trim()) system.push(body.instructions);
  const messages: ChatMessage[] = [];
  let pendingReasoning = '';
  for (const item of (Array.isArray(body.input) ? body.input : []) as Json[]) {
    const type = item.type ?? (item.role ? 'message' : '');
    if (type === 'message') {
      const words = textOf(item.content);
      if (item.role === 'developer' || item.role === 'system') system.push(words);
      else if (item.role === 'assistant') { messages.push({ role: 'assistant', content: words, ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}) }); pendingReasoning = ''; }
      else messages.push({ role: 'user', content: words });
    } else if (type === 'reasoning') {
      pendingReasoning = [textOf(item.content), textOf(item.summary)].find((value) => value.trim()) ?? '';
    } else if (type === 'function_call' || type === 'custom_tool_call') {
      const flat = item.namespace ? `${String(item.namespace)}${FLAT}${String(item.name)}` : String(item.name);
      const call: ChatCall = { id: String(item.call_id), type: 'function', function: { name: flat, arguments: String(item.arguments ?? item.input ?? '{}') } };
      const last = messages.at(-1);
      if (last?.role === 'assistant' && last.tool_calls && !last.content) last.tool_calls.push(call);
      else messages.push({ role: 'assistant', content: '', tool_calls: [call], ...(pendingReasoning ? { reasoning_content: pendingReasoning } : {}) });
      pendingReasoning = '';
    } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
      const output = item.output;
      messages.push({ role: 'tool', tool_call_id: String(item.call_id), content: typeof output === 'string' ? output : textOf(output) || JSON.stringify(output) });
    }
  }
  return [...(system.length ? [{ role: 'system' as const, content: system.join('\n\n') }] : []), ...messages];
}

export async function codexReal(response: http.ServerResponse, body: Json): Promise<void> {
  const responseId = id('resp');
  const stream = new Stream(response);
  stream.event('response.created', { type: 'response.created', response: { id: responseId, status: 'in_progress' } });
  stream.keepalive('response.in_progress', { type: 'response.in_progress', response: { id: responseId, status: 'in_progress' } });
  try {
    const { tools, names } = codexTools(body);
    // Codex's `reasoning.effort` names an OpenAI model's setting; the local model thinks as its own chat template says.
    const answer = await chat('codex', 'main', { messages: responsesToChat(body), tools, maxTokens: Number(body.max_output_tokens ?? MAX_OUTPUT) }, undefined,
      { model: body.model ?? null, reasoning: body.reasoning ?? null, max_output_tokens: body.max_output_tokens ?? null });
    const items: Json[] = [];
    if (answer.reasoning) items.push({ type: 'reasoning', id: id('rs'), summary: [{ type: 'summary_text', text: answer.reasoning }], content: [{ type: 'reasoning_text', text: answer.reasoning }], encrypted_content: null });
    if (answer.content.trim()) items.push({ type: 'message', role: 'assistant', id: id('msg'), status: 'completed', content: [{ type: 'output_text', text: answer.content, annotations: [] }] });
    for (const call of answer.calls) {
      const named = names.get(call.function.name) ?? { name: call.function.name, namespace: null };
      items.push({ type: 'function_call', id: id('fc'), call_id: call.id, name: named.name, arguments: call.function.arguments, status: 'completed',
        ...(named.namespace ? { namespace: named.namespace } : {}) });
    }
    if (!items.length) items.push({ type: 'message', role: 'assistant', id: id('msg'), status: 'completed', content: [{ type: 'output_text', text: '', annotations: [] }] });
    items.forEach((item, index) => {
      stream.event('response.output_item.added', { type: 'response.output_item.added', output_index: index, item });
      stream.event('response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
    });
    stream.event('response.completed', { type: 'response.completed', response: { id: responseId, status: answer.finish === 'length' ? 'incomplete' : 'completed',
      usage: { input_tokens: answer.usage.input, input_tokens_details: { cached_tokens: answer.usage.cached }, output_tokens: answer.usage.output,
        output_tokens_details: { reasoning_tokens: 0 }, total_tokens: answer.usage.input + answer.usage.output } } });
    stream.end();
  } catch (error) {
    failed(stream, 'codex', error, responseId);
  }
}

/** The last search results Codex was given, by `ref_id`: an `open` of `turn0search1` means the second. */
let lastHits: Hit[] = [];
const PAGE_ORIGIN = process.env.FLUX_CLI_REAL_PAGES_URL ?? 'http://linkmock:8098';

/** A page of the corpus as the cached index would give it: its text, without markup. Only `public.test` is in this index. */
async function openPage(target: string): Promise<{ url: string; title: string; text: string } | null> {
  const hit = /^turn\d+search(\d+)$/.exec(target);
  const url = hit ? lastHits[Number(hit[1])]?.url : target;
  if (!url) return null;
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); } catch { return null; }
  if (parsedUrl.hostname !== 'public.test') return null;
  const started = Date.now();
  const html = await (await fetch(`${PAGE_ORIGIN}${parsedUrl.pathname}`)).text();
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? url;
  const text = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
  transcript.push({ n: ++counter, at: started, ms: Date.now() - started, client: 'codex', kind: 'web_search', request: { open: target }, response: { url, title, chars: text.length } });
  return { url, title, text };
}

/**
 * Codex's `web.run` (`alpha/search`): every `q` of its commands searched in the corpus, and every `open` (a result's `ref_id` or an address)
 * read from it, as OpenAI's cached index would answer (`external_web_access: false`: an address outside the index gives nothing).
 */
export async function codexSearchReal(response: http.ServerResponse, body: Json): Promise<void> {
  const queries: string[] = [];
  const opens: string[] = [];
  const walk = (value: unknown, key = '') => {
    if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === 'object') for (const [inner, item] of Object.entries(value)) walk(item, inner === 'q' || inner === 'ref_id' || inner === 'url' ? inner : key || inner);
    else if (typeof value === 'string' && key === 'q') queries.push(value);
    else if (typeof value === 'string' && (key === 'ref_id' || key === 'url')) opens.push(value);
  };
  walk(body.commands ?? body);
  const hits: Hit[] = [];
  for (const query of queries) for (const hit of await search('codex', query)) if (!hits.some((known) => known.url === hit.url)) hits.push(hit);
  if (hits.length) lastHits = hits;
  const pages = (await Promise.all([...new Set(opens)].map(openPage))).filter((page): page is NonNullable<typeof page> => page !== null);
  const output = [...queries.map((query) => searchText(query, hits)),
    ...pages.map((page) => `${page.title} (${page.url}):\n${page.text.slice(0, 8000)}`),
    ...opens.filter((target) => !pages.some((page) => page.url === target || target.startsWith('turn'))).map((target) => `${target}: not in the index.`)].join('\n\n');
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ output: output || 'Nothing to search.',
    results: [...hits.map((hit, index) => ({ type: 'text_result', ref_id: `turn0search${index}`, url: hit.url, title: hit.title, snippet: hit.snippet })),
      ...pages.map((page) => ({ type: 'text_result', ref_id: page.url, url: page.url, title: page.title, snippet: page.text.slice(0, 300) }))] }));
}

/** `GET /__real/transcript?since=n`: the exchanges after `n`, for the evidence. */
export function realTranscript(since: number): TranscriptEntry[] {
  return transcript.filter((entry) => entry.n > since);
}
