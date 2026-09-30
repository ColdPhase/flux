import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { anthropicComparisonProvider } from '../../apps/worker/src/proactive-comparison/anthropic-provider.js';
import { comparisonSourceHref } from '../../apps/web/src/project/proposals.js';

const source = { type: 'result' as const, id: 'result-1', version: 1, text: 'Camera A missed gestures at 5 lux.' };
const key = 'sk-ant-api03-local-test-secret';
const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
let failMessage = false;
let messageMode: 'comparison' | 'insufficient' | 'malformed' = 'comparison';
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  requests.push({ path: request.url ?? '', body });
  assert.equal(request.headers['x-api-key'], key);
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  response.setHeader('content-type', 'application/json');
  if (request.url === '/v1/messages/count_tokens') {
    response.end(JSON.stringify({ input_tokens: 111 }));
  } else if (failMessage) {
    response.statusCode = 503;
    response.end(JSON.stringify({ error: { message: key } }));
  } else {
    const text = messageMode === 'malformed' ? `invalid JSON with ${key}` : JSON.stringify({ outcome: messageMode === 'insufficient'
      ? { kind: 'insufficient_evidence', reason: 'The supplied evidence has no comparable sensor measurements.' }
      : { kind: 'comparison', fact: 'Camera A missed gestures at 5 lux.', interpretation: 'A second sensor may help.',
        suggestedAction: 'Test another sensor.', citations: [{ type: 'result', id: source.id, version: 1 }],
      } });
    response.end(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 112, output_tokens: 78 },
      content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text }] }));
  }
});
let provider: ReturnType<typeof anthropicComparisonProvider>;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  provider = anthropicComparisonProvider(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

test('real HTTP adapter sends a fixed no-tool structured request and parses a text block after thinking', async () => {
  const signal = AbortSignal.timeout(2000);
  const input = { apiKey: key, model: 'claude-sonnet-5' as const, sources: [source], signal };
  assert.equal(await provider.countInputTokens(input), 111);
  const message = await provider.createMessage({ ...input, maxTokens: 1200, effort: 'low' });
  assert.equal(message.stopReason, 'end_turn');
  assert.deepEqual(message.usage, { inputTokens: 112, outputTokens: 78 });
  assert.ok(message.answer?.kind === 'comparison');
  assert.deepEqual(message.answer.citations, [{ type: 'result', id: source.id, version: 1 }]);
  assert.deepEqual(requests.map((item) => item.path), ['/v1/messages/count_tokens', '/v1/messages']);
  for (const { body } of requests) {
    assert.equal(body.model, 'claude-sonnet-5');
    assert.equal(body.tools, undefined);
    assert.equal((body.output_config as { effort: string }).effort, 'low');
    assert.ok(JSON.stringify(body).includes(source.text));
  }
  assert.equal(requests[1]?.body.max_tokens, 1200);
  const format = (requests[1]!.body.output_config as { format: { schema: { required: string[];
    properties: { outcome: { anyOf: Array<{ additionalProperties: boolean; required: string[] }> } } } } }).format;
  assert.deepEqual(format.schema.required, ['outcome']);
  assert.equal(format.schema.properties.outcome.anyOf.length, 2, 'the provider schema distinguishes a comparison from insufficient evidence');
  assert.ok(format.schema.properties.outcome.anyOf.every((branch) => branch.additionalProperties === false && branch.required.includes('kind')));
});

test('HTTP adapter retains observed usage for insufficient and malformed structured answers without raw output', async () => {
  const input = { apiKey: key, model: 'claude-sonnet-5' as const, sources: [source],
    maxTokens: 1200 as const, effort: 'low' as const, signal: AbortSignal.timeout(2000) };
  messageMode = 'insufficient';
  const insufficient = await provider.createMessage(input);
  assert.deepEqual(insufficient.answer, { kind: 'insufficient_evidence', reason: 'The supplied evidence has no comparable sensor measurements.' });
  assert.deepEqual(insufficient.usage, { inputTokens: 112, outputTokens: 78 });
  messageMode = 'malformed';
  const malformed = await provider.createMessage(input);
  assert.equal(malformed.answer, null);
  assert.deepEqual(malformed.usage, { inputTokens: 112, outputTokens: 78 });
  assert.equal(JSON.stringify(malformed).includes(key), false);
  assert.equal(JSON.stringify(malformed).includes('private reasoning'), false);
  messageMode = 'comparison';
});

test('provider 503 has no automatic retry and does not reveal its error body', async () => {
  failMessage = true;
  const beforeFailure = requests.length;
  await assert.rejects(provider.createMessage({ apiKey: key, model: 'claude-sonnet-5', sources: [source],
    maxTokens: 1200, effort: 'low', signal: AbortSignal.timeout(2000) }), (error: Error) => {
    assert.ok(!error.message.includes(key));
    return true;
  });
  assert.equal(requests.length, beforeFailure + 1);
  failMessage = false;
});

test('a cited project message opens the exact message in its conversation', () => {
  assert.equal(comparisonSourceHref('project-1', { type: 'message', id: 'message-1', version: 1,
    conversationId: 'conversation-1' }), '/projects/project-1/conversations/conversation-1#message-message-1');
  assert.equal(comparisonSourceHref('project-1', { type: 'message', id: 'message-1', version: 1 }), null);
  assert.equal(comparisonSourceHref('project-1', { type: 'work', id: 'work-1', version: 2 }), '/projects/project-1/tasks?open=work:work-1');
  assert.equal(comparisonSourceHref('project-1', { type: 'thought', id: 'thought-1', version: 3, sketchId: 'sketch-1' }),
    '/projects/project-1/map/sketch-1#thought-thought-1');
});
