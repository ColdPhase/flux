// Escape attempts from inside a runtime slot (F-022 T3 #278), run by scripts/check_agent_runtime.sh as
// the slot's own user: `docker exec -i <slot> node --input-type=module - < probe-slot.mjs`. Targets come
// from FLUX_PROBE_* variables the script read with `docker inspect`. Every attempt must fail; the only
// ways out are runtime-egress's CONNECT to an allowed vendor host and its /mcp route to the API.
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';

const env = process.env;
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });

/** 'open', 'refused' (host reachable, nothing listening) or the error code of an unreachable target. */
function tcp(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(ms, () => done('timeout'));
    socket.on('connect', () => done('open'));
    socket.on('error', (error) => done(error.code === 'ECONNREFUSED' ? 'refused' : error.code ?? 'error'));
  });
}
const unreachable = (outcome) => !['open', 'refused'].includes(outcome);

/** Sends one raw HTTP request to runtime-egress and returns the status line's code. */
function raw(port, text, ms = 15000) {
  return new Promise((resolve) => {
    const socket = connect({ host: 'runtime-egress', port });
    let out = '';
    const done = () => { socket.destroy(); resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0)); };
    socket.setTimeout(ms, done);
    socket.on('data', (chunk) => { out += chunk; if (/\r\n\r\n/.test(out)) done(); });
    socket.on('error', done);
    socket.on('close', done);
    socket.write(text);
  });
}

// Controls: the probe does see what a slot may reach.
const egressOpen = await tcp('runtime-egress', 3128);
record('control: runtime-egress is reachable', egressOpen === 'open', egressOpen);
const egressName = await lookup('runtime-egress').then(() => 'resolved', (error) => error.code);
record('control: runtime-egress resolves', egressName === 'resolved', egressName);

for (const name of ['db', 'api', 'worker', 'migrate', 'runtime-2', 'runtime-5', 'runtime-install', 'mailpit']) {
  const outcome = await lookup(name).then(() => 'resolved', (error) => error.code);
  record(`name ${name} does not resolve`, outcome !== 'resolved', outcome);
}
const targets = [
  ['the database', env.FLUX_PROBE_DB, 5432],
  ['the API on the default network', env.FLUX_PROBE_API_DEFAULT, 8080],
  ['the API on runtime-api', env.FLUX_PROBE_API_RUNTIME, 8080],
  ['the API on runtime-control', env.FLUX_PROBE_API_CONTROL, 8080],
  ['the worker', env.FLUX_PROBE_WORKER, 8080],
  ['runtime-manager on runtime-control', env.FLUX_PROBE_MANAGER_CONTROL, 7600],
  ['another slot', env.FLUX_PROBE_OTHER_SLOT, 7700],
  ['the extra slot', env.FLUX_PROBE_EXTRA_SLOT, 7700],
  ['the cloud metadata address', '169.254.169.254', 80],
  ['the internet without the proxy', '1.1.1.1', 443],
  ['the host on its default-bridge address', env.FLUX_PROBE_GATEWAY, 22],
  ['the Docker API on the host', env.FLUX_PROBE_GATEWAY, 2375],
];
for (const [name, host, port] of targets) {
  if (!host) { record(`${name}: target known`, false, 'missing'); continue; }
  const outcome = await tcp(host, port);
  record(`${name} (${host}:${port}) is unreachable`, unreachable(outcome), outcome);
}
// runtime-manager is on this network to call the supervisor, but listens on none of the slot networks.
const manager = await tcp('runtime-manager', 7600);
record('runtime-manager listens on no slot network', manager === 'refused' || unreachable(manager), manager);
// runtime-egress's installer proxy listens only on the runtime-install network.
const install = await tcp('runtime-egress', 3129);
record('the installer proxy is not on a slot network', install !== 'open', install);

const connectStatus = (target) => raw(3128, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
for (const target of ['example.com:443', 'downloads.claude.ai:443', 'db:5432', 'api:8080', '169.254.169.254:80', 'runtime-2:7700', 'api.anthropic.com:80']) {
  const status = await connectStatus(target);
  record(`egress refuses CONNECT ${target}`, status === 403, status);
}
const vendor = await connectStatus('api.anthropic.com:443');
// 200 with internet access; 502 when this machine has none. Either way the policy let it through.
record('egress allows CONNECT api.anthropic.com:443', vendor === 200 || vendor === 502, vendor);
const plain = await raw(3128, 'GET http://api:8080/api/v1/health HTTP/1.1\r\nHost: api:8080\r\n\r\n');
record('egress is no plain HTTP proxy', plain === 405, plain);
for (const path of ['/api/v1/health', '/api/v1/me', '/mcp/../api/v1/me', '/', '/.well-known/oauth-authorization-server']) {
  const status = await raw(8080, `GET ${path} HTTP/1.1\r\nHost: runtime-egress\r\nConnection: close\r\n\r\n`);
  record(`egress does not forward ${path}`, status === 404, status);
}
const mcp = await fetch('http://runtime-egress:8080/mcp', { method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"initialize"}',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' } }).catch((error) => ({ status: error.code ?? 0, headers: new Headers() }));
record('egress forwards /mcp to the API (which asks for a token)', mcp.status === 401, mcp.status);

console.log(JSON.stringify({ slot: env.HOSTNAME, results }, null, 1));
const failed = results.filter((result) => !result.ok);
if (failed.length) {
  console.error(`FAILED: ${failed.map((result) => result.name).join('; ')}`);
  process.exit(1);
}
console.log(`PROBE=ok (${results.length} checks)`);
