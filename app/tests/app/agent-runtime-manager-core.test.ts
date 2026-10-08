import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import {
  callSupervisor, createRuntimeManagerClient, encodeFrame, runtimeManagerPort, type SupervisorRequest, type SupervisorTarget,
} from '@flux/runtime-protocol';
import { createManagerServer, slotsFromEnv } from '../../apps/runtime/src/manager/server.js';
import { portOf, slotSecret, startTestSlot, type TestSlot } from './support/runtime-slot.js';

// F-022 T3: runtime-manager in process with two real supervisors, and the manager's reader of supervisor
// streams against misbehaving slots. A compromised slot controls every byte it answers; the manager must
// only ever turn that into one of its own error codes.

const listen = async (server: Server) => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

describe('runtime-manager with two slots', () => {
  let one: TestSlot;
  let two: TestSlot;
  let server: Server;
  let url: string;
  const secret = slotSecret();
  const forwarded: SupervisorRequest[] = [];
  before(async () => {
    one = await startTestSlot({ slot: 'runtime-1' });
    two = await startTestSlot({ slot: 'runtime-2' });
    const slots = new Map<string, SupervisorTarget>([
      ['runtime-1', { host: '127.0.0.1', port: portOf(one.url), secret: one.config.secret }],
      ['runtime-2', { host: '127.0.0.1', port: portOf(two.url), secret: two.config.secret }],
    ]);
    server = createManagerServer({ secret, slots, log: () => undefined, call: (target, request) => { forwarded.push(request); return callSupervisor(target, request); } });
    url = await listen(server);
  });
  after(async () => { server.close(); await one.close(); await two.close(); });

  test('needs the service secret', async () => {
    for (const authorization of [undefined, `Bearer ${one.config.secret}`, 'Bearer x']) {
      const response = await fetch(`${url}/v1/slots`, { headers: authorization ? { authorization } : {} });
      assert.equal(response.status, 401);
    }
  });

  test('lists every slot with its report and drives each one only with that slot\'s secret', async () => {
    const client = createRuntimeManagerClient({ url, secret });
    const slots = await client.slots();
    assert.ok(slots.ok);
    assert.deepEqual(slots.slots.map((entry) => [entry.slot, entry.reachable]), [['runtime-1', true], ['runtime-2', true]]);
    const bindingId = randomUUID();
    const bound = await client.request('runtime-2', { kind: 'bind', bindingId });
    assert.ok(bound.ok && bound.result.kind === 'bind');
    const port = runtimeManagerPort(client);
    const view = await port.slots();
    assert.ok(view.ok);
    assert.deepEqual(view.value.map((entry) => entry.reachable && entry.bindings), [[], [bindingId]]);
    const released = await port.release('runtime-2', bindingId);
    assert.deepEqual(released, { ok: true, value: { dataEmpty: true, logoutFailed: false } });
  });

  test('checks every request against the closed set before forwarding it', async () => {
    const before = forwarded.length;
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' } });
    assert.equal((await post('/v1/slots/runtime-9/status', {})).status, 404);
    assert.equal((await post('/v1/slots/db/status', {})).status, 404);
    assert.equal((await post('/v1/slots/runtime-1/exec', { command: 'id' })).status, 400);
    assert.equal((await post('/v1/slots/runtime-1/bind', { bindingId: '../../etc' })).status, 400);
    assert.equal((await post('/v1/slots/runtime-1/logout', { bindingId: randomUUID(), client: 'claude_code', argv: ['--all'] })).status, 400);
    assert.equal((await post('/v1/slots/runtime-1/status/../../v1/slots', {})).status, 404);
    assert.equal(forwarded.length, before, 'nothing invalid reached a supervisor');
  });

  test('cannot report sign-out success when a CLI is missing or logout is skipped', async () => {
    for (const scenario of ['missing_cli', 'missing_binding', 'unsafe_binding'] as const) {
      const slot = await startTestSlot({ withClis: scenario !== 'missing_cli', enabled: [] });
      const manager = createManagerServer({ secret, slots: new Map([
        ['runtime-1', { host: '127.0.0.1', port: portOf(slot.url), secret: slot.config.secret }],
      ]), log: () => undefined });
      try {
        const client = createRuntimeManagerClient({ url: await listen(manager), secret });
        const port = runtimeManagerPort(client);
        const binding = randomUUID();
        if (scenario !== 'missing_binding') assert.ok((await port.bind('runtime-1', binding)).ok);
        if (scenario === 'unsafe_binding') await chmod(`${slot.config.dataDir}/${binding}`, 0o755);
        // Missing CLI gives not_installed; missing/unsafe bindings give skipped.
        assert.deepEqual(await port.release('runtime-1', binding), { ok: true, value: { dataEmpty: true, logoutFailed: true } });
      } finally { manager.close(); await slot.close(); }
    }
  });

  test('slot targets come only from FLUX_RUNTIME_SLOT_<n>', () => {
    const env = { FLUX_RUNTIME_SLOT_1: slotSecret(), FLUX_RUNTIME_SLOT_12: slotSecret(), FLUX_RUNTIME_SLOT_0: slotSecret(), FLUX_RUNTIME_SLOT_X: 'x', FLUX_RUNTIME_SLOT_5: '' };
    assert.deepEqual([...slotsFromEnv(env, /^[A-Za-z0-9_-]{32,256}$/).keys()], ['runtime-1', 'runtime-12']);
    assert.throws(() => slotsFromEnv({ FLUX_RUNTIME_SLOT_3: 'short' }, /^[A-Za-z0-9_-]{32,256}$/), /FLUX_RUNTIME_SLOT_3/);
  });
});

describe('the manager\'s reader of a misbehaving supervisor', () => {
  // A fake slot that answers whatever the case says, as a compromised slot could.
  let answer: (res: import('node:http').ServerResponse) => void = (res) => res.end();
  let server: Server;
  let target: SupervisorTarget;
  before(async () => {
    server = createHttpServer((req, res) => { req.resume(); req.on('end', () => answer(res)); });
    const url = await listen(server);
    target = { host: '127.0.0.1', port: portOf(url), secret: slotSecret() };
  });
  after(() => { server.close(); });
  const ndjson = (status: number, text: string | Buffer) => (res: import('node:http').ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/x-ndjson' });
    res.end(text);
  };
  const bootId = randomUUID();
  const accepted = encodeFrame({ t: 'accepted', kind: 'status', bootId });
  const report = { kind: 'status', slot: { slot: 'runtime-1', bootId, data: { empty: true, bindings: [], other: 0 }, tmpEmpty: true,
    installed: { claude_code: true, codex: false }, enabled: ['claude_code'], busy: false } };

  test('accepts only accepted → steps → one result of the request\'s kind → end', async () => {
    answer = ndjson(200, accepted + encodeFrame({ t: 'result', result: report }));
    assert.equal((await callSupervisor(target, { kind: 'status' })).ok, true);
    const cases: [string, (res: import('node:http').ServerResponse) => void][] = [
      ['no accepted frame', ndjson(200, encodeFrame({ t: 'result', result: report }))],
      ['accepted for another request', ndjson(200, encodeFrame({ t: 'accepted', kind: 'release', bootId }) + encodeFrame({ t: 'result', result: report }))],
      ['two accepted frames', ndjson(200, accepted + accepted + encodeFrame({ t: 'result', result: report }))],
      ['a frame after the result', ndjson(200, accepted + encodeFrame({ t: 'result', result: report }) + encodeFrame({ t: 'error', code: 'busy' }))],
      ['a result of another kind', ndjson(200, accepted + encodeFrame({ t: 'result', result: { kind: 'bind', bindingId: randomUUID() } }))],
      ['no result', ndjson(200, accepted)],
      ['an extra field', ndjson(200, accepted + encodeFrame({ t: 'result', result: { ...report, cli: 'output' } }))],
      ['a report with a token-shaped field', ndjson(200, accepted + encodeFrame({ t: 'result', result: { ...report, slot: { ...report.slot, credentials: 'sk-ant-x' } } }))],
      ['an oversized line', ndjson(200, accepted + `{"t":"error","code":"${'x'.repeat(70_000)}"}\n`)],
      ['a truncated line', ndjson(200, accepted + '{"t":"result"')],
      ['invalid UTF-8', ndjson(200, Buffer.concat([Buffer.from(accepted), Buffer.from([0xff, 0xfe, 0x0a])]))],
      ['the wrong content type', (res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(accepted); }],
      ['a server error', ndjson(500, accepted)],
      ['a redirect', (res) => { res.writeHead(302, { location: 'http://db:5432/' }); res.end(); }],
      ['a never-ending stream', (res) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); const timer = setInterval(() => res.write(' '), 5); res.on('close', () => clearInterval(timer)); }],
      ['a huge stream', (res) => { res.writeHead(200, { 'content-type': 'application/x-ndjson' }); res.write(accepted); for (let i = 0; i < 40; i += 1) res.write(`${encodeFrame({ t: 'step', step: 'logout', outcome: 'ok' })}`.repeat(1000)); res.end(); }],
    ];
    for (const [name, behavior] of cases) {
      answer = behavior;
      const outcome = await callSupervisor(target, { kind: 'status' }, { timeoutMs: 1_500 });
      assert.equal(outcome.ok, false, name);
      assert.ok(!outcome.ok && ['protocol', 'timeout'].includes(outcome.code), `${name}: ${!outcome.ok && outcome.code}`);
    }
  });

  test('fuzz: random answers only ever become an error code, never an exception or a result', async () => {
    for (let round = 0; round < 200; round += 1) {
      const bytes = round % 4 === 0 ? randomBytes(round * 13) : Buffer.from(accepted + randomBytes(round * 7).toString('latin1') + '\n');
      answer = ndjson(200, bytes);
      const outcome = await callSupervisor(target, { kind: 'status' }, { timeoutMs: 2_000 });
      assert.equal(outcome.ok, false);
    }
  });
});
