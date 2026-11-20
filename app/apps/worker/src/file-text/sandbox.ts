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
export type ExtractResult = { ok: true; segments: TextSegment[]; pages: number | null }
  | { ok: false; reason: ExtractFailure; detail?: string; pictures?: PagePicture[] };
/** A page's picture of a PDF without text, checked as it leaves the child (C-69): its page, its size within the bounds, and a PNG. */
export interface PagePicture { page: number; width: number; height: number; png: Buffer;
  /** With OCR on (C-70): the page grey and larger, for OCR alone; never stored. */
  ocr?: Buffer }
/** What OCR of one picture found (C-70): its text when Tesseract was confident enough, else why not. */
export type OcrResult = { ok: true; text: string } | { ok: false; reason: ExtractFailure; detail?: string };

export interface FileTextSandbox {
  /** Why nothing can be read here, or null when the sandbox is in place. */
  unavailable: string | null;
  extract(bytes: Uint8Array, format: FileTextFormat): Promise<ExtractResult>;
  /** Whether this sandbox reads pictures by OCR (C-70: the operator's switch, and Tesseract and its data installed). */
  ocr: boolean;
  /** OCR of one picture (PNG, JPEG, WebP or GIF within the pixel bounds), in a child of its own with OCR's bounds. */
  recognise(bytes: Uint8Array): Promise<OcrResult>;
}

export interface SandboxOptions {
  /** Test support: the limits and the paths this sandbox would find itself. */
  timeoutMs?: number;
  memoryBytes?: number;
  outputBytes?: number;
  entry?: string;
  addon?: string;
  node?: string;
  /** C-70: read scans and pictures by OCR (the worker's FLUX_FILE_OCR=on). */
  ocr?: boolean;
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
  // A PDF without text answers with its pages' pictures too (C-69), and with OCR on with the pages OCR reads (C-70).
  const outputBytes = options.outputBytes ?? FILE_TEXT_LIMITS.outputBytes + FILE_TEXT_LIMITS.pictureOutputBytes * (options.ocr ? 2 : 1);
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
  // OCR (C-70) reads Tesseract's WebAssembly and the Polish and English data too, by their real paths and their links, as PDF.js.
  const tess = options.ocr && !unavailable ? ocrPackages() : null;
  const reads = unavailable ? [] : [dirname(entry!), pdfjs!, join(workerRoot, 'node_modules', 'pdfjs-dist'), addon, join(workerRoot, 'package.json'),
    ...(tess ? [tess.core, tess.pol, tess.eng, ...OCR_PACKAGES.map((name) => join(workerRoot, 'node_modules', name))] : [])];
  // `reads` binds the child in the kernel too, where it has Landlock (sandbox.c).
  const limits = JSON.stringify({ pages: FILE_TEXT_LIMITS.pages, chars: FILE_TEXT_LIMITS.chars, fileBytes: FILE_TEXT_LIMITS.fileBytes, zipEntries: FILE_TEXT_LIMITS.zipEntries,
    zipDirectoryBytes: FILE_TEXT_LIMITS.zipDirectoryBytes, xmlBytes: FILE_TEXT_LIMITS.xmlBytes, extraBytes: FILE_TEXT_LIMITS.extraBytes, cpuSeconds: FILE_TEXT_LIMITS.cpuSeconds, pdfjs, reads,
    pictures: { ...FILE_TEXT_LIMITS.pictures, ...(tess ? { ocrSide: FILE_TEXT_LIMITS.ocr.side, ocrPageBytes: FILE_TEXT_LIMITS.ocr.pageBytes } : {}) } });
  // One picture's OCR has bounds of its own: more time, CPU and memory than reading a text layer, one picture at a time (C-70).
  const ocr = FILE_TEXT_LIMITS.ocr;
  const ocrLimits = tess ? JSON.stringify({ ...JSON.parse(limits), extraBytes: ocr.extraBytes, cpuSeconds: ocr.cpuSeconds,
    ocr: { ...tess, confidence: ocr.confidence, words: ocr.words, chars: FILE_TEXT_LIMITS.chars } }) : null;

  /** One child: the sandboxed process reads `bytes` as `format` under `bounds` and answers one JSON line, or fails with why. */
  type Answer = { ok: true; answer: Record<string, unknown> } | { ok: false; reason: ExtractFailure; detail?: string };
  const run = (format: string, bytes: Uint8Array, childLimits: string, bounds: { timeoutMs: number; memoryBytes: number; outputBytes: number }) => {
    const args = ['--permission', ...reads.map((path) => `--allow-fs-read=${path}`), '--allow-addons', `--max-old-space-size=${FILE_TEXT_LIMITS.heapMb}`,
      '--disallow-code-generation-from-strings', '--disable-sigusr1', entry!, format, addon, childLimits];
    return new Promise<Answer>((resolve) => {
      const child = spawn(node, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {}, cwd: '/', windowsHide: true });
      if (child.pid) try { setPriority(child.pid, NICENESS); } catch { /* the default priority */ }
      const out: Buffer[] = [];
      let size = 0;
      let diagnostics = '';
      let verdict: ExtractFailure | null = null;
      let settled = false;
      const stop = (reason: ExtractFailure) => { if (!verdict) { verdict = reason; child.kill('SIGKILL'); } };
      const timer = setTimeout(() => stop('timeout'), bounds.timeoutMs);
      const watch = setInterval(() => { if (child.pid && residentBytes(child.pid) > bounds.memoryBytes) stop('memory'); }, 100);
      const done = (result: Answer) => { if (!settled) { settled = true; clearTimeout(timer); clearInterval(watch); resolve(result); } };
      child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > bounds.outputBytes) stop('output'); else out.push(chunk); });
      child.stderr.on('data', (chunk: Buffer) => { if (diagnostics.length < 2048) diagnostics += chunk.toString('utf8', 0, 512); });
      child.stdin.on('error', () => undefined);
      child.on('error', (error) => done({ ok: false, reason: 'crashed', detail: error.message }));
      child.on('close', (code, signal) => {
        if (verdict) return done({ ok: false, reason: verdict });
        if (code === UNCONFINED) return done({ ok: false, reason: 'unconfined', detail: diagnostics.trim().slice(0, 300) });
        if (code !== 0) return done({ ok: false, reason: 'crashed', detail: `${signal ?? `exit ${code}`}: ${diagnostics.trim().slice(0, 300)}` });
        try { return done({ ok: true, answer: JSON.parse(Buffer.concat(out).toString('utf8')) as Record<string, unknown> }); }
        catch { return done({ ok: false, reason: 'crashed', detail: 'the child answered with something that is not JSON' }); }
      });
      child.stdin.end(bytes);
    });
  };

  return {
    unavailable,
    ocr: !!ocrLimits,
    async extract(bytes, format) {
      if (unavailable) throw new Error(unavailable);
      const ran = await run(format, bytes, limits, { timeoutMs, memoryBytes, outputBytes });
      if (!ran.ok) return ran;
      const answer = ran.answer as { ok: boolean; reason?: ExtractFailure; segments?: TextSegment[]; pages?: number; pictures?: unknown };
      if (answer.ok && Array.isArray(answer.segments)) return { ok: true, segments: answer.segments.filter((s) => typeof s.text === 'string'), pages: answer.pages ?? null };
      const pictures = format === 'pdf' && answer.reason === 'empty' ? checkedPictures(answer.pictures) : [];
      return { ok: false, reason: answer.reason ?? 'unreadable', ...(pictures.length ? { pictures } : {}) };
    },
    async recognise(bytes) {
      if (unavailable || !ocrLimits) throw new Error(unavailable ?? 'OCR is off');
      const ran = await run('ocr', bytes, ocrLimits, { timeoutMs: ocr.timeoutMs, memoryBytes: ocr.memoryBytes, outputBytes: ocr.outputBytes });
      if (!ran.ok) return ran;
      const answer = ran.answer as { ok: boolean; reason?: ExtractFailure; segments?: TextSegment[] };
      const text = answer.ok && Array.isArray(answer.segments) ? answer.segments.map((segment) => segment.text).filter((part) => typeof part === 'string').join('\n') : '';
      return text ? { ok: true, text } : { ok: false, reason: answer.reason ?? 'empty' };
    },
  };
}

/** The packages OCR needs (C-70): Tesseract's WebAssembly build and its Polish and English data, pinned in the worker's package.json. */
const OCR_PACKAGES = ['tesseract.js-core', '@tesseract.js-data/pol', '@tesseract.js-data/eng'] as const;
function ocrPackages(): { core: string; pol: string; eng: string } | null {
  try {
    const [core, pol, eng] = OCR_PACKAGES.map((name) => dirname(createRequire(import.meta.url).resolve(`${name}/package.json`)));
    return { core: core!, pol: pol!, eng: eng! };
  } catch { return null; }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * The child's pictures as this process keeps them: only well-formed ones within the bounds (C-69). A child that misbehaved can at worst hand
 * over a PNG of the right size that is not the page; the API serves it only as a picture of that file, to whoever may read the file.
 */
function checkedPictures(value: unknown): PagePicture[] {
  if (!Array.isArray(value)) return [];
  const { pages, side, pictureBytes, totalBytes } = FILE_TEXT_LIMITS.pictures;
  const kept: PagePicture[] = [];
  let total = 0;
  for (const item of value.slice(0, pages)) {
    const { page, width, height, png, ocr } = (item ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(page) || (page as number) < 1 || (page as number) > pages || kept.some((picture) => picture.page === page)) continue;
    if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) < 1 || (height as number) < 1 || (width as number) > side || (height as number) > side) continue;
    if (typeof png !== 'string') continue;
    const bytes = Buffer.from(png, 'base64');
    if (bytes.length < 33 || bytes.length > pictureBytes || total + bytes.length > totalBytes || !bytes.subarray(0, 8).equals(PNG)
      || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) continue;
    total += bytes.length;
    // The page OCR reads (C-70): a PNG within its own bound, or none; Leptonica checks it again.
    const grey = typeof ocr === 'string' ? Buffer.from(ocr, 'base64') : null;
    // Its header must not claim more than OCR's own side either: a misbehaving child cannot hand Tesseract a page larger than the bound.
    const ocrPage = grey && grey.length >= 33 && grey.length <= FILE_TEXT_LIMITS.ocr.pageBytes && grey.subarray(0, 8).equals(PNG)
      && grey.readUInt32BE(16) >= 1 && grey.readUInt32BE(20) >= 1 && grey.readUInt32BE(16) <= FILE_TEXT_LIMITS.ocr.side && grey.readUInt32BE(20) <= FILE_TEXT_LIMITS.ocr.side ? grey : null;
    kept.push({ page: page as number, width: width as number, height: height as number, png: bytes, ...(ocrPage ? { ocr: ocrPage } : {}) });
  }
  return kept;
}

/** Makes this process not dumpable with the real addon (the tests' stand-ins are never loaded here); why it could not, or null. */
function shieldWorker(addon: string | null): string | null {
  if (addon === null) return null;
  try {
    (createRequire(import.meta.url)(addon) as { shield(): boolean }).shield();
    return null;
  } catch (error) { return `the kernel sandbox could not be loaded (${(error as Error).message})`; }
}
