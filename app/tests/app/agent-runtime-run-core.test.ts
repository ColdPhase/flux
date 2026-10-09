import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { callSupervisor, NdjsonReader, parseSupervisorFrame, type SupervisorCallOutcome, type SupervisorFrame, type SupervisorRequest } from '@flux/runtime-protocol';
import { portOf, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// F-022 T5, supervisor side: one owner-invoked run of the TEST ONLY fake `claude -p` in a slot, over a
// stub Flux MCP route. The fake makes a real HTTP JSON-RPC call to the stub with the run token in its
// Authorization header. No vendor, no account, no network beyond loopback.

const CAPS = { maxTurns: 10, wallClockSeconds: 60, idleSeconds: 5, maxAnswerBytes: 16 * 1024 };
const TOKEN = 'aaaaaaaaaaaa.bbbbbbbbbbbb.cccccccccccc';

interface StubCall { authorization: string | undefined; body: string }

/** A stub of the Flux MCP route: records each call's Authorization header and answers with a tool result. */
function startStub(): Promise<{ url: string; calls: StubCall[]; close(): Promise<void> }> {
  const calls: StubCall[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const parts: Buffer[] = [];
    request.on('data', (chunk: Buffer) => parts.push(chunk));
    request.on('end', () => {
      calls.push({ authorization: request.headers.authorization, body: Buffer.concat(parts).toString('utf8') });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Flux document text' }] } }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as { port: number };
    resolve({ url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise<void>((done) => server.close(() => done())) });
  }));
}

type RunRequest = Extract<SupervisorRequest, { kind: 'run' }>;
const runRequest = (bindingId: string, overrides: Partial<RunRequest> = {}): RunRequest => ({
  kind: 'run', bindingId, client: 'claude_code', runId: randomUUID(), prompt: 'What is in the doc?', runToken: TOKEN, tools: ['flux_get_doc'], caps: CAPS, ...overrides,
});

const target = (slot: TestSlot) => ({ host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret });

/** Sends a request and returns its frames as well as the outcome (the progress frames are the proof of streaming). */
async function runWithFrames(slot: TestSlot, request: SupervisorRequest): Promise<{ frames: SupervisorFrame[] }> {
  const { kind, ...body } = request;
  const response = await fetch(`${slot.url}/v1/${kind}`, { method: 'POST', body: JSON.stringify(body),
    headers: { authorization: `Bearer ${slot.config.secret}`, 'content-type': 'application/json' } });
  const reader = new NdjsonReader(parseSupervisorFrame);
  const frames = reader.push(Buffer.from(await response.arrayBuffer()));
  reader.end();
  return { frames };
}

const resultOf = (frames: SupervisorFrame[]) => {
  const result = frames.find((frame) => frame.t === 'result');
  assert.ok(result && result.t === 'result', JSON.stringify(frames));
  assert.equal(result.result.kind, 'run');
  return result.result as { kind: 'run'; runId: string; outcome: string; answer: string | null };
};

async function bind(slot: TestSlot, scenario: string): Promise<string> {
  const bindingId = randomUUID();
  const out = await callSupervisor(target(slot), { kind: 'bind', bindingId }, { timeoutMs: 20_000 });
  assert.ok(out.ok, JSON.stringify(out));
  const home = join(slot.config.dataDir, bindingId, 'claude');
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'fake-scenario'), scenario);
  return bindingId;
}

async function fakeCalls(slot: TestSlot, bindingId: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(join(slot.config.dataDir, bindingId, 'claude', 'fake-calls.jsonl'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('one owner-invoked run of Claude Code, supervisor side (F-022 T5)', () => {
  let stub: Awaited<ReturnType<typeof startStub>>;
  // A slot holds one owner's binding, so every test gets a fresh slot (and the shared stub).
  let slot: TestSlot;
  before(async () => { stub = await startStub(); });
  beforeEach(async () => { slot = await startTestSlot({ fluxMcpUrl: stub.url }); });
  afterEach(async () => { await slot.close(); });
  after(async () => { await stub.close(); });

  test('streams progress, answers, and the run token reaches only the Authorization header', async () => {
    const bindingId = await bind(slot, 'run_ok');
    const request = runRequest(bindingId);
    stub.calls.length = 0;
    const { frames } = await runWithFrames(slot, request);
    const states = frames.filter((frame) => frame.t === 'run').map((frame) => (frame as { state: string }).state);
    assert.deepEqual(states.slice(0, 2), ['started', 'init_checked'], JSON.stringify(frames));
    const result = resultOf(frames);
    assert.equal(result.outcome, 'answered');
    assert.match(result.answer ?? '', /Flux said: .*Flux document text/);
    // The real MCP call carried the token in the header, expanded by the CLI from its environment.
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0]!.authorization, `Bearer ${TOKEN}`);
    // The argv never carries the token; only the environment does, and the recorded call holds a digest.
    const [record] = await fakeCalls(slot, bindingId);
    assert.ok(record && JSON.stringify(record.argv).indexOf(TOKEN) === -1, 'the token is not in argv');
    const digest = (await fakeCalls(slot, bindingId)).find((entry) => 'mcpAuthDigest' in entry);
    assert.equal(digest?.mcpAuthDigest, createHash('sha256').update(`Bearer ${TOKEN}`).digest('hex'));
    // The argv is the exact Claude Code template: print mode, no local tools, no session transcript.
    const argv = (record!.argv as string[]);
    for (const flag of ['-p', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', '--max-turns']) assert.ok(argv.includes(flag), flag);
    assert.deepEqual(argv.slice(argv.indexOf('--tools'), argv.indexOf('--tools') + 2), ['--tools', '']);
  });

  test('no transcript remains in the binding directory and the run temp directory is removed', async () => {
    const bindingId = await bind(slot, 'run_ok');
    await mkdir(join(slot.config.dataDir, bindingId, 'claude', 'projects', 'x'), { recursive: true });
    const { frames } = await runWithFrames(slot, runRequest(bindingId));
    assert.equal(resultOf(frames).outcome, 'answered');
    await assertMissing(join(slot.config.dataDir, bindingId, 'claude', 'projects'));
    await assertMissing(join(slot.config.tmpDir, `run-${resultOf(frames).runId}`));
  });

  test('a run that lists a local tool in its system init is stopped with no answer', async () => {
    const bindingId = await bind(slot, 'run_extra_tool');
    const before = stub.calls.length;
    const { frames } = await runWithFrames(slot, runRequest(bindingId));
    const result = resultOf(frames);
    assert.equal(result.outcome, 'init_rejected');
    assert.equal(result.answer, null);
    // Refused at init: the CLI never reached Flux.
    assert.equal(stub.calls.length, before);
  });

  test('a run that lists a second MCP server in its system init is stopped with no answer', async () => {
    const bindingId = await bind(slot, 'run_extra_server');
    const result = resultOf((await runWithFrames(slot, runRequest(bindingId))).frames);
    assert.equal(result.outcome, 'init_rejected');
    assert.equal(result.answer, null);
  });

  test('a crash before the result ends as failed with no answer', async () => {
    const bindingId = await bind(slot, 'run_crash');
    const result = resultOf((await runWithFrames(slot, runRequest(bindingId)))!.frames);
    assert.equal(result.outcome, 'failed');
    assert.equal(result.answer, null);
  });

  test('a run with no output ends as idle_timed_out', async () => {
    const bindingId = await bind(slot, 'run_hang');
    const result = resultOf((await runWithFrames(slot, runRequest(bindingId, { caps: { ...CAPS, idleSeconds: 5 } }))).frames);
    assert.equal(result.outcome, 'idle_timed_out');
    assert.equal(result.answer, null);
  });

  test('the answer is redacted of the run token and credential-shaped text', async () => {
    const bindingId = await bind(slot, 'run_leaks');
    const result = resultOf((await runWithFrames(slot, runRequest(bindingId))).frames);
    assert.equal(result.outcome, 'answered');
    assert.ok(result.answer, 'an answer');
    assert.ok(!result.answer.includes(TOKEN), 'the run token is removed');
    assert.ok(!/sk-ant-/.test(result.answer), 'the credential-shaped string is removed');
    assert.match(result.answer, /\[removed: looked like a secret\]/);
  });

  test('an answer over the run cap ends as answer_too_large with no answer', async () => {
    const bindingId = await bind(slot, 'run_big_answer');
    const result = resultOf((await runWithFrames(slot, runRequest(bindingId))).frames);
    assert.equal(result.outcome, 'answer_too_large');
    assert.equal(result.answer, null);
  });

  test('a second run while one is running answers busy, and stop ends the first as stopped', async () => {
    const bindingId = await bind(slot, 'run_hang');
    const first = runRequest(bindingId, { caps: { ...CAPS, idleSeconds: 60 } });
    const running = runWithFrames(slot, first);
    // Give the first run time to reach the CLI before the second arrives.
    await new Promise((done) => setTimeout(done, 1_000));
    const second = await callSupervisor(target(slot), runRequest(bindingId), { timeoutMs: 10_000 });
    assert.deepEqual(second, { ok: false, code: 'busy' });
    const stop = await callSupervisor(target(slot), { kind: 'stop', bindingId, runId: first.runId } as SupervisorRequest, { timeoutMs: 10_000 });
    assert.ok(stop.ok && stop.result.kind === 'stop' && stop.result.state === 'stopping', JSON.stringify(stop));
    assert.equal(resultOf((await running).frames).outcome, 'stopped');
  });

  test('a stop for a run that is not running says so', async () => {
    const bindingId = await bind(slot, 'run_ok');
    const stop: SupervisorCallOutcome = await callSupervisor(target(slot), { kind: 'stop', bindingId, runId: randomUUID() } as SupervisorRequest, { timeoutMs: 10_000 });
    assert.ok(stop.ok && stop.result.kind === 'stop' && stop.result.state === 'not_running', JSON.stringify(stop));
  });
});

describe('a run is refused without a Flux MCP route or for another client', () => {
  test('no Flux MCP URL: not_available', async () => {
    const slot = await startTestSlot();
    try {
      const bindingId = await bind(slot, 'run_ok');
      const out = await callSupervisor(target(slot), runRequest(bindingId), { timeoutMs: 10_000 });
      assert.deepEqual(out, { ok: false, code: 'not_available' });
    } finally { await slot.close(); }
  });
});

async function assertMissing(path: string) {
  await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === 'ENOENT', `${path} is removed`);
}
