import { randomUUID } from 'node:crypto';
import { chmod, lstat } from 'node:fs/promises';
import { parseRuntimeSwitch, RUNTIME_PORTS, RUNTIME_SECRET, SLOT_NAME } from '@flux/runtime-protocol';
import type { SupervisorConfig } from './handlers.js';
import { createSupervisorServer } from './server.js';
import { CLI_PATHS } from './templates.js';

// A runtime slot's main process (F-022 "The supervisor"). It reads its slot name and its own secret
// from the environment Compose gives this slot only, keeps a fresh boot id, and listens on the slot's
// network for the manager. It never logs a request body, CLI output or a credential.

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
