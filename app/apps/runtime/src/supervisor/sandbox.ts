import { spawn } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readdir, readFile, rmdir, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { asThem, bindingBytes, removeAsThem } from './data.js';
import { asPerson, runFixed, type Person } from './process.js';

// The per-run sandbox of a CLI's own tools (#1437, RT-5). Claude Code and Codex keep their shell and file tools; what bounds them
// is the container, its egress and this: a scratch directory that exists for one run, Flux's sandbox shell around every command they
// run (native/sandbox.c, Linux Landlock applied by the process to itself), an outer domain around the CLI that may execute nothing but
// the CLI's own program and that shell, the broker that starts each shell outside the CLI's domain, and the limits below, which the
// supervisor measures while the run lasts. Without Landlock ABI 4 the runtime does not start (founder decision 2026-11-13, #1441): there is
// no mode where agents run without their own shell and files.

/** Flux's sandbox (native/sandbox.c) in the runtime image: the program, and the directory of the shell names it answers to. */
export const SANDBOX = {
  binary: '/opt/flux-runtime/sandbox/flux-sandbox',
  bin: '/opt/flux-runtime/sandbox/bin',
  shell: '/opt/flux-runtime/sandbox/bin/bash',
} as const;

/** The runtime's memory file system for scratches (Compose `tmpfs: /scratch`). */
export const SCRATCH_ROOT = '/scratch';

/** What one run's tools may use (docs/operations/agent-runtime.md "What each agent needs"); the sandbox sets the rest itself. */
export const RUN_TOOL_LIMITS = {
  /** Resident memory of every process of the run but the CLI itself. */
  memoryBytes: 512 * 1024 ** 2,
  /** The scratch, which is memory too. */
  scratchBytes: 256 * 1024 ** 2,
  /** Processes and threads of the person, the CLI's included (the sandbox's RLIMIT_NPROC stops a fork past it). */
  tasks: 256,
  /** How often the supervisor measures. */
  everyMs: 1000,
} as const;

/** The sandbox as this runtime found it at start: Landlock's ABI version, and where scratches go. */
export interface SandboxSetup { binary: string; shell: string; bin: string; abi: number; scratchRoot: string;
  /** TEST ONLY: files or directories a check image's CLI wrapper must also execute (`FLUX_RUNTIME_TEST_EXEC`); never set in a release. */
  testExec?: readonly string[] }

/** The oldest Landlock the runtime starts on: ABI 4 (Linux 6.7) forbids TCP, so a shell cannot tunnel through the egress (#1437). */
export const LANDLOCK_ABI_FOR_TOOLS = 4;

/** The one sentence for a kernel without Landlock ABI 4 (founder decision 2026-11-13, #1441): the runtime, and so Flux AI, does not start. */
export const NEWER_LINUX_NEEDED = 'Flux AI needs a newer Linux (kernel 6.7 or later, e.g. Ubuntu 24.04 or Debian 13).';

/**
 * The sandbox every run's tools work in (RT-5): the kernel has Landlock with network rules (ABI 4 or later; coordinator decision on #1437:
 * before it a shell could reach the egress and, through it, an allowed vendor host under another account) and the scratch root is a
 * directory only the supervisor can write. Anything else is the reason the runtime refuses to start (founder decision 2026-11-13, #1441):
 * agents never run without their own shell and files.
 */
export async function findSandbox(binary: string = SANDBOX.binary, scratchRoot: string = SCRATCH_ROOT): Promise<{ setup: SandboxSetup | null; reason: string | null }> {
  const probe = await runFixed(binary, ['abi'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person: null });
  const abi = probe.code === 0 ? Number(probe.stdout.trim()) : 0;
  if (!Number.isInteger(abi) || abi < LANDLOCK_ABI_FOR_TOOLS) return { setup: null, reason: NEWER_LINUX_NEEDED };
  const root = await lstat(scratchRoot).catch(() => null);
  if (!root?.isDirectory() || root.isSymbolicLink()) return { setup: null, reason: `The agent runtime needs ${scratchRoot}, which is missing. Use the Compose files of this version.` };
  try {
    if (root.uid !== 0) await chown(scratchRoot, 0, 0);
    await chmod(scratchRoot, 0o711);
    const test = join(scratchRoot, '.probe');
    await mkdir(test);
    await rmdir(test);
  } catch { return { setup: null, reason: `The agent runtime cannot write ${scratchRoot}. Use the Compose files of this version.` }; }
  return { setup: { binary, shell: join(SANDBOX.bin, 'bash'), bin: SANDBOX.bin, abi, scratchRoot }, reason: null };
}

/** The run's scratch: `<root>/<run id>`, new and empty, mode 0700, the person's. A run id is a UUID, so it is one plain name. */
export async function createScratch(setup: SandboxSetup, runId: string, person: Person): Promise<string> {
  if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error('Not a run id');
  const path = join(setup.scratchRoot, runId);
  // Only the supervisor can write the root, so nothing can stand here first; a leftover of a lost run of the same id is refused.
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  if (person) await chown(path, person.uid, person.gid);
  return path;
}

/**
 * Deletes a run's scratch once none of its person's processes is left: everything in it as the person (a link inside leads nowhere), then
 * the empty directory itself as the supervisor, the only one who may write `/scratch` (a plain `rmdir`, which follows nothing). True when it is gone.
 */
export async function removeScratch(path: string, person: Person): Promise<boolean> {
  if (!(await lstat(path).catch(() => null))) return true;
  for (const entry of await readdir(path).catch(() => [] as string[])) if (!(await removeAsThem(person, join(path, entry)))) return false;
  try { await rmdir(path); return true; } catch { return false; }
}

/** How long the broker may take to say it listens. */
const BROKER_READY_MS = 5_000;

/** A run's broker (#1437): the process of the person that starts every shell of the run, outside the CLI's domain. */
export interface Broker { pid: number; socket: string; stop: () => void }

/**
 * Starts the run's broker (native/sandbox.c `broker`, coordinator decision on #1437's open risk): the CLI's domain may execute nothing but
 * its own program and the sandbox, so the sandbox under the name bash asks the broker for each shell, and the broker, a process of the person
 * outside that domain under the tools' own confinement, starts it. Its socket is in a directory of the run only the person can enter, and
 * the CLI finds it in `FLUX_SANDBOX_BROKER`. Null when it did not say it listens in time: the run then does not start.
 */
export async function startBroker(setup: SandboxSetup, scratch: string, runDir: string, person: Person): Promise<Broker | null> {
  const dir = join(runDir, 'broker');
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  if (person) await chown(dir, person.uid, person.gid);
  const socket = join(dir, 'shell.sock');
  const child = spawn(setup.binary, ['broker', scratch, socket], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'ignore'], ...asPerson(person) });
  const stop = () => { try { if (child.pid) process.kill(child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  const ready = await new Promise<boolean>((resolve) => {
    let said = '';
    const timer = setTimeout(() => resolve(false), BROKER_READY_MS);
    timer.unref();
    child.stdout.on('data', (chunk: Buffer) => { said += chunk.toString('utf8'); if (said.includes('ready\n')) { clearTimeout(timer); resolve(true); } });
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('exit', () => { clearTimeout(timer); resolve(false); });
  });
  child.stdout.destroy();
  child.unref();
  if (!ready || !child.pid) { stop(); return null; }
  return { pid: child.pid, socket, stop };
}

/**
 * What the pinned Codex reads from its home as instructions or settings when a session starts (codex-rs at rust-v0.160.1: `agents_md.rs`,
 * `config/mod.rs`; its rules, skills, prompts, hooks, memories and plugins), and `.env`, whose variables it sets in its own environment at
 * start (`arg0` crate, dotenvy; #1437 review: a `PATH` there would put another `bash` before Flux's sandbox shell in the next run). Its login is
 * `auth.json`, which stays.
 */
export const CODEX_HOME_INSTRUCTIONS = ['AGENTS.md', 'AGENTS.override.md', 'instructions.md', 'config.toml', 'managed_config.toml', 'requirements.toml',
  'rules', 'skills', 'prompts', 'hooks', 'hooks.json', 'memories', 'plugins', '.env'] as const;

/**
 * Codex's home around a run with its own tools (#1437): Codex applies an `apply_patch` it finds in a shell command itself, outside the
 * shell's sandbox, and its outer domain lets it write its own home, so instructions or settings written there could reach the next run.
 * They are removed as the person before and after every such run (the run also stops at the first change outside its scratch).
 */
export function resetCodexHome(codexHome: string, person: Person): Promise<boolean> {
  return asThem(person, `cd -- "$1" && rm -rf -- ${CODEX_HOME_INSTRUCTIONS.map((name) => `'${name}'`).join(' ')}`, codexHome);
}

/** One process of the person, as `/proc` shows it. */
interface Seen { pid: number; rssBytes: number; tasks: number }

async function processesOf(uid: number): Promise<Seen[]> {
  const seen: Seen[] = [];
  for (const entry of await readdir('/proc').catch(() => [] as string[])) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
    if (!new RegExp(`^Uid:\\s+${uid}\\b`, 'm').test(status) || /^State:\s+Z/m.test(status)) continue;
    seen.push({ pid: Number(entry), rssBytes: Number(/^VmRSS:\s+(\d+)/m.exec(status)?.[1] ?? 0) * 1024, tasks: Number(/^Threads:\s+(\d+)/m.exec(status)?.[1] ?? 1) });
  }
  return seen;
}

export type Overrun = 'memory' | 'scratch' | 'tasks';

/**
 * Measures a run every second while it lasts: its tools' memory (every process of the person but the CLI), the person's processes and
 * threads, and the scratch (only walked when the whole scratch file system holds more than one run's limit). Past a limit it kills every
 * process of the person but the CLI and the broker: the tool call fails and the run goes on. The CLI is the process the sandbox became (`cliPid`).
 */
export function watchRun(options: { person: Exclude<Person, null>; cliPid: number; brokerPid?: number; scratch: string; scratchRoot: string; limits?: typeof RUN_TOOL_LIMITS;
  onOverrun?: (what: Overrun) => void }): () => void {
  const limits = options.limits ?? RUN_TOOL_LIMITS;
  let busy = false;
  let stopped = false;
  const check = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const seen = await processesOf(options.person.uid);
      // The broker is spared too: it starts the next command's shell once these are gone.
      const tools = seen.filter((process) => process.pid !== options.cliPid && process.pid !== options.brokerPid);
      let over: Overrun | null = null;
      if (tools.reduce((sum, process) => sum + process.rssBytes, 0) > limits.memoryBytes) over = 'memory';
      // The sandbox stops a fork at the limit (RLIMIT_NPROC), so reaching it is the overrun.
      else if (seen.reduce((sum, process) => sum + process.tasks, 0) >= limits.tasks) over = 'tasks';
      else {
        const fs = await statfs(options.scratchRoot).catch(() => null);
        const used = fs ? (fs.blocks - fs.bfree) * fs.bsize : Infinity;
        if (used > limits.scratchBytes && (await bindingBytes(options.scratch, limits.scratchBytes)).overLimit) over = 'scratch';
      }
      if (over && !stopped) {
        for (const process of tools) killIfTheirs(process.pid, options.person.uid);
        options.onOverrun?.(over);
      }
    } finally { busy = false; }
  };
  const timer = setInterval(() => { void check(); }, limits.everyMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}

/** Kills a process only while it still is the person's: a pid read a moment ago may belong to someone else by now. */
function killIfTheirs(pid: number, uid: number) {
  void readFile(`/proc/${pid}/status`, 'utf8').then((status) => {
    if (new RegExp(`^Uid:\\s+${uid}\\b`, 'm').test(status)) process.kill(pid, 'SIGKILL');
  }).catch(() => undefined);
}
