import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

// Starts one CLI command from a fixed template: an absolute path, an argument array (no shell), a
// clean environment and the binding directory as its working directory. Output is kept only in memory,
// bounded, and is never logged. The whole process group is killed on timeout. On the server each person's
// commands run under that person's own user id (#860), so one person's CLI cannot reach another's files or processes.

/** The user a person's CLIs run as; null where the supervisor does not separate people (the test harness). */
export type Person = { uid: number; gid: number } | null;

/** What `spawn` needs to start a process as that person. */
export const asPerson = (person: Person) => (person ? { uid: person.uid, gid: person.gid } : {});

/** `stderr` only when asked for (`codex login status` prints there); otherwise it is never read. */
export interface FixedRun { code: number | null; timedOut: boolean; stdout: string; stderr: string }

export function runFixed(file: string, args: readonly string[], options: {
  env: Record<string, string>; cwd: string; timeoutMs: number; stdin?: string; maxOutputBytes?: number; readStderr?: boolean; person: Person;
}): Promise<FixedRun> {
  const maxOutput = options.maxOutputBytes ?? 64 * 1024;
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const child = spawn(file, [...args], { env: options.env, cwd: options.cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', options.readStderr ? 'pipe' : 'ignore'], ...asPerson(options.person) });
    const killGroup = (signal: NodeJS.Signals) => {
      try { if (child.pid) process.kill(-child.pid, signal); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      setTimeout(() => killGroup('SIGKILL'), 2_000).unref();
    }, options.timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => {
      if (stdout.length < maxOutput) stdout = Buffer.concat([stdout, chunk.subarray(0, maxOutput - stdout.length)]);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxOutput) stderr = Buffer.concat([stderr, chunk.subarray(0, maxOutput - stderr.length)]);
    });
    child.stdin!.on('error', () => undefined);
    child.stdin!.end(options.stdin ?? '');
    child.on('error', () => { clearTimeout(timer); resolve({ code: null, timedOut, stdout: '', stderr: '' }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      killGroup('SIGKILL');
      resolve({ code, timedOut, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

/** Whether any live process runs under this user id. A zombie is already gone; a process that vanishes while read is too. */
async function hasProcess(uid: number): Promise<boolean> {
  for (const entry of await readdir('/proc')) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
    if (/^State:\s+Z/m.test(status)) continue;
    if (new RegExp(`^Uid:\\s+(?:\\d+\\s+)*${uid}\\b`, 'm').test(status)) return true;
  }
  return false;
}

/**
 * Ends every process of a person and proves none is left. The kill runs as that person (`kill -1` reaches exactly what
 * they may signal, and only their own processes), so a person's files are never touched with the supervisor's rights while
 * something of theirs could still swap them. False when a process survived five tries.
 */
export async function endProcesses(person: Person): Promise<boolean> {
  if (!person) return true;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await runFixed('/bin/sh', ['-c', 'kill -9 -1'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 5_000, person });
    if (!(await hasProcess(person.uid))) return true;
    await new Promise((resume) => setTimeout(resume, 50));
  }
  return false;
}
