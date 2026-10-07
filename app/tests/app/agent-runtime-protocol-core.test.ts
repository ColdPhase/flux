import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import {
  encodeFrame, FrameStreamError, NdjsonReader, parseRuntimeSwitch, parseSupervisorFrame, parseSupervisorRequest, redactSecrets,
  REQUEST_LIMITS, RUNTIME_CLIENTS, SUPERVISOR_REQUESTS, type SupervisorFrame,
} from '@flux/runtime-protocol';
import { AGENT_RUNTIME_CLIENTS } from '@flux/contracts';

// F-022 T3: the runtime's closed request set and the bounded reader of supervisor streams. No database,
// no network. The reader and the request parser see bytes a compromised slot or caller controls, so
// both are fuzzed with random input and must only ever refuse with their own error.

const binding = () => randomUUID();
const token = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ1In0.c2lnbmF0dXJlLWJ5dGVz';
const caps = { maxTurns: 10, wallClockSeconds: 300, idleSeconds: 60, maxAnswerBytes: 16384 };
const valid: Record<string, Record<string, unknown>> = {
  bind: { bindingId: binding() },
  status: {},
  login: { bindingId: binding(), bootId: randomUUID(), client: 'claude_code', method: 'console', cols: 80, rows: 24 },
  run: { bindingId: binding(), client: 'claude_code', runId: randomUUID(), prompt: 'Summarize the plan', runToken: token, tools: ['flux_get_doc', 'flux_list_docs'], caps },
  stop: { bindingId: binding(), runId: randomUUID() },
  logout: { bindingId: binding(), bootId: randomUUID(), client: 'codex' },
  release: { bindingId: binding() },
};

describe('the operator switch FLUX_AGENT_RUNTIME', () => {
  test('is empty by default and accepts each client once, in any order', () => {
    assert.deepEqual(parseRuntimeSwitch(undefined), []);
    assert.deepEqual(parseRuntimeSwitch(''), []);
    assert.deepEqual(parseRuntimeSwitch('claude_code'), ['claude_code']);
    assert.deepEqual(parseRuntimeSwitch('codex, claude_code'), ['claude_code', 'codex']);
    for (const bad of ['on', 'claude', 'claude_code,claude_code', 'claude_code;codex', 'CODEX', 'claude_code,,codex']) {
      assert.throws(() => parseRuntimeSwitch(bad), /FLUX_AGENT_RUNTIME/, bad);
    }
  });

  test('the public client names match the protocol', () => assert.deepEqual([...AGENT_RUNTIME_CLIENTS], [...RUNTIME_CLIENTS]));
});

describe('the supervisor\'s closed request set', () => {
  test('accepts exactly the seven requests with data-only fields', () => {
    assert.deepEqual([...SUPERVISOR_REQUESTS].sort(), ['bind', 'login', 'logout', 'release', 'run', 'status', 'stop']);
    for (const kind of SUPERVISOR_REQUESTS) assert.equal(parseSupervisorRequest(kind, valid[kind]).ok, true, kind);
    assert.equal(parseSupervisorRequest('status', { bindingId: binding(), bootId: randomUUID(), client: 'claude_code' }).ok, true);
  });

  test('refuses any other request name', () => {
    for (const kind of ['exec', 'shell', 'spawn', 'command', 'Bind', 'bind ', '__proto__', 'constructor', 'toString', '', 7, null]) {
      assert.deepEqual(parseSupervisorRequest(kind, {}), { ok: false, code: 'unknown_request' }, String(kind));
    }
  });

  test('refuses a command line, flag, path or environment value in any field', () => {
    const smuggled = { argv: ['--dangerously-skip-permissions'], args: ['-c', 'x'], command: 'sh -c id', cmd: 'id', flags: ['--tools', 'Bash'],
      path: '/data', cwd: '/', env: { PATH: '/tmp' }, environment: {}, cli: '/bin/sh', shell: true, executable: '/bin/sh', config: {} };
    for (const kind of SUPERVISOR_REQUESTS) {
      for (const [key, value] of Object.entries(smuggled)) {
        const parsed = parseSupervisorRequest(kind, { ...valid[kind], [key]: value });
        assert.equal(parsed.ok, false, `${kind} accepted ${key}`);
      }
      // JSON.parse creates an own "__proto__" key; it is an unknown field like any other.
      assert.equal(parseSupervisorRequest(kind, JSON.parse(`{"__proto__":{"admin":true},${JSON.stringify(valid[kind]).slice(1)}`.replace(',}', '}'))).ok, false);
    }
    const id = binding();
    const refused: [string, unknown][] = [
      ['bind', { bindingId: '../etc' }], ['bind', { bindingId: `/data/${id}` }], ['bind', { bindingId: id.toUpperCase() }],
      ['bind', { bindingId: `${id}/..` }], ['bind', { bindingId: '00000000-0000-0000-0000-000000000000' }],
      ['login', { ...valid.login, bindingId: id, client: 'bash' }], ['login', { ...valid.login, bindingId: id, client: 'codex' }],
      ['login', { ...valid.login, bindingId: id, method: 'setup_token' }], ['login', { ...valid.login, method: 'api_key' }],
      ['login', { ...valid.login, cols: 19 }], ['login', { ...valid.login, rows: 121 }], ['login', { ...valid.login, cols: 80.5 }],
      ['login', { bindingId: id, client: 'claude_code', method: 'console' }],
      ['logout', { bindingId: id, client: 'claude_code --all' }],
      ['run', { ...valid.run, tools: ['mcp__flux__*'] }], ['run', { ...valid.run, tools: ['flux_*'] }], ['run', { ...valid.run, tools: [] }],
      ['run', { ...valid.run, tools: ['flux_get_doc', 'flux_get_doc'] }], ['run', { ...valid.run, tools: ['flux_get_doc --tools Bash'] }],
      ['run', { ...valid.run, prompt: 'a\u0000b' }], ['run', { ...valid.run, prompt: '' }],
      ['run', { ...valid.run, prompt: 'x'.repeat(REQUEST_LIMITS.promptCharacters + 1) }],
      ['run', { ...valid.run, runToken: 'not a token' }], ['run', { ...valid.run, runToken: `${token} --verbose` }],
      ['run', { ...valid.run, caps: { ...caps, maxTurns: 0 } }], ['run', { ...valid.run, caps: { ...caps, wallClockSeconds: 10_000 } }],
      ['run', { ...valid.run, caps: { ...caps, extra: 1 } }], ['run', { ...valid.run, caps: { ...caps, maxTurns: 2.5 } }],
      ['status', { client: 'claude_code' }], ['status', { bindingId: id, client: 'gemini' }],
      ['stop', { bindingId: id, runId: 'run-1' }], ['release', {}], ['bind', []], ['bind', 'x'],
    ];
    for (const [kind, body] of refused) assert.equal(parseSupervisorRequest(kind, body).ok, false, `${kind} ${JSON.stringify(body).slice(0, 80)}`);
  });

  test('random bodies are refused or accepted only in the exact shape, never with an exception', () => {
    const pieces = [() => randomUUID(), () => '--help', () => 'claude_code', () => 'codex', () => 1, () => -1, () => null, () => true, () => [],
      () => ({}), () => 'flux_get_doc', () => randomBytes(8).toString('latin1'), () => token, () => 'console', () => 'x'.repeat(70000)];
    const keys = ['bindingId', 'client', 'method', 'runId', 'prompt', 'runToken', 'tools', 'caps', 'argv', 'path', 'env', 'kind'];
    for (let i = 0; i < 3000; i += 1) {
      const body: Record<string, unknown> = {};
      for (let k = 0; k < 1 + (i % 5); k += 1) body[keys[(i * 7 + k * 3) % keys.length]!] = pieces[(i + k * 5) % pieces.length]!();
      const kind = SUPERVISOR_REQUESTS[i % SUPERVISOR_REQUESTS.length]!;
      const parsed = parseSupervisorRequest(kind, body);
      if (parsed.ok) assert.ok(!('argv' in body) && !('path' in body) && !('env' in body) && !('kind' in body));
    }
  });
});

describe('the bounded reader of supervisor streams', () => {
  const frames: SupervisorFrame[] = [
    { t: 'accepted', kind: 'release', bootId: randomUUID() },
    { t: 'step', step: 'logout', outcome: 'ok', client: 'claude_code' },
    { t: 'result', result: { kind: 'release', bindingId: randomUUID(), logout: { claude_code: 'ok', codex: 'not_installed' }, dataEmpty: true, exiting: true } },
  ];
  const stream = Buffer.from(frames.map(encodeFrame).join(''));
  const limits = { lineBytes: 1024, totalBytes: 16 * 1024, frames: 16 };

  test('reads the same frames however the stream is split', () => {
    for (let size = 1; size <= stream.length; size += 7) {
      const reader = new NdjsonReader(parseSupervisorFrame, limits);
      const out: SupervisorFrame[] = [];
      for (let i = 0; i < stream.length; i += size) out.push(...reader.push(stream.subarray(i, i + size)));
      reader.end();
      assert.deepEqual(out, frames);
    }
  });

  test('refuses oversized, malformed, non-UTF-8, unknown and truncated input with its own error', () => {
    const cases: [Buffer, string][] = [
      [Buffer.from(`${'x'.repeat(2000)}\n`), 'line_too_long'],
      [Buffer.from('{"t":"accepted"\n'), 'malformed_json'],
      [Buffer.concat([Buffer.from('{"t":"error","code":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}\n')]), 'invalid_utf8'],
      [Buffer.from('{"t":"error","code":"rm -rf"}\n'), 'invalid_frame'],
      [Buffer.from('{"t":"error","code":"busy","extra":1}\n'), 'invalid_frame'],
      [Buffer.from('{"t":"error","code":"busy","__proto__":{"x":1}}\n'), 'invalid_frame'],
      [Buffer.from('[1,2,3]\n'), 'invalid_frame'],
      [Buffer.from(`${'{"t":"error","code":"busy"}\n'.repeat(17)}`), 'too_many_frames'],
      [Buffer.from(`${'['.repeat(400)}${']'.repeat(400)}\n`), 'invalid_frame'],
    ];
    for (const [bytes, code] of cases) {
      const reader = new NdjsonReader(parseSupervisorFrame, limits);
      assert.throws(() => reader.push(bytes), (error: unknown) => error instanceof FrameStreamError && error.code === code, code);
      // Once failed, the reader stays failed.
      assert.throws(() => reader.push(Buffer.from('{"t":"error","code":"busy"}\n')), FrameStreamError);
    }
    const total = new NdjsonReader(parseSupervisorFrame, { ...limits, totalBytes: 100 });
    assert.throws(() => total.push(Buffer.alloc(101, 0x20)), (error: unknown) => (error as FrameStreamError).code === 'stream_too_large');
    const truncated = new NdjsonReader(parseSupervisorFrame, limits);
    truncated.push(Buffer.from('{"t":"error"'));
    assert.throws(() => truncated.end(), (error: unknown) => (error as FrameStreamError).code === 'truncated');
  });

  test('fuzz: random bytes in random chunks only ever yield valid frames or a FrameStreamError', () => {
    const alphabet = Buffer.from('{}[]":,\n\\ tabcdefghijklmnopqrstuvwxyz0123456789-_é');
    for (let round = 0; round < 1500; round += 1) {
      const length = (round * 37) % 3000;
      const bytes = round % 3 === 0 ? randomBytes(length) : Buffer.from(Array.from({ length }, () => alphabet[Math.floor(Math.random() * alphabet.length)]!));
      if (round % 5 === 0) bytes.set(stream.subarray(0, Math.min(stream.length, bytes.length)));
      const reader = new NdjsonReader(parseSupervisorFrame, limits);
      try {
        for (let i = 0; i < bytes.length;) {
          const size = 1 + Math.floor(Math.random() * 300);
          for (const frame of reader.push(bytes.subarray(i, i + size))) assert.ok(parseSupervisorFrame(frame));
          i += size;
        }
        reader.end();
      } catch (error) {
        assert.ok(error instanceof FrameStreamError, `unexpected ${(error as Error)?.name}: ${(error as Error)?.message}`);
      }
    }
  });
});

describe('redaction of runtime error text', () => {
  test('removes token-shaped strings and named secrets', () => {
    const out = redactSecrets(`failed sk-ant-abc123DEF refresh_token=xyz Bearer abc.def eyJhbGciOi.eyJzdWIi.sig secret-${'s'.repeat(10)}`, [`secret-${'s'.repeat(10)}`]);
    for (const leaked of ['sk-ant-abc123DEF', 'xyz', 'abc.def', 'eyJhbGciOi', 'secret-ssss']) assert.ok(!out.includes(leaked), out);
    assert.equal(redactSecrets('slot runtime-2 unreachable'), 'slot runtime-2 unreachable');
  });
});
