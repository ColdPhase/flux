import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILE_TEXT_LIMITS, type FileTextFormat, type TextSegment } from '@flux/core';

/**
 * Where a file is read (C-63, #1382, docs/security/threat-model.md B4): a child process of its own, never this one. `node --permission` leaves it
 * no file but its own code and PDF.js (and no write, no child process, no worker, no inspector), it gets an empty environment, and the first thing it
 * does, before it reads a byte of the file, is load `sandbox.node` (apps/worker/native/sandbox.c), which takes away the network, `execve` and
 * `io_uring` for good and bounds its memory, CPU time, file size and open files in the kernel. The file goes in on stdin and the text comes out on
 * stdout. This process also kills it at the time limit, at the resident-memory limit and at the output limit, and runs it at a lower priority, so that
 * reading files (the backfill after an upgrade above all) yields the CPU to the API. Where `sandbox.node` is not there nothing is read at all: the
 * sandbox is never optional. The real sandbox (no `addon` given) also makes this process not dumpable (`shield()`), so that a child of the same user
 * cannot read this process's environment, memory or descriptors through /proc even if it escaped its own limits.
 */
export type ExtractFailure = 'not-text' | 'empty' | 'encrypted' | 'unreadable' | 'too-large' | 'timeout' | 'memory' | 'output' | 'crashed' | 'unconfined';
export type ExtractResult = { ok: true; segments: TextSegment[]; pages: number | null } | { ok: false; reason: ExtractFailure; detail?: string };

export interface FileTextSandbox {
  /** Why nothing can be read here, or null when the sandbox is in place. */
  unavailable: string | null;
  extract(bytes: Uint8Array, format: FileTextFormat): Promise<ExtractResult>;
}

export interface SandboxOptions {
  /** Test support: the limits and the paths this sandbox would find itself. */
  timeoutMs?: number;
  memoryBytes?: number;
  outputBytes?: number;
  entry?: string;
  addon?: string;
  node?: string;
}

const here = dirname(fileURLToPath(import.meta.url));
/** The worker package: `dist/file-text` (built) or `src/file-text` (from source) is two directories below it. */
const workerRoot = join(here, '..', '..');
/** The exit code of a child that could not confine itself (child.ts): it read nothing. */
const UNCONFINED = 70;
/** The child's niceness: below the API and the rest of the worker. */
const NICENESS = 10;

function findEntry(): string | null {
  for (const candidate of [join(here, 'child.js'), join(workerRoot, 'dist', 'file-text', 'child.js')]) if (existsSync(candidate)) return candidate;
  return null;
}

function residentBytes(pid: number): number {
  try { return Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096; } catch { return 0; }
}

export function createFileTextSandbox(options: SandboxOptions = {}): FileTextSandbox {
  const timeoutMs = options.timeoutMs ?? FILE_TEXT_LIMITS.timeoutMs;
  const memoryBytes = options.memoryBytes ?? FILE_TEXT_LIMITS.memoryBytes;
  const outputBytes = options.outputBytes ?? FILE_TEXT_LIMITS.outputBytes;
  const entry = options.entry ?? findEntry();
  const addon = options.addon ?? join(workerRoot, 'native', 'sandbox.node');
  const node = options.node ?? process.execPath;
  let pdfjs: string | null = null;
  try { pdfjs = dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')); } catch { /* reported below */ }
  const unavailable = process.platform !== 'linux' ? 'the file-text sandbox needs Linux'
    : !entry ? 'the file-text child process is not built (apps/worker/dist/file-text/child.js)'
      : !existsSync(addon) ? `the kernel sandbox is not built (${addon}); it is compiled into the image from apps/worker/native/sandbox.c`
        : !pdfjs ? 'pdfjs-dist is not installed' : shieldWorker(options.addon === undefined ? addon : null);
  // The code it may read is its own directory and the one package; Node also reads the package.json that says how its files load.
  // (the package is read both by its real path and by the link the module resolution walks through: pnpm links it from the worker's node_modules).
  const reads = unavailable ? [] : [dirname(entry!), pdfjs!, join(workerRoot, 'node_modules', 'pdfjs-dist'), addon, join(workerRoot, 'package.json')];
  // `reads` binds the child in the kernel too, where it has Landlock (sandbox.c).
  const limits = JSON.stringify({ pages: FILE_TEXT_LIMITS.pages, chars: FILE_TEXT_LIMITS.chars, fileBytes: FILE_TEXT_LIMITS.fileBytes, zipEntries: FILE_TEXT_LIMITS.zipEntries,
    zipDirectoryBytes: FILE_TEXT_LIMITS.zipDirectoryBytes, xmlBytes: FILE_TEXT_LIMITS.xmlBytes, extraBytes: FILE_TEXT_LIMITS.extraBytes, cpuSeconds: FILE_TEXT_LIMITS.cpuSeconds, pdfjs, reads });

  return {
    unavailable,
    extract(bytes, format) {
      if (unavailable) return Promise.reject(new Error(unavailable));
      const args = ['--permission', ...reads.map((path) => `--allow-fs-read=${path}`), '--allow-addons', `--max-old-space-size=${FILE_TEXT_LIMITS.heapMb}`,
        '--disallow-code-generation-from-strings', '--disable-sigusr1', entry!, format, addon, limits];
      return new Promise<ExtractResult>((resolve) => {
        const child = spawn(node, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {}, cwd: '/', windowsHide: true });
        if (child.pid) try { setPriority(child.pid, NICENESS); } catch { /* the default priority */ }
        const out: Buffer[] = [];
        let size = 0;
        let diagnostics = '';
        let verdict: ExtractFailure | null = null;
        let settled = false;
        const stop = (reason: ExtractFailure) => { if (!verdict) { verdict = reason; child.kill('SIGKILL'); } };
        const timer = setTimeout(() => stop('timeout'), timeoutMs);
        const watch = setInterval(() => { if (child.pid && residentBytes(child.pid) > memoryBytes) stop('memory'); }, 100);
        const done = (result: ExtractResult) => { if (!settled) { settled = true; clearTimeout(timer); clearInterval(watch); resolve(result); } };
        child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > outputBytes) stop('output'); else out.push(chunk); });
        child.stderr.on('data', (chunk: Buffer) => { if (diagnostics.length < 2048) diagnostics += chunk.toString('utf8', 0, 512); });
        child.stdin.on('error', () => undefined);
        child.on('error', (error) => done({ ok: false, reason: 'crashed', detail: error.message }));
        child.on('close', (code, signal) => {
          if (verdict) return done({ ok: false, reason: verdict });
          if (code === UNCONFINED) return done({ ok: false, reason: 'unconfined', detail: diagnostics.trim().slice(0, 300) });
          if (code !== 0) return done({ ok: false, reason: 'crashed', detail: `${signal ?? `exit ${code}`}: ${diagnostics.trim().slice(0, 300)}` });
          try {
            const answer = JSON.parse(Buffer.concat(out).toString('utf8')) as { ok: boolean; reason?: ExtractFailure; segments?: TextSegment[]; pages?: number };
            if (answer.ok && Array.isArray(answer.segments)) return done({ ok: true, segments: answer.segments.filter((s) => typeof s.text === 'string'), pages: answer.pages ?? null });
            return done({ ok: false, reason: answer.reason ?? 'unreadable' });
          } catch { return done({ ok: false, reason: 'crashed', detail: 'the child answered with something that is not JSON' }); }
        });
        child.stdin.end(bytes);
      });
    },
  };
}

/** Makes this process not dumpable with the real addon (the tests' stand-ins are never loaded here); why it could not, or null. */
function shieldWorker(addon: string | null): string | null {
  if (addon === null) return null;
  try {
    (createRequire(import.meta.url)(addon) as { shield(): boolean }).shield();
    return null;
  } catch (error) { return `the kernel sandbox could not be loaded (${(error as Error).message})`; }
}
