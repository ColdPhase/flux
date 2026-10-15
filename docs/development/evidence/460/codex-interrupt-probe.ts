import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { startClientModelMock } from '/app/tests/app/support/client-model-mock.js';

// Isolated native primitive, NOT a Flux adapter/product cancellation or instruction-delivery test.
const home = mkdtempSync(join(tmpdir(), 'codex-interrupt-private-'));
const marker = 'PRIVATE_LATE_TIMER_SHOULD_NOT_REACH_MODEL';
const model = await startClientModelMock(turn => turn.outputs.length === 0
  ? { js: `await new Promise(resolve => setTimeout(resolve, 30000)); text(${JSON.stringify(marker)});` }
  : { text: 'Private timer completed.' });
const child = spawn('codex', ['-c', 'model_provider="mock"', '-c',
  `model_providers.mock={name="mock",base_url="http://127.0.0.1:${model.port}/v1",env_key="MOCK_MODEL_KEY",wire_api="responses",supports_websockets=false}`, 'app-server'],
{ cwd: home, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, MOCK_MODEL_KEY: 'not-a-vendor-key', RUST_LOG: 'warn' }, stdio: ['pipe', 'pipe', 'pipe'] });
const events: Record<string, any>[] = [];
const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
let next = 0;
const lines = readline.createInterface({ input: child.stdout });
let errors = '';
child.stderr.on('data', chunk => { errors = (errors + String(chunk)).slice(-4000); });
lines.on('line', line => {
  const message = JSON.parse(line);
  if (message.id !== undefined && pending.has(message.id)) {
    const waiting = pending.get(message.id)!; pending.delete(message.id);
    if (message.error) waiting.reject(new Error(JSON.stringify(message.error))); else waiting.resolve(message.result);
  } else events.push(message);
});
async function finite<T>(work: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 12000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function rpc(method: string, params: unknown) {
  const id = ++next;
  const result = new Promise<any>((resolve, reject) => pending.set(id, { resolve, reject }));
  child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  return finite(result, `${method} did not complete`);
}
async function until(condition: () => boolean, label: string) {
  await finite((async () => { while (!condition()) await new Promise(resolve => setTimeout(resolve, 30)); })(), label);
}
try {
  await rpc('initialize', { clientInfo: { name: 'private-native-control-probe', version: '0.1' }, capabilities: { experimentalApi: false } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const started = await rpc('thread/start', { cwd: home, developerInstructions: 'Private native control primitive. No Flux instruction delivery is claimed.' });
  const threadId = started.thread.id;
  const turn = await rpc('turn/start', { threadId, input: [{ type: 'text', text: 'Run the private timer probe.' }] });
  const turnId = turn.turn.id;
  await until(() => model.requests.length > 0 && events.some(event => event.method === 'item/started'), 'actual native item never started');
  assert.ok(!events.some(event => event.method === 'turn/completed'), 'the actual native turn is still active');
  const callsBefore = model.requests.length;
  await rpc('turn/interrupt', { threadId, turnId });
  await until(() => events.some(event => event.method === 'turn/completed' && event.params?.turn?.id === turnId), 'interrupt ACK had no observed terminal turn');
  const terminal = events.find(event => event.method === 'turn/completed' && event.params?.turn?.id === turnId)!;
  assert.equal(terminal.params.turn.status, 'interrupted');
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(model.requests.length, callsBefore, 'interruption does not trigger another model call');
  assert.ok(!model.requests.some(request => request.raw.includes(marker)), 'late timer result did not reach a subsequent model request');
  console.log(JSON.stringify({ client: 'Codex rust-v0.160.1', platform: 'Linux/amd64 Docker', privateStdio: true,
    actualNativeItemStarted: true, interruptAck: true, terminalState: terminal.params.turn.status,
    modelRequestsBefore: callsBefore, modelRequestsAfter: model.requests.length, lateTimerResult: false,
    nativeSandboxOrApprovalBypass: false, FluxMcpCalls: 0, FluxCancellationOrBuiltinConnectAcceptance: false, model: 'scripted local only', vendorSpend: 0 }));
} catch (error) {
  console.error(String(error)); console.error(errors);
  process.exitCode = 1;
} finally {
  child.kill('SIGTERM'); await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  lines.close(); await model.close(); rmSync(home, { recursive: true, force: true });
}
