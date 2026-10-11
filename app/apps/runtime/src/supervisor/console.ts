import type { Duplex } from 'node:stream';
import {
  CONSOLE_LIMITS, ConsoleFrameReader, ConsoleLink, encodeControl, encodeOutput, parseSupervisorRequest,
  type ClientStatus, type SupervisorError, type SupervisorFrame, type SupervisorRequest,
} from '@flux/runtime-protocol';
import { openBinding } from './data.js';
import { clientStatus, installedClient, type SupervisorConfig } from './handlers.js';
import { realClock, signalGroup, spawnPty as nodePty, type PtyProcess } from './pty.js';
import { cliEnvironment, loginArgv } from './templates.js';

// The supervisor's side of the sign-in console (F-022 "Sign-in as in a terminal", T4 #279). After the
// upgrade, the first frame must be a login request of the closed set (client, method from the fixed
// list, binding, terminal size). The supervisor runs exactly that method's fixed command in a PTY: not a
// shell, with the clean CLI environment plus TERM. It relays the PTY's output and the owner's input,
// in memory only, and never logs either. The PTY ends when the command exits, when the connection
// closes, or after 15 minutes. Completion is reported only from the CLI's own status command, run
// after the login command ended. The console holds the slot's serial lane for its whole life, so a
// sign-in never overlaps a status, a run or a sign-out.

export interface ConsoleLane { readonly busy: boolean; tryRun(task: () => Promise<void>): Promise<void> | null }

/** Bounded physical lane wait only; API admission requires settled work or full recovery first. */
const LANE_WAIT_MS = 3_000;

type LoginRequest = Extract<SupervisorRequest, { kind: 'login' }>;
type Ending = 'exited' | 'timed_out' | 'disconnected';

/** How long a process group gets after SIGHUP/SIGTERM before SIGKILL. */
export const CONSOLE_KILL_GRACE_MS = 2_000;

export function serveConsole(config: SupervisorConfig, lane: ConsoleLane, socket: Duplex, head: Buffer, openConsoles: Set<() => void> = new Set()): void {
  const clock = config.clock ?? realClock;
  const spawn = config.spawnPty ?? nodePty;
  const lifetimeMs = config.consoleLifetimeMs ?? CONSOLE_LIMITS.lifetimeMs;
  const link = new ConsoleLink(socket, new ConsoleFrameReader('to_supervisor'));
  const send = (frame: SupervisorFrame) => link.send(encodeControl(frame));
  const refuse = (code: SupervisorError) => { send({ t: 'error', code }); link.close(); };
  let opened = false;
  let running: { pty: PtyProcess; stop: (why: Ending) => void } | null = null;
  const openTimer = clock.setTimeout(() => { if (!opened) { opened = true; refuse('invalid_request'); } }, CONSOLE_LIMITS.openWithinMs);

  async function start(request: LoginRequest) {
    send({ t: 'accepted', kind: 'login', bootId: config.bootId });
    if (!config.enabled.includes(request.client)) { refuse('client_off'); return; }
    for (const waitUntil = Date.now() + LANE_WAIT_MS; lane.busy && link.open && Date.now() < waitUntil;) await new Promise((resume) => setTimeout(resume, 100));
    if (!link.open) return;
    const ran = lane.tryRun(async () => {
      // Directory/boot checked inside the admitted lane, never captured before
      // cancellation/release could drain and remove the previous binding.
      if (!link.open) return;
      if (request.bootId !== config.bootId) { refuse('invalid_request'); return; }
      const binding = await openBinding(config.dataDir, request.bindingId);
      if (!binding.ok) { refuse(binding.code); return; }
      if (!(await installedClient(config, request.client))) { refuse('not_installed'); return; }
      await login(request, binding.dir);
    });
    if (!ran) refuse('busy');
    else await ran;
  }

  function login(request: LoginRequest, dir: string): Promise<void> {
    return new Promise((done) => {
      if (!link.open) { done(); return; }
      let ending: Ending | null = null;
      let output = 0;
      let killTimer: unknown = null;
      const pty = spawn(config.cliPaths[request.client], loginArgv(request.client, request.method), {
        cols: request.cols, rows: request.rows, cwd: dir,
        env: { ...cliEnvironment(request.client, dir, config.egressHost), TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      const stop = (why: Ending) => {
        if (ending) return;
        ending = why;
        clock.clearTimeout(lifetime);
        signalGroup(pty.pid, 'SIGHUP');
        signalGroup(pty.pid, 'SIGTERM');
        killTimer = clock.setTimeout(() => signalGroup(pty.pid, 'SIGKILL'), CONSOLE_KILL_GRACE_MS);
      };
      const lifetime = clock.setTimeout(() => stop('timed_out'), lifetimeMs);
      running = { pty, stop };
      pty.onData((data) => {
        if (ending === 'disconnected') return;
        const bytes = Buffer.from(data, 'utf8');
        output += bytes.length;
        // More output than any sign-in prints: end it like a lost connection.
        if (output > CONSOLE_LIMITS.outputTotalBytes) { stop('disconnected'); link.destroy(); return; }
        link.send(encodeOutput(bytes));
      });
      pty.onExit(({ exitCode }) => {
        clock.clearTimeout(lifetime);
        if (killTimer !== null) clock.clearTimeout(killTimer);
        // Nothing the command started may outlive it.
        signalGroup(pty.pid, 'SIGKILL');
        running = null;
        const how = ending ?? 'exited';
        if (how === 'disconnected' || !link.open) { done(); return; }
        send({ t: 'console', state: how });
        void finish(request, dir, how, how === 'exited' ? exitCode : null).finally(done);
      });
      send({ t: 'console', state: 'started' });
    });
  }

  async function finish(request: LoginRequest, dir: string, ended: 'exited' | 'timed_out', exitCode: number | null) {
    let status: ClientStatus;
    try { status = await clientStatus(config, request.client, dir); } catch { refuse('internal'); return; }
    send({ t: 'result', result: { kind: 'login', client: request.client, ended, exitCode: exitCode === null ? null : Math.max(-1, Math.min(255, exitCode)), status } });
    link.close();
  }

  link.onFrame((frame) => {
    if (!opened) {
      opened = true;
      clock.clearTimeout(openTimer);
      if (frame.type !== 'open') { refuse('invalid_request'); return; }
      const parsed = parseSupervisorRequest('login', frame.body);
      if (!parsed.ok) { refuse(parsed.code); return; }
      void start(parsed.request as LoginRequest).catch(() => refuse('internal'));
      return;
    }
    // A second login request on the same console is a protocol violation: the console ends.
    if (frame.type === 'open') { link.destroy(); return; }
    if (!running) return;
    if (frame.type === 'input') running.pty.write(frame.data);
    else running.pty.resize(frame.cols, frame.rows);
  });
  const end = () => link.destroy();
  openConsoles.add(end);
  link.onEnd(() => {
    openConsoles.delete(end);
    clock.clearTimeout(openTimer);
    running?.stop('disconnected');
  });
  link.start(head);
}
