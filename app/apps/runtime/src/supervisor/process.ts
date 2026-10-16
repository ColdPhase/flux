import { spawn } from 'node:child_process';

// Starts one CLI command from a fixed template: an absolute path, an argument array (no shell), a
// clean environment and the binding directory as its working directory. Output is kept only in memory,
// bounded, and is never logged. The whole process group is killed on timeout.

/** `stderr` only when asked for (`codex login status` prints there); otherwise it is never read. */
export interface FixedRun { code: number | null; timedOut: boolean; stdout: string; stderr: string }

export function runFixed(file: string, args: readonly string[], options: {
  env: Record<string, string>; cwd: string; timeoutMs: number; stdin?: string; maxOutputBytes?: number; readStderr?: boolean;
}): Promise<FixedRun> {
  const maxOutput = options.maxOutputBytes ?? 64 * 1024;
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;
    const child = spawn(file, [...args], { env: options.env, cwd: options.cwd, shell: false, detached: true, stdio: ['pipe', 'pipe', options.readStderr ? 'pipe' : 'ignore'] });
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
