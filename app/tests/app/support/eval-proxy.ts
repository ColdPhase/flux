import http from 'node:http';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';

/**
 * TEST ONLY (#1295): the answer-accuracy evaluation's window on what Flux's API-key engine sends to Anthropic, run as the Compose
 * `evalproxy` service of scripts/check_ai_eval.sh (docker/compose.ai-eval.test.yaml). The worker's Anthropic adapter is pointed here
 * (FLUX_TEST_ANTHROPIC_PROXY_URL) and every request goes on, unchanged, to the real API with the owner's key the worker put on it. It
 * changes nothing in a request or an answer; it only:
 *
 * - records each Messages request (its body, without any header) and what came back (usage, stop reason, text, tool calls) under
 *   FLUX_EVAL_LOG_DIR, tagged with the question being asked (`POST /__eval/tag`), so the evaluation can score the tools a run used and
 *   the cost of every question from the provider's own usage;
 * - stops the run at its money cap (FLUX_EVAL_CAP_USD): once the requests it let through reach the cap, the next one is answered as
 *   Anthropic answers an organisation without credit (HTTP 400, "credit balance"), which Flux ends as `no_credits`, billed nothing.
 *
 * The key is never read, logged or kept: the Authorization header is passed through and dropped with the request.
 *
 *   POST /v1/messages, /v1/messages/count_tokens   forwarded to FLUX_EVAL_UPSTREAM (default https://api.anthropic.com)
 *   POST /__eval/tag { tag }                        later requests belong to this tag (a question id, or `judge:<id>`)
 *   GET  /__eval/ledger?tag=                        what that tag's requests cost and did; without a tag, the run's total
 *   GET  /__health
 */

const upstream = (process.env.FLUX_EVAL_UPSTREAM ?? 'https://api.anthropic.com').replace(/\/$/, '');
const cap = Number(process.env.FLUX_EVAL_CAP_USD ?? '0');
const logDir = process.env.FLUX_EVAL_LOG_DIR ?? '/evidence/proxy';
const port = Number(process.env.FLUX_EVAL_PROXY_PORT ?? '8099');

/**
 * Dollars per million tokens, read from Anthropic's pricing (platform.claude.com, the claude-api reference of 2026-11-03): Haiku 5.5
 * costs $0.10 / $0.50 for prompts up to 100k tokens and $0.50 / $2.50 above. Cache reads 0.1x input, five-minute cache writes 1.25x.
 * A model not listed here is refused, so nothing is spent at an unknown price.
 */
const PRICES: Record<string, { input: number; output: number; long?: { above: number; input: number; output: number } }> = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, long: { above: 100_000, input: 0.50, output: 2.50 } },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-opus-5-5': { input: 4, output: 20 },
};

interface Usage { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number } | null }
interface Call { name: string; input: unknown }
interface Entry {
  n: number; tag: string; at: string; path: string; model: string; stream: boolean; status: number; ms: number; firstByteMs: number | null;
  usage: Usage | null; costUsd: number; stopReason: string | null; text: string; calls: Call[]; refused?: string;
}

let tag = 'untagged';
let sequence = 0;
let spent = 0;
const entries: Entry[] = [];

export function costOf(model: string, usage: Usage | null): number {
  const price = PRICES[model];
  if (!price || !usage) return 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const prompt = (usage.input_tokens ?? 0) + cacheRead + cacheWrite;
  const rate = price.long && prompt > price.long.above ? price.long : price;
  return ((usage.input_tokens ?? 0) * rate.input + cacheRead * rate.input * 0.1 + cacheWrite * rate.input * 1.25 + (usage.output_tokens ?? 0) * rate.output) / 1e6
    + (usage.server_tool_use?.web_search_requests ?? 0) * 0.01;
}

/** The answer's usage, stop reason, text and tool calls, from a whole JSON answer or from its Server-Sent Events. */
export function readAnswer(body: string, stream: boolean): { usage: Usage | null; stopReason: string | null; text: string; calls: Call[] } {
  if (!stream) {
    try {
      const message = JSON.parse(body) as { usage?: Usage; stop_reason?: string; content?: { type: string; text?: string; name?: string; input?: unknown }[] };
      const content = message.content ?? [];
      return { usage: message.usage ?? null, stopReason: message.stop_reason ?? null, text: content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join(''),
        calls: content.filter((block) => block.type === 'tool_use').map((block) => ({ name: block.name ?? '', input: block.input ?? null })) };
    } catch { return { usage: null, stopReason: null, text: '', calls: [] }; }
  }
  let usage: Usage | null = null;
  let stopReason: string | null = null;
  const blocks: { type: string; text: string; name?: string; json: string }[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(line.slice(5).trim()) as Record<string, unknown>; } catch { continue; }
    if (event.type === 'message_start') usage = { ...((event.message as { usage?: Usage }).usage ?? {}) };
    else if (event.type === 'content_block_start') {
      const block = event.content_block as { type: string; name?: string; text?: string };
      blocks[event.index as number] = { type: block.type, text: block.text ?? '', ...(block.name ? { name: block.name } : {}), json: '' };
    } else if (event.type === 'content_block_delta') {
      const delta = event.delta as { type: string; text?: string; partial_json?: string };
      const block = blocks[event.index as number];
      if (!block) continue;
      if (delta.type === 'text_delta') block.text += delta.text ?? '';
      if (delta.type === 'input_json_delta') block.json += delta.partial_json ?? '';
    } else if (event.type === 'message_delta') {
      stopReason = ((event.delta as { stop_reason?: string }).stop_reason) ?? stopReason;
      usage = { ...(usage ?? {}), ...((event.usage as Usage | undefined) ?? {}) };
    }
  }
  const parse = (json: string) => { try { return json ? JSON.parse(json) as unknown : {}; } catch { return json; } };
  return { usage, stopReason, text: blocks.filter((block) => block?.type === 'text').map((block) => block.text).join(''),
    calls: blocks.filter((block) => block?.type === 'tool_use').map((block) => ({ name: block.name ?? '', input: parse(block.json) })) };
}

function summary(of: Entry[]) {
  const sum = (pick: (entry: Entry) => number) => of.reduce((total, entry) => total + pick(entry), 0);
  return {
    requests: of.filter((entry) => entry.path.endsWith('/messages')).length,
    inputTokens: sum((entry) => entry.usage?.input_tokens ?? 0), outputTokens: sum((entry) => entry.usage?.output_tokens ?? 0),
    cacheReadTokens: sum((entry) => entry.usage?.cache_read_input_tokens ?? 0), cacheWriteTokens: sum((entry) => entry.usage?.cache_creation_input_tokens ?? 0),
    costUsd: sum((entry) => entry.costUsd), modelMs: sum((entry) => entry.ms), refused: of.filter((entry) => entry.refused).length,
    models: [...new Set(of.map((entry) => entry.model).filter(Boolean))],
    turns: of.filter((entry) => entry.path.endsWith('/messages')).map((entry) => ({ n: entry.n, status: entry.status, ms: entry.ms, firstByteMs: entry.firstByteMs,
      stopReason: entry.stopReason, usage: entry.usage, costUsd: entry.costUsd, calls: entry.calls, text: entry.text })),
  };
}

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};
const readBody = (request: http.IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => resolve(Buffer.concat(chunks)));
  request.on('error', reject);
});
/** Headers that belong to one hop, or that this proxy sets itself. */
const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'content-encoding']);

async function forward(request: http.IncomingMessage, response: http.ServerResponse, path: string) {
  const raw = await readBody(request);
  let body: { model?: string; stream?: boolean; max_tokens?: number } = {};
  try { body = JSON.parse(raw.toString('utf8')) as typeof body; } catch { /* sent on as it came */ }
  const model = body.model ?? '';
  const n = ++sequence;
  const isMessages = path === '/v1/messages';
  const entry: Entry = { n, tag, at: new Date().toISOString(), path, model, stream: body.stream === true, status: 0, ms: 0, firstByteMs: null, usage: null, costUsd: 0,
    stopReason: null, text: '', calls: [] };
  if (isMessages) {
    const price = PRICES[model];
    // The most this request can cost: its body as input tokens (about 3 characters a token at the least) and all of max_tokens.
    const worst = price ? (raw.length / 3 * (price.long?.input ?? price.input) + (body.max_tokens ?? 4_000) * (price.long?.output ?? price.output)) / 1e6 : Infinity;
    const refusal = !price ? `model ${model} has no price in the evaluation's table` : spent + worst > cap ? `the evaluation's cap of $${cap.toFixed(2)} (spent $${spent.toFixed(4)})` : null;
    if (refusal) {
      entry.status = 400;
      entry.refused = refusal;
      entries.push(entry);
      await appendFile(`${logDir}/proxy.jsonl`, `${JSON.stringify(entry)}\n`);
      return json(response, 400, { type: 'error', error: { type: 'invalid_request_error', message: `Your credit balance is too low: ${refusal}.` } });
    }
    await writeFile(`${logDir}/requests/${String(n).padStart(5, '0')}-${tag.replace(/[^a-z0-9:_-]/gi, '_')}.json`, raw);
  }
  const headers: Record<string, string> = { 'accept-encoding': 'identity' };
  for (const [name, value] of Object.entries(request.headers)) if (!HOP.has(name) && typeof value === 'string') headers[name] = value;
  const started = Date.now();
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(`${upstream}${path}`, { method: 'POST', headers, body: new Uint8Array(raw) });
  } catch (error) {
    entry.status = 502;
    entry.ms = Date.now() - started;
    entries.push(entry);
    await appendFile(`${logDir}/proxy.jsonl`, `${JSON.stringify({ ...entry, error: String(error) })}\n`);
    return json(response, 502, { type: 'error', error: { type: 'api_error', message: 'The evaluation proxy could not reach the provider.' } });
  }
  const out: Record<string, string> = {};
  upstreamResponse.headers.forEach((value, name) => { if (!HOP.has(name)) out[name] = value; });
  response.writeHead(upstreamResponse.status, out);
  const chunks: Buffer[] = [];
  if (upstreamResponse.body) {
    for await (const chunk of upstreamResponse.body as unknown as AsyncIterable<Uint8Array>) {
      if (entry.firstByteMs === null) entry.firstByteMs = Date.now() - started;
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      response.write(buffer);
    }
  }
  response.end();
  entry.ms = Date.now() - started;
  entry.status = upstreamResponse.status;
  const text = Buffer.concat(chunks).toString('utf8');
  if (isMessages && upstreamResponse.ok) {
    const answer = readAnswer(text, entry.stream);
    Object.assign(entry, answer, { costUsd: costOf(model, answer.usage) });
    spent += entry.costUsd;
  } else if (!upstreamResponse.ok) {
    // An error body never holds the key; it is kept so a failed run can be told from a model's answer.
    entry.text = text.slice(0, 2_000);
  }
  entries.push(entry);
  await appendFile(`${logDir}/proxy.jsonl`, `${JSON.stringify(entry)}\n`);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://evalproxy');
  void (async () => {
    if (request.method === 'GET' && url.pathname === '/__health') return json(response, 200, { ok: true });
    if (request.method === 'POST' && url.pathname === '/__eval/tag') {
      const body = JSON.parse((await readBody(request)).toString('utf8') || '{}') as { tag?: string };
      tag = typeof body.tag === 'string' && body.tag ? body.tag.slice(0, 80) : 'untagged';
      return json(response, 200, { tag, spentUsd: spent, capUsd: cap });
    }
    if (request.method === 'GET' && url.pathname === '/__eval/ledger') {
      const wanted = url.searchParams.get('tag');
      return json(response, 200, { tag: wanted, spentUsd: spent, capUsd: cap, ...summary(wanted ? entries.filter((entry) => entry.tag === wanted) : entries) });
    }
    if (request.method === 'POST' && (url.pathname === '/v1/messages' || url.pathname === '/v1/messages/count_tokens')) return forward(request, response, url.pathname);
    return json(response, 404, { type: 'error', error: { type: 'not_found_error', message: 'Not served by the evaluation proxy.' } });
  })().catch((error: unknown) => {
    if (!response.headersSent) json(response, 500, { type: 'error', error: { type: 'api_error', message: String(error) } });
    else response.end();
  });
});

if (process.argv[1]?.endsWith('eval-proxy.ts')) {
  await mkdir(`${logDir}/requests`, { recursive: true });
  if (!(cap > 0)) throw new Error('FLUX_EVAL_CAP_USD must be a positive number of dollars');
  server.listen(port, '0.0.0.0', () => console.log(`evalproxy on ${port} → ${upstream}, cap $${cap.toFixed(2)}`));
}
