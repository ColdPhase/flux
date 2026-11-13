import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { maxRequestMicros, type AiPrice, type AiProviderKind } from '@flux/contracts';
import { admitGatewayRequest, createModelGateway, gatewayHoldMicros, type GatewayRequestFacts } from '@flux/core';
import { MODEL_GATEWAY_LIMITS, parseModelGatewayUrl } from '@flux/runtime-protocol';
import { parsePrivateTargets } from '../../packages/agent-runtime/src/index.js';
import { personalRunWorkerUnitOfWork } from '../../apps/worker/src/personal-runs/adapters.js';
import { createModelGatewayServer } from '../../apps/worker/src/model-gateway/server.js';
import { createModelForwarder } from '../../apps/runtime/src/egress/model.js';
import { db, pool } from './support/db.js';
import { expectStatus, person, workspace } from './support/people.js';
import { FakeConnections } from './support/personal-runs.js';

// #1441: the model gateway end to end, as a harness in the runtime uses it: the harness → runtime-egress's model forwarder → the worker's
// gateway (the real use cases on the real run rows, the real key-spend query) → a provider mock for every wire format, whole and
// streamed. The key is a seeded marker: it must reach the provider's own header and nothing else (answers, errors, logs, run rows).
// Tokens: unknown, expired, closed (replayed), another run's state. Money: held before, charged after, the key's day shared with the
// owner's other runs. Limits: size, concurrency, a stalled provider.

const KEY = `sk-ant-flux-seeded-${randomBytes(12).toString('hex')}`;
const PRICE: AiPrice = { inputMicrosPerMTok: 3_000_000, outputMicrosPerMTok: 15_000_000, source: 'owner', checkedOn: null };
const LIMITS = { ...MODEL_GATEWAY_LIMITS, requestBytes: 64 * 1024, idleMs: 600 };

type Script = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let script: Script = (_req, _body, res) => { res.writeHead(500); res.end(); };
const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
const logs: Record<string, unknown>[] = [];
const seenByHarness: string[] = [];
const connections = new FakeConnections();
const stops: [string, string][] = [];
const gateway = createModelGateway({ uow: personalRunWorkerUnitOfWork(db), connections, limits: LIMITS, tokenLifetimeMs: 60_000,
  onStop: (runId, reason) => stops.push([runId, reason]) });

let provider: Server; let worker: Server; let egress: Server; let egressUrl = ''; let mockUrl = '';
let ownerId = ''; let workspaceId = ''; let agentId = '';
const runIds: string[] = [];

const listen = (server: Server) => new Promise<number>((done) => server.listen(0, '127.0.0.1', () => done((server.address() as AddressInfo).port)));

before(async () => {
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { received.push({ url: req.url!, headers: req.headers, body }); script(req, body, res); });
  });
  mockUrl = `http://127.0.0.1:${await listen(provider)}`;
  worker = createModelGatewayServer({
    gateway, policy: parsePrivateTargets('127.0.0.1'), limits: LIMITS, log: (event) => logs.push(event),
    resolveKey: async (keyRef) => (keyRef.startsWith('test-key-ref-') ? KEY : null),
    upstreams: { anthropic: `${mockUrl}/anthropic`, openai: `${mockUrl}/openai`, openrouter: `${mockUrl}/openrouter`, gemini: `${mockUrl}/gemini` },
  });
  const workerPort = await listen(worker);
  egress = createModelForwarder({ upstream: { host: '127.0.0.1', port: workerPort }, log: (event) => logs.push(event) });
  egressUrl = `http://127.0.0.1:${await listen(egress)}`;
  const owner = await person('model-gateway-owner');
  ownerId = owner.id;
  workspaceId = ((await workspace(owner, 'Model gateway')) as { id: string }).id;
  agentId = (expectStatus(await owner.browser.request('POST', `/api/v1/workspaces/${workspaceId}/agents`, { body: { name: 'Gateway agent', owner: 'self' } }), 201) as { id: string }).id;
});

after(() => { egress?.close(); worker?.close(); provider?.close(); });

/** A run on an API key working in the runtime, on a fresh connection of `provider`, and its gateway token. */
async function runOn(kind: AiProviderKind, model: string, options: { dailyBudgetCents?: number; connectionId?: string } = {}) {
  const connectionId = options.connectionId ?? randomUUID();
  connections.connect(ownerId, connectionId, { provider: kind, model, price: PRICE, dailyBudgetCents: options.dailyBudgetCents ?? 1_000,
    baseUrl: kind === 'openai_compatible' ? `${mockUrl}/compat/v1` : null });
  const id = randomUUID();
  // One working run per owner (their lane): the run before this one has ended.
  await pool.query("UPDATE personal_runs SET status = 'completed', completed_at = now() WHERE owner_user_id = $1 AND status IN ('reading', 'dispatching')", [ownerId]);
  await pool.query(`INSERT INTO personal_runs (id, workspace_id, owner_user_id, agent_id, client_run_id, request_fingerprint, kind, prompt, reserved_micros,
    provider, model, engine, status, connection_id) VALUES ($1, $2, $3, $4, $5, 'gateway-test', 'ask', 'gateway test', 0, $6, $7, 'runtime', 'dispatching', $8)`,
  [id, workspaceId, ownerId, agentId, randomUUID(), kind, model, connectionId]);
  runIds.push(id);
  const issued = await gateway.issue(id);
  assert.ok(issued, 'a token is issued for a working runtime run on a key');
  return { id, connectionId, token: issued.token };
}

const row = async (id: string) => (await pool.query<{ charged_micros: number; reserved_micros: number; input_tokens: number | null; output_tokens: number | null;
  cost_state: string; gateway_token_hash: string | null }>('SELECT charged_micros, reserved_micros, input_tokens, output_tokens, cost_state, gateway_token_hash FROM personal_runs WHERE id = $1', [id])).rows[0]!;

/** The harness's request through the egress; what it sees is kept for the key scan. */
async function call(path: string, token: string, body: unknown, header: 'x-api-key' | 'authorization' | 'x-goog-api-key' = 'x-api-key') {
  const headers: Record<string, string> = { 'content-type': 'application/json', [header]: header === 'authorization' ? `Bearer ${token}` : token };
  const answer = await fetch(`${egressUrl}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  let text: string;
  try { text = await answer.text(); } catch { text = '<broken>'; }
  seenByHarness.push(text, JSON.stringify([...answer.headers]));
  return { status: answer.status, text, headers: answer.headers };
}

const sse = (...events: unknown[]) => events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
const whole = (value: unknown): Script => (_req, _body, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
const streamed = (body: string): Script => (_req, _body, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const half = Math.floor(body.length / 2);
  res.write(body.slice(0, half));
  setTimeout(() => res.end(body.slice(half)), 10);
};
/** The hold of a request, worked out as the gateway does. */
function holdOf(facts: GatewayRequestFacts, body: unknown, model: string) {
  const admitted = admitGatewayRequest(facts, Buffer.from(JSON.stringify(body)), model, LIMITS);
  assert.ok(admitted.ok);
  return gatewayHoldMicros(PRICE, facts.provider, admitted.request);
}

describe('every wire format, whole and streamed', () => {
  const cases: { name: string; kind: AiProviderKind; model: string; path: string; header: 'x-api-key' | 'authorization' | 'x-goog-api-key'; body: Record<string, unknown>;
    script: Script; usage: { input: number; billedInput: number; output: number }; reported?: number; keyHeader: string; upstream: string }[] = [
    { name: 'Anthropic, whole, cache asked', kind: 'anthropic', model: 'claude-sonnet-5', path: '/anthropic/v1/messages', header: 'x-api-key', keyHeader: 'x-api-key',
      upstream: '/anthropic/v1/messages',
      body: { model: 'claude-sonnet-5', max_tokens: 100, system: [{ type: 'text', text: 'brief', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'hi' }] },
      script: whole({ type: 'message', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 300, cache_read_input_tokens: 600 } }),
      // 100 + 300 × 1.25 + 600 × 0.1
      usage: { input: 1_000, billedInput: 535, output: 20 } },
    { name: 'Anthropic, streamed, no cache asked', kind: 'anthropic', model: 'claude-sonnet-5', path: '/anthropic/v1/messages', header: 'x-api-key', keyHeader: 'x-api-key',
      upstream: '/anthropic/v1/messages',
      body: { model: 'claude-sonnet-5', max_tokens: 100, stream: true, messages: [{ role: 'user', content: 'hi' }] },
      script: streamed(sse({ type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 10 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }, { type: 'message_delta', usage: { output_tokens: 7 } }, { type: 'message_stop' })),
      // A read the request did not ask for is charged at the full price (#1426).
      usage: { input: 60, billedInput: 60, output: 7 } },
    { name: 'OpenAI Chat Completions, streamed', kind: 'openai', model: 'gpt-6-mini', path: '/openai/v1/chat/completions', header: 'authorization', keyHeader: 'authorization',
      upstream: '/openai/v1/chat/completions',
      body: { model: 'gpt-6-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] },
      script: streamed(sse({ choices: [{ delta: { content: 'hello' } }], usage: null }, { choices: [], usage: { prompt_tokens: 30, completion_tokens: 4 } }, '[DONE]')),
      usage: { input: 30, billedInput: 30, output: 4 } },
    { name: 'OpenAI Responses, streamed', kind: 'openai', model: 'gpt-6-mini', path: '/openai/v1/responses', header: 'authorization', keyHeader: 'authorization',
      upstream: '/openai/v1/responses',
      body: { model: 'gpt-6-mini', stream: true, input: 'hi' },
      script: streamed(sse({ type: 'response.output_text.delta', delta: 'hello' }, { type: 'response.completed', response: { usage: { input_tokens: 40, output_tokens: 9 } } })),
      usage: { input: 40, billedInput: 40, output: 9 } },
    { name: 'OpenRouter, whole, with its reported cost', kind: 'openrouter', model: 'anthropic/claude-sonnet-5', path: '/openrouter/api/v1/chat/completions',
      header: 'authorization', keyHeader: 'authorization', upstream: '/openrouter/api/v1/chat/completions',
      body: { model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] },
      script: whole({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 12, completion_tokens: 3, cost: 0.25 } }),
      usage: { input: 12, billedInput: 12, output: 3 }, reported: 250_000 },
    { name: 'Gemini, native, streamed', kind: 'gemini', model: 'gemini-3-flash', path: '/gemini/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
      header: 'x-goog-api-key', keyHeader: 'x-goog-api-key', upstream: '/gemini/v1beta/models/gemini-3-flash:streamGenerateContent?alt=sse',
      body: { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] },
      script: streamed(sse({ candidates: [{ content: { parts: [{ text: 'hel' }] } }], usageMetadata: { promptTokenCount: 20 } },
        { candidates: [{ content: { parts: [{ text: 'lo' }] } }], usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 6 } })),
      usage: { input: 20, billedInput: 20, output: 11 } },
    { name: 'Gemini, OpenAI-compatible, whole', kind: 'gemini', model: 'gemini-3-flash', path: '/gemini/v1beta/openai/chat/completions', header: 'authorization',
      keyHeader: 'authorization', upstream: '/gemini/v1beta/openai/chat/completions',
      body: { model: 'gemini-3-flash', messages: [{ role: 'user', content: 'hi' }] },
      script: whole({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 15, completion_tokens: 2 } }),
      usage: { input: 15, billedInput: 15, output: 2 } },
    { name: 'an OpenAI-compatible endpoint, whole, at the owner\'s base URL', kind: 'openai_compatible', model: 'qwen3-coder', path: '/openai_compatible/chat/completions',
      header: 'authorization', keyHeader: 'authorization', upstream: '/compat/v1/chat/completions',
      body: { model: 'qwen3-coder', messages: [{ role: 'user', content: 'hi' }] },
      script: whole({ choices: [{ message: { content: 'hello' } }], usage: { prompt_tokens: 8, completion_tokens: 1 } }),
      usage: { input: 8, billedInput: 8, output: 1 } },
  ];

  for (const item of cases) {
    test(item.name, async () => {
      const run = await runOn(item.kind, item.model);
      script = item.script;
      const answer = await call(item.path, run.token, item.body, item.header);
      assert.equal(answer.status, 200, answer.text);
      assert.match(answer.text, /hel/);
      const sent = received.at(-1)!;
      assert.equal(sent.url, item.upstream);
      // The key is in the provider's own header and only there; the token never reaches the provider.
      assert.equal(sent.headers[item.keyHeader], item.keyHeader === 'authorization' ? `Bearer ${KEY}` : KEY);
      for (const other of ['x-api-key', 'authorization', 'x-goog-api-key'].filter((name) => name !== item.keyHeader)) assert.equal(sent.headers[other], undefined, other);
      assert.ok(!JSON.stringify(sent).includes(run.token), 'the token never reaches the provider');
      assert.equal(sent.headers['user-agent'], 'Flux-model-gateway');
      const expected = item.reported ?? maxRequestMicros(PRICE, item.usage.billedInput, item.usage.output);
      const after = await row(run.id);
      assert.equal(after.charged_micros, expected, 'the reported usage, at the run model\'s price and cache rules');
      assert.equal(after.reserved_micros, expected, 'the rest of the hold is released');
      assert.deepEqual([after.input_tokens, after.output_tokens], [item.usage.input, item.usage.output]);
      assert.equal(after.cost_state, 'reserved', 'the run\'s engine settles the run at its end');
      const account = await gateway.close(run.id);
      assert.deepEqual(account, { requests: 1, chargedMicros: expected, unknown: 0, stopped: null });
      assert.equal((await row(run.id)).gateway_token_hash, null, 'closing clears the token');
    });
  }

  test('a Chat Completions stream is asked for its usage, the output bound is set, and only the beta values that change no price go on', async () => {
    const run = await runOn('openai', 'gpt-6-mini');
    script = streamed(sse({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }, '[DONE]'));
    await call('/openai/v1/chat/completions', run.token, { model: 'gpt-6-mini', stream: true, messages: [] }, 'authorization');
    const body = JSON.parse(received.at(-1)!.body);
    assert.deepEqual([body.stream_options, body.max_completion_tokens], [{ include_usage: true }, 32_000]);
    const claude = await runOn('anthropic', 'claude-sonnet-5');
    script = whole({ usage: { input_tokens: 1, output_tokens: 1 } });
    const answer = await fetch(`${egressUrl}/anthropic/v1/messages`, { method: 'POST', body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 5, messages: [] }),
      headers: { 'x-api-key': claude.token, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'interleaved-thinking-2025-05-14,oauth-2025-04-20,claude-code-20250219,context-1m-2025-08-07' } });
    assert.equal(answer.status, 200);
    assert.equal(received.at(-1)!.headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');
    await gateway.close(run.id);
    await gateway.close(claude.id);
  });
});

describe('answers whose cost is not known, and the provider\'s error answers', () => {
  const body = { model: 'qwen3-coder', messages: [{ role: 'user', content: 'hi' }] };
  const facts: GatewayRequestFacts = { provider: 'openai_compatible', operation: 'openai_chat', pathModel: null, pathStream: null };

  test('missing or malformed usage is charged all the request held', async () => {
    const hold = holdOf(facts, body, 'qwen3-coder');
    for (const answer of [{ choices: [{ message: { content: 'hello' } }] }, { choices: [], usage: { prompt_tokens: -3, completion_tokens: 1 } },
      { choices: [], usage: { prompt_tokens: 10_000_000, completion_tokens: 1 } }]) {
      const run = await runOn('openai_compatible', 'qwen3-coder');
      script = whole(answer);
      assert.equal((await call('/openai_compatible/chat/completions', run.token, body, 'authorization')).status, 200);
      assert.deepEqual([(await row(run.id)).charged_micros, (await row(run.id)).reserved_micros], [hold, hold], JSON.stringify(answer));
      assert.deepEqual(await gateway.close(run.id), { requests: 1, chargedMicros: hold, unknown: 1, stopped: null });
    }
  });

  test('a stream cut off, or a provider that stalls, is charged all it held; the harness sees a broken answer', async () => {
    const hold = holdOf({ ...facts }, { ...body, stream: true }, 'qwen3-coder');
    const cut = await runOn('openai_compatible', 'qwen3-coder');
    script = (_req, _body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse({ choices: [{ delta: { content: 'hel' } }] })); setTimeout(() => res.destroy(), 20); };
    const broken = await call('/openai_compatible/chat/completions', cut.token, { ...body, stream: true }, 'authorization');
    assert.equal(broken.status, 200);
    assert.equal((await row(cut.id)).charged_micros, hold);
    const stalled = await runOn('openai_compatible', 'qwen3-coder');
    script = (_req, _body, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(sse({ choices: [{ delta: { content: 'hel' } }] })); };
    const started = Date.now();
    await call('/openai_compatible/chat/completions', stalled.token, { ...body, stream: true }, 'authorization');
    assert.ok(Date.now() - started < 5_000, 'the idle bound ends it');
    assert.equal((await row(stalled.id)).charged_micros, hold);
    await gateway.close(cut.id);
    await gateway.close(stalled.id);
  });

  test('a whole answer slower than the idle bound is waited for (a long answer is written before its first byte) and charged its usage', async () => {
    const run = await runOn('openai_compatible', 'qwen3-coder');
    script = (_req, _body, res) => { setTimeout(() => whole({ usage: { prompt_tokens: 12, completion_tokens: 7 } })(_req, _body, res), LIMITS.idleMs * 2); };
    const answer = await call('/openai_compatible/chat/completions', run.token, body, 'authorization');
    assert.equal(answer.status, 200);
    assert.equal((await row(run.id)).charged_micros, maxRequestMicros(PRICE, 12, 7));
    await gateway.close(run.id);
  });

  test('an unknown token, or a run with all its places taken, is refused before its body is read', async () => {
    const unknown = await call('/anthropic/v1/messages', `flux_mg_${'A'.repeat(43)}`, { ...body, messages: [{ role: 'user', content: 'x'.repeat(70 * 1024) }] });
    assert.equal(unknown.status, 401, 'refused for its token, not read to its size');
  });

  test('an error answer is passed back without the key or anything shaped like one, and costs nothing', async () => {
    const run = await runOn('openai', 'gpt-6-mini');
    script = (_req, _body, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY}. Masked: sk-proj-****************abcd`, code: 'invalid_api_key' } }));
    };
    const answer = await call('/openai/v1/responses', run.token, { model: 'gpt-6-mini', input: 'hi' }, 'authorization');
    assert.equal(answer.status, 401);
    assert.ok(!answer.text.includes(KEY) && !answer.text.includes('sk-proj'), answer.text);
    assert.match(answer.text, /invalid_api_key/);
    const after = await row(run.id);
    assert.deepEqual([after.charged_micros, after.reserved_micros], [0, 0]);
    script = (_req, _body, res) => { res.writeHead(529, { 'content-type': 'application/json', 'retry-after': '3' }); res.end('{"type":"error","error":{"type":"overloaded_error"}}'); };
    const busy = await call('/openai/v1/responses', run.token, { model: 'gpt-6-mini', input: 'hi' }, 'authorization');
    assert.deepEqual([busy.status, busy.headers.get('retry-after')], [529, '3']);
    assert.equal((await row(run.id)).charged_micros, 0);
    await gateway.close(run.id);
  });
});

describe('tokens', () => {
  const body = { model: 'claude-sonnet-5', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };
  const ok: Script = whole({ usage: { input_tokens: 1, output_tokens: 1 } });

  test('an unknown, malformed, expired or closed (replayed) token is refused before anything reaches the provider', async () => {
    const run = await runOn('anthropic', 'claude-sonnet-5');
    script = ok;
    assert.equal((await call('/anthropic/v1/messages', run.token, body)).status, 200);
    const before = received.length;
    for (const token of [`flux_mg_${randomBytes(32).toString('base64url')}`, 'sk-ant-api03-something', `${run.token}x`, '']) {
      const answer = await call('/anthropic/v1/messages', token, body);
      assert.equal(answer.status, 401, token);
      assert.equal(answer.headers.get('x-should-retry'), 'false');
      assert.equal((JSON.parse(answer.text) as { error: { code: string } }).error.code, 'flux_token_invalid');
    }
    await pool.query("UPDATE personal_runs SET gateway_token_expires_at = now() - interval '1 second' WHERE id = $1", [run.id]);
    assert.equal((await call('/anthropic/v1/messages', run.token, body)).status, 401, 'expired');
    const again = await gateway.issue(run.id);
    assert.ok(again);
    assert.equal((await call('/anthropic/v1/messages', run.token, body)).status, 401, 'a new token replaces the old one');
    assert.equal((await call('/anthropic/v1/messages', again.token, body)).status, 200);
    await gateway.close(run.id);
    assert.equal((await call('/anthropic/v1/messages', again.token, body)).status, 401, 'replayed after the run closed it');
    assert.equal(received.length, before + 1, 'only the one valid request reached the provider');
  });

  test('a run that was stopped or ended refuses its token and is told to stop; tokens are only for working runtime runs on a key', async () => {
    const run = await runOn('anthropic', 'claude-sonnet-5');
    await pool.query('UPDATE personal_runs SET stop_requested_at = now() WHERE id = $1', [run.id]);
    const answer = await call('/anthropic/v1/messages', run.token, body);
    assert.equal(answer.status, 403);
    assert.equal((JSON.parse(answer.text) as { error: { code: string } }).error.code, 'flux_run_ended');
    assert.ok(stops.some(([id, reason]) => id === run.id && reason === 'ended'));
    const done = await runOn('anthropic', 'claude-sonnet-5');
    await pool.query("UPDATE personal_runs SET status = 'completed', completed_at = now() WHERE id = $1", [done.id]);
    assert.equal((await call('/anthropic/v1/messages', done.token, body)).status, 403);
    assert.equal(await gateway.issue(done.id), null, 'no token for a run that is not working');
    const server = await runOn('anthropic', 'claude-sonnet-5');
    await pool.query("UPDATE personal_runs SET engine = 'server', reserved_micros = 1 WHERE id = $1", [server.id]);
    assert.equal(await gateway.issue(server.id), null, 'no token for a run of the worker\'s own engine');
    assert.equal((await call('/anthropic/v1/messages', server.token, body)).status, 403);
  });

  test('a token reaches only its run\'s provider and model, without hosted tools', async () => {
    const run = await runOn('anthropic', 'claude-sonnet-5');
    script = ok;
    const before = received.length;
    for (const [path, request, header] of [
      ['/openai/v1/responses', { model: 'claude-sonnet-5', input: 'hi' }, 'authorization'],
      ['/anthropic/v1/messages', { ...body, model: 'claude-opus-5' }, 'x-api-key'],
      ['/anthropic/v1/messages', { ...body, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, 'x-api-key'],
      ['/anthropic/v1/messages', 'not json', 'x-api-key'],
    ] as const) {
      const answer = await call(path, run.token, request, header);
      assert.equal(answer.status, 400, `${path} ${JSON.stringify(request)}`);
      assert.equal((JSON.parse(answer.text) as { error: { code: string } }).error.code, 'flux_request_refused');
    }
    assert.equal(received.length, before);
    assert.equal((await row(run.id)).reserved_micros, 0, 'nothing is held for a refused request');
    await gateway.close(run.id);
  });
});

describe('money and limits', () => {
  const body = { model: 'claude-sonnet-5', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };
  const facts: GatewayRequestFacts = { provider: 'anthropic', operation: 'anthropic_messages', pathModel: null, pathStream: null };

  test('the key\'s day is shared with the owner\'s other runs on it; a request the day cannot hold is refused and the run is told to stop', async () => {
    const hold = holdOf(facts, body, 'claude-sonnet-5');
    const connectionId = randomUUID();
    // A budget that holds one request and a little more.
    const budgetCents = Math.ceil((hold + 50_000) / 10_000);
    const first = await runOn('anthropic', 'claude-sonnet-5', { connectionId, dailyBudgetCents: budgetCents });
    script = whole({ usage: { input_tokens: 10, output_tokens: 10 } });
    assert.equal((await call('/anthropic/v1/messages', first.token, body)).status, 200);
    await gateway.close(first.id);
    // Another runtime run on the same key, finished today, spent 100,000: it counts against the day (#854, #1441).
    await pool.query("UPDATE personal_runs SET status = 'completed', cost_state = 'observed', charged_micros = 100000, reserved_micros = 100000 WHERE id = $1", [first.id]);
    const second = await runOn('anthropic', 'claude-sonnet-5', { connectionId, dailyBudgetCents: budgetCents });
    const before = received.length;
    const refused = await call('/anthropic/v1/messages', second.token, body);
    assert.equal(refused.status, 402);
    assert.equal(refused.headers.get('x-should-retry'), 'false');
    assert.equal((JSON.parse(refused.text) as { error: { code: string } }).error.code, 'flux_budget_exhausted');
    assert.equal(received.length, before, 'nothing reached the provider');
    assert.equal(gateway.account(second.id).stopped, 'budget');
    assert.ok(stops.some(([id, reason]) => id === second.id && reason === 'budget'));
    await gateway.close(second.id);
  });

  test('at most four requests of one run at once; the money of the ones in flight is held', async () => {
    const run = await runOn('anthropic', 'claude-sonnet-5');
    const hold = holdOf(facts, body, 'claude-sonnet-5');
    const waiting: ServerResponse[] = [];
    script = (_req, _body, res) => { waiting.push(res); };
    const calls = [0, 1, 2, 3].map(() => call('/anthropic/v1/messages', run.token, body));
    while (waiting.length < 4) await new Promise((done) => setTimeout(done, 20));
    assert.equal((await row(run.id)).reserved_micros, 4 * hold);
    const fifth = await call('/anthropic/v1/messages', run.token, body);
    assert.equal(fifth.status, 429);
    assert.equal((JSON.parse(fifth.text) as { error: { code: string } }).error.code, 'flux_run_busy');
    for (const res of waiting) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 10 } })); }
    assert.deepEqual((await Promise.all(calls)).map((answer) => answer.status), [200, 200, 200, 200]);
    const each = maxRequestMicros(PRICE, 10, 10);
    assert.deepEqual([(await row(run.id)).charged_micros, (await row(run.id)).reserved_micros], [4 * each, 4 * each]);
    await gateway.close(run.id);
  });

  test('the bodies of all requests in flight share one bound in the worker\'s memory: past it, send again shortly', async () => {
    const run = await runOn('anthropic', 'claude-sonnet-5');
    const small = createModelGatewayServer({ gateway, policy: parsePrivateTargets('127.0.0.1'), limits: { ...LIMITS, bodiesInFlightBytes: 1024 },
      resolveKey: async () => KEY, upstreams: { anthropic: `${mockUrl}/anthropic` } });
    const port = await listen(small);
    try {
      const answer = await fetch(`http://127.0.0.1:${port}/anthropic/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': run.token },
        body: JSON.stringify({ ...body, messages: [{ role: 'user', content: 'x'.repeat(4096) }] }) });
      assert.equal(answer.status, 429);
      assert.deepEqual([answer.headers.get('x-should-retry'), answer.headers.get('retry-after')], ['true', '2']);
      assert.equal((await row(run.id)).reserved_micros, 0, 'nothing held');
    } finally { small.close(); }
    await gateway.close(run.id);
  });

  test('a request larger than the bound is refused', async () => {
    const run = await runOn('anthropic', 'claude-sonnet-5');
    const answer = await call('/anthropic/v1/messages', run.token, { ...body, messages: [{ role: 'user', content: 'x'.repeat(70 * 1024) }] });
    assert.equal(answer.status, 413);
    await gateway.close(run.id);
  });
});

describe('the key is never visible outside the provider\'s header', () => {
  test('no answer, error, log line or run row carries it, and no log line carries a token', async () => {
    assert.ok(seenByHarness.length > 20);
    for (const text of seenByHarness) assert.ok(!text.includes(KEY), text.slice(0, 200));
    const logged = JSON.stringify(logs);
    assert.ok(!logged.includes(KEY));
    assert.ok(!/flux_mg_/.test(logged), 'no token is logged');
    assert.ok(logs.some((event) => event.event === 'model' && typeof event.chargedMicros === 'number'), 'each request is logged with its charge');
    const rows = await pool.query('SELECT row_to_json(r)::text AS row FROM personal_runs r WHERE id = ANY($1::uuid[])', [runIds]);
    assert.equal(rows.rows.length, runIds.length);
    for (const { row: text } of rows.rows as { row: string }[]) assert.ok(!text.includes(KEY));
    // The provider got it, in its own header only, never in a body.
    for (const sent of received) assert.ok(!sent.body.includes(KEY));
    assert.ok(received.some((sent) => sent.headers['x-api-key'] === KEY));
    assert.ok(parseModelGatewayUrl('/anthropic/v1/messages'));
  });
});
