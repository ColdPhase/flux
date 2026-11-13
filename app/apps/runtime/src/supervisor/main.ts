import { randomUUID } from 'node:crypto';
import { chmod, chown, lstat, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { url as inspectorUrl } from 'node:inspector';
import { totalmem } from 'node:os';
import { parseRuntimeEngines, RUNTIME_PORTS, RUNTIME_SECRET, SLOT_NAME } from '@flux/runtime-protocol';
import { runCapacity } from './capacity.js';
import type { SupervisorConfig } from './handlers.js';
import { hostProblem } from './requirements.js';
import { findSandbox } from './sandbox.js';
import { createSupervisorServer } from './server.js';
import { CLI_PATHS } from './templates.js';

// The runtime's main process (F-022 "The supervisor", #860): one supervisor for everyone. It reads its name and its own secret
// from the environment Compose gives it, keeps a fresh boot id, and listens on its network for the manager. Each person's CLIs
// run under their own user id, so this process keeps only the capabilities that takes. It never logs a request body, CLI output
// or a credential.

/** The file the Compose health check looks for: written only once the supervisor listens. */
const READY_FILE = '/tmp/.flux-runtime-ready';

/**
 * Stops the runtime with one clear message and the fix. It does not exit: the restart policy would start it again every few
 * seconds forever (#860). It stays up without listening, its health check stays red, and `./flux up` fails with this line.
 */
function refuse(message: string): never {
  console.error(JSON.stringify({ event: 'runtime_refused', message }));
  setInterval(() => undefined, 2 ** 30);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  throw new RuntimeRefused();
}
class RuntimeRefused extends Error {}

async function start() {
  // The CLIs must not read this process's /proc environ or write its memory, and a CLI must not open its inspector. A runtime with
  // missing hardening or ptrace_scope=0 never listens, so the worker cannot admit it.
  if (process.execArgv.length !== 1 || process.execArgv[0] !== '--disable-sigusr1' || process.env.NODE_OPTIONS || inspectorUrl()) {
    refuse('The agent runtime must start with only --disable-sigusr1, an empty NODE_OPTIONS and no active inspector. Use the image of this version as it is.');
  }
  // No Yama module at all (Docker Desktop's LinuxKit kernel) is the same refusal as scope 0: absence never bypasses the gate.
  const status = await readFile('/proc/self/status', 'utf8').catch(() => '');
  const problem = hostProblem({
    ptraceScope: await readFile('/proc/sys/kernel/yama/ptrace_scope', 'utf8').catch(() => ''),
    uid: process.getuid?.() ?? null,
    effectiveCapabilities: /^CapEff:\s+([0-9a-f]+)$/m.exec(status)?.[1] ?? '',
  });
  if (problem) refuse(problem);
  // Root's supplementary groups must not follow a person's CLI: `spawn` drops them, the sign-in console's terminal does not.
  process.setgroups?.([]);
  createRequire(import.meta.url)('../../native/protect.node');

  const env = process.env;
  const slot = env.FLUX_RUNTIME_SLOT ?? '';
  const secret = env.FLUX_RUNTIME_SLOT_SECRET ?? '';
  if (!SLOT_NAME.test(slot)) refuse('FLUX_RUNTIME_SLOT must name this runtime (runtime-<n>). Use the Compose files of this version.');
  if (!RUNTIME_SECRET.test(secret)) refuse(`FLUX_RUNTIME_SLOT_SECRET for ${slot} is missing or shorter than 32 characters; ./flux generates it in docker/.env.`);

  // People's directories sit under a directory only the supervisor can list.
  const dataDir = '/data';
  const data = await lstat(dataDir);
  if (!data.isDirectory() || data.isSymbolicLink()) refuse('/data must be the runtime\'s own volume.');
  if (data.uid !== 0) await chown(dataDir, 0, 0);
  await chmod(dataDir, 0o711);

  let capacity = 1;
  try {
    // This container's memory limit, when it has one below the machine's.
    const limit = process.constrainedMemory();
    capacity = runCapacity(env.FLUX_RUNTIME_MAX_RUNS, limit > 0 ? Math.min(limit, totalmem()) : totalmem());
  } catch (error) { refuse((error as Error).message); }

  // The CLIs keep their own shell and file tools only inside Flux's sandbox (#1437, RT-5); without it they run as before, and it says so once.
  const sandbox = await findSandbox();
  if (!sandbox.setup) console.log(JSON.stringify({ event: 'tools_off', reason: sandbox.reason }));

  let engines: ReturnType<typeof parseRuntimeEngines> = { clients: [], pi: false };
  try { engines = parseRuntimeEngines(env.FLUX_AGENT_RUNTIME); } catch (error) { refuse((error as Error).message); }

  const config: SupervisorConfig = {
    slot,
    secret,
    bootId: randomUUID(),
    dataDir,
    tmpDir: '/tmp',
    separate: true,
    capacity,
    enabled: engines.clients,
    pi: engines.pi,
    cliPaths: CLI_PATHS,
    egressHost: 'runtime-egress',
    bindingLimitBytes: 256 * 1024 * 1024,
    cliTimeoutMs: 30_000,
    // TEST ONLY (#1437): the check images run the real CLIs through wrapper scripts, whose programs the CLI's domain must also execute.
    sandbox: sandbox.setup && env.FLUX_RUNTIME_TEST_EXEC
      ? { ...sandbox.setup, testExec: env.FLUX_RUNTIME_TEST_EXEC.split(':').filter((path) => path.startsWith('/')) } : sandbox.setup,
  };

  const { server } = createSupervisorServer(config);
  server.listen(RUNTIME_PORTS.supervisor, '0.0.0.0', () => {
    // Only the health check reads it, as root. The container's /tmp is new at each start, so nobody can have put anything here first.
    void writeFile(READY_FILE, '', { mode: 0o600, flag: 'wx' }).catch(() => undefined).then(() => console.log(JSON.stringify({ event: 'ready', slot, bootId: config.bootId, enabled: config.enabled, pi: config.pi, capacity, landlock: sandbox.setup?.abi ?? 0 })));
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

await start().catch((error: unknown) => { if (!(error instanceof RuntimeRefused)) throw error; });
