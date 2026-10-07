import { randomUUID } from 'node:crypto';
import { chmod, lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { url as inspectorUrl } from 'node:inspector';
import { parseRuntimeSwitch, RUNTIME_PORTS, RUNTIME_SECRET, SLOT_NAME } from '@flux/runtime-protocol';
import type { SupervisorConfig } from './handlers.js';
import { createSupervisorServer } from './server.js';
import { CLI_PATHS } from './templates.js';

// A runtime slot's main process (F-022 "The supervisor"). It reads its slot name and its own secret
// from the environment Compose gives this slot only, keeps a fresh boot id, and listens on the slot's
// network for the manager. It never logs a request body, CLI output or a credential.

// The CLI shares our uid, but must not read our /proc environ or write our memory. A slot
// with missing hardening or ptrace_scope=0 never listens, so the worker cannot admit it.
// A same-uid CLI can send SIGUSR1. Without this flag Node opens an inspector that
// can evaluate code and expose the secret despite /proc protection.
if (process.execArgv.length !== 1 || process.execArgv[0] !== '--disable-sigusr1' || process.env.NODE_OPTIONS || inspectorUrl()) {
  throw new Error('Runtime slots require only --disable-sigusr1, empty NODE_OPTIONS and no active inspector; no slot was admitted');
}
const ptraceScope = (await readFile('/proc/sys/kernel/yama/ptrace_scope', 'utf8')).trim();
if (!/^[1-3]$/.test(ptraceScope)) throw new Error('Runtime slots require Linux Yama ptrace_scope >= 1; no slot was admitted');
createRequire(import.meta.url)('../../native/protect.node');

const env = process.env;
const slot = env.FLUX_RUNTIME_SLOT ?? '';
const secret = env.FLUX_RUNTIME_SLOT_SECRET ?? '';
if (!SLOT_NAME.test(slot)) throw new Error('FLUX_RUNTIME_SLOT must name this slot (runtime-<n>)');
if (!RUNTIME_SECRET.test(secret)) throw new Error(`FLUX_RUNTIME_SLOT_SECRET for ${slot} is missing or shorter than 32 characters; ./flux generates it in docker/.env`);

const dataDir = '/data';
const data = await lstat(dataDir);
if (!data.isDirectory() || data.isSymbolicLink() || (process.getuid && data.uid !== process.getuid())) throw new Error('/data must be this slot\'s own directory');
if ((data.mode & 0o777) !== 0o700) await chmod(dataDir, 0o700);

const config: SupervisorConfig = {
  slot,
  secret,
  bootId: randomUUID(),
  dataDir,
  tmpDir: '/tmp',
  enabled: parseRuntimeSwitch(env.FLUX_AGENT_RUNTIME),
  cliPaths: CLI_PATHS,
  egressHost: 'runtime-egress',
  bindingLimitBytes: 256 * 1024 * 1024,
  cliTimeoutMs: 30_000,
};

const { server } = createSupervisorServer(config, () => {
  console.log(JSON.stringify({ event: 'released', slot, bootId: config.bootId }));
  server.close();
  // The restart policy starts a fresh process: a new boot id and an empty tmpfs /tmp.
  process.exit(0);
});
server.listen(RUNTIME_PORTS.supervisor, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'ready', slot, bootId: config.bootId, enabled: config.enabled }));
});
const stop = () => { server.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
