import { spawn as spawnNodePty } from 'node-pty';

// The sign-in console's terminal (F-022 T4): one PTY for one fixed login command. node-pty (pinned,
// compiled from source in the image build) forks with forkpty(3) and `execvp`s exactly the absolute
// path and argument array it is given, with exactly the environment it is given plus TERM and PWD. No
// shell is involved. The child leads its own session, so the supervisor ends the whole process group.

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (exit: { exitCode: number; signal?: number }) => void): void;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
}

export type SpawnPty = (file: string, args: readonly string[], options: { cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyProcess;

export const spawnPty: SpawnPty = (file, args, options) => {
  const pty = spawnNodePty(file, [...args], { name: 'xterm-256color', cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env });
  return {
    pid: pty.pid,
    onData: (listener) => { pty.onData(listener); },
    onExit: (listener) => { pty.onExit(listener); },
    write: (data) => pty.write(data),
    resize: (cols, rows) => { try { pty.resize(cols, rows); } catch { /* the PTY already closed */ } },
  };
};

/** Timers the console uses, injectable so a test can reach the 15-minute end without waiting. */
export interface ConsoleClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: ConsoleClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Signals the PTY's whole process group (its leader is the CLI); a group already gone is fine. */
export function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { /* already gone */ }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}
