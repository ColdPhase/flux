// The closed request set of the live supervisors (F-022 T3 #278), run inside runtime-manager (the only
// service that holds slot secrets) by scripts/check_agent_runtime.sh:
// `docker exec -i <runtime-manager> node --input-type=module - < probe-supervisor.mjs`.
// FLUX_PROBE_BOUND_SLOT names a slot that holds a binding; FLUX_PROBE_BINDING is its binding id.
const env = process.env;
const secret = (slot) => env[`FLUX_RUNTIME_SLOT_${slot.slice(8)}`];
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

async function post(slot, path, body, key = secret(slot), method = 'POST') {
  const response = await fetch(`http://${slot}:7700${path}`, { method, body: method === 'GET' ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) } });
  const frames = (await response.text()).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { status: response.status, frames, last: frames.at(-1) };
}

const slot = env.FLUX_PROBE_BOUND_SLOT;
const other = slot === 'runtime-1' ? 'runtime-2' : 'runtime-1';
const bindingId = env.FLUX_PROBE_BINDING;
const fresh = crypto.randomUUID();

let answer = await post(slot, '/v1/status', {}, null);
record('no secret: unauthorized', answer.status === 401 && answer.last?.code === 'unauthorized', answer.status);
answer = await post(slot, '/v1/status', {}, secret(other));
record("another slot's secret: unauthorized", answer.status === 401, answer.status);
for (const path of ['/v1/exec', '/v1/shell', '/v1/spawn', '/v1/command', '/v1/']) {
  answer = await post(slot, path, { command: 'id' });
  record(`${path}: unknown request`, answer.status === 404 && answer.last?.code === 'unknown_request', answer.status);
}
answer = await post(slot, '/v1/status', undefined, secret(slot), 'GET');
record('GET is not a request', answer.status === 404, answer.status);
const refused = [
  ['/v1/bind', { bindingId: fresh, argv: ['--dangerously-skip-permissions'] }],
  ['/v1/bind', { bindingId: '../../etc' }],
  ['/v1/logout', { bindingId, client: 'claude_code', env: { PATH: '/tmp' } }],
  ['/v1/logout', { bindingId, client: '/bin/sh' }],
  ['/v1/login', { bindingId, client: 'claude_code', method: 'setup_token', cols: 80, rows: 24 }],
  ['/v1/login', { bindingId, client: 'claude_code', method: 'sso', cols: 80, rows: 24, flags: ['--api-key'] }],
  ['/v1/status', { bindingId, client: 'claude_code', path: '/data' }],
  ['/v1/run', { bindingId, client: 'claude_code', runId: crypto.randomUUID(), prompt: 'x', runToken: 'a.b.c', tools: ['mcp__flux__*'],
    caps: { maxTurns: 1, wallClockSeconds: 10, idleSeconds: 5, maxAnswerBytes: 1024 } }],
  ['/v1/release', { bindingId, cwd: '/' }],
];
for (const [path, body] of refused) {
  answer = await post(slot, path, body);
  record(`${path} with ${Object.keys(body).join(',')}: invalid request`, answer.status === 400 && answer.last?.code === 'invalid_request', answer.status);
}
answer = await post(slot, '/v1/bind', { bindingId: fresh });
record('bind is refused while /data holds a binding', answer.status === 200 && answer.last?.code === 'data_not_empty', JSON.stringify(answer.last));
answer = await post(slot, '/v1/status', {});
const report = answer.last?.result?.slot;
record('the slot report names this slot and its binding only', report?.slot === slot && report.data.bindings.length === 1 && report.data.bindings[0] === bindingId, JSON.stringify(report?.data));
answer = await post(slot, '/v1/status', { bindingId, client: 'claude_code' });
record('client status runs the fixed template', answer.status === 200 && answer.last?.t === 'result' && typeof answer.last.result.client.signedIn === 'boolean', JSON.stringify(answer.last));
answer = await post(slot, '/v1/login', { bindingId, client: 'claude_code', method: 'console', cols: 80, rows: 24 });
record('login runs only in the sign-in console, never as a plain request (T4)', answer.status === 200 && answer.last?.code === 'invalid_request', JSON.stringify(answer.last));

// The manager's own API checks the closed set before anything reaches a supervisor.
const manager = (path, body) => fetch(`http://runtime-manager-control:7600${path}`, { method: 'POST', body: JSON.stringify(body),
  headers: { authorization: `Bearer ${env.FLUX_RUNTIME_MANAGER_SECRET}`, 'content-type': 'application/json' } });
record('manager: unknown slot', (await manager('/v1/slots/runtime-99/status', {})).status === 404, '');
record('manager: unknown request', (await manager(`/v1/slots/${slot}/exec`, { command: 'id' })).status === 400, '');
record('manager: smuggled field', (await manager(`/v1/slots/${slot}/logout`, { bindingId, client: 'claude_code', argv: ['x'] })).status === 400, '');
record('manager: a plain login request is refused (console only)', (await manager(`/v1/slots/${slot}/login`, { bindingId, client: 'claude_code', method: 'sso', cols: 80, rows: 24 })).status === 400, '');

console.log(JSON.stringify(results, null, 1));
const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(`FAILED: ${failed.map((result) => result.name).join('; ')}`);
  process.exit(1);
}
console.log(`SUPERVISOR=ok (${results.length} checks)`);
