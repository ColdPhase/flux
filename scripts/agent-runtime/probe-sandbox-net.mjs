// The network as a run's own tools see it (#1437, RT-5): scripts/check_agent_runtime.sh step 9e has the fake Claude Code run this inside
// Flux's sandbox shell, on the runtime's real networks, during a real run. Targets come from FLUX_PROBE_* variables the script read with
// `docker inspect`. Nothing but the runtime's egress is reachable at all; where the kernel has Landlock's network rules (ABI 4,
// FLUX_PROBE_TCP_RULE=1, which the tools now need) not even that: a tool has no socket at all. It prints one JSON line and NETPROBE=ok or NETPROBE=failed.
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { createSocket } from 'node:dgram';
import { connect } from 'node:net';

const env = process.env;
const tcpRule = env.FLUX_PROBE_TCP_RULE === '1';
const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail });
function tcp(host, port, ms = 3000) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(ms, () => done('timeout'));
    socket.on('connect', () => done('open'));
    socket.on('error', (error) => done(error.code === 'ECONNREFUSED' ? 'refused' : error.code ?? 'error'));
  });
}
function connectStatus(target, ms = 15000) {
  return new Promise((resolve) => {
    const socket = connect({ host: 'runtime-egress', port: 3128 });
    let out = '';
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(ms, () => done('timeout'));
    socket.on('data', (chunk) => { out += chunk; if (/\r\n\r\n/.test(out)) done(Number(/^HTTP\/1\.1 (\d{3})/.exec(out)?.[1] ?? 0)); });
    socket.on('error', (error) => done(error.code ?? 'error'));
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}
const targets = [
  ['the database', env.FLUX_PROBE_DB, 5432], ['Redis-like services on the default network (the worker)', env.FLUX_PROBE_WORKER, 8080],
  ['the API on the default network', env.FLUX_PROBE_API_DEFAULT, 8080], ['the API on runtime-api', env.FLUX_PROBE_API_RUNTIME, 8080],
  ['the API on runtime-control', env.FLUX_PROBE_API_CONTROL, 8080], ['runtime-manager on runtime-control', env.FLUX_PROBE_MANAGER_CONTROL, 7600],
  ['the cloud metadata address', '169.254.169.254', 80], ['a host on the internet', '1.1.1.1', 443],
  ['the host on its default-bridge address', env.FLUX_PROBE_GATEWAY, 22], ['the Docker API on the host', env.FLUX_PROBE_GATEWAY, 2375],
];
for (const [name, host, port] of targets) {
  if (!host) { record(`${name}: target known`, false, 'missing'); continue; }
  const outcome = await tcp(host, port);
  record(`${name} (${host}:${port}) is unreachable`, outcome !== 'open', outcome);
}
for (const name of ['example.com', 'db', 'api']) {
  const outcome = await lookup(name).then(() => 'resolved', (error) => error.code);
  record(`name ${name} does not resolve`, outcome !== 'resolved', outcome);
}
record('no Docker or Podman socket', !['/var/run/docker.sock', '/run/docker.sock', '/run/podman/podman.sock'].some((path) => existsSync(path)), '');
const egress = await tcp('runtime-egress', 3128);
// No socket at all (seccomp: EAFNOSUPPORT) and no TCP (Landlock ABI 4: EACCES); the tools run only where both hold (#1437).
const refused = (outcome) => outcome === 'EAFNOSUPPORT' || outcome === 'EACCES';
const udp = await new Promise((resolve) => {
  const socket = createSocket('udp4');
  socket.on('error', (error) => { socket.close(); resolve(error.code ?? 'error'); });
  socket.send('flux-probe', 53, '127.0.0.11', (error) => { if (!error) { socket.close(); resolve('sent'); } });
});
record('no UDP, not even to Docker\'s DNS', udp !== 'sent', udp);
if (tcpRule) {
  record('no TCP at all, not even to the egress', refused(egress), egress);
  record('nor to its /mcp forwarder', refused(await tcp('runtime-egress', 8080)), '');
} else {
  record('control: the egress is the one way out', egress === 'open', egress);
  for (const target of ['example.com:443', 'db:5432', '169.254.169.254:80']) {
    const status = await connectStatus(target);
    record(`the egress refuses CONNECT ${target}`, status === 403, status);
  }
}
console.log(JSON.stringify({ tcpRule, results }));
console.log(results.every((result) => result.ok) ? `NETPROBE=ok (${results.length} checks)` : `NETPROBE=failed: ${results.filter((result) => !result.ok).map((result) => result.name).join('; ')}`);
