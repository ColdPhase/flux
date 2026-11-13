import { readSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extractDocx } from './docx.js';
import { extractPdf } from './pdf.js';
import { extractText, type Extracted } from './text.js';

/**
 * The process that reads a file (C-63, #1382). It is started by `sandbox.ts` as `node --permission …` with an empty environment and no file but its own
 * code and PDF.js readable, and its first act is to load `sandbox.node` and confine itself (no network, no exec, memory, CPU and file size bounded by
 * the kernel) before it reads a byte of the file: if that fails it exits at once without reading anything. The file arrives on stdin, the answer leaves
 * on stdout as one JSON line, and nothing else is written there.
 *
 * argv: format (`pdf`, `docx` or `text`), the path of sandbox.node, and a JSON object of limits.
 */
interface Limits { pages: number; chars: number; fileBytes: number; zipEntries: number; zipDirectoryBytes: number; xmlBytes: number; extraBytes: number; cpuSeconds: number; pdfjs: string }

// Whatever a library prints must not reach the answer.
console.log = console.warn = console.info = console.debug = (...args: unknown[]) => console.error(...args);

const [format, addon, rawLimits] = process.argv.slice(2);
const limits = JSON.parse(rawLimits ?? '{}') as Limits;

const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
function retrying<T>(step: () => T): T {
  for (;;) {
    try { return step(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error; wait(); }
  }
}

function stdin(max: number): Buffer | null {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(65536);
    const read = retrying(() => readSync(0, chunk, 0, chunk.length, null));
    if (read === 0) break;
    total += read;
    if (total > max) return null;
    chunks.push(chunk.subarray(0, read));
  }
  return Buffer.concat(chunks, total);
}

function answer(result: Extracted): never {
  const line = `${JSON.stringify(result)}\n`;
  let offset = 0;
  const bytes = Buffer.from(line);
  while (offset < bytes.length) offset += retrying(() => writeSync(1, bytes, offset));
  process.exit(0);
}

try {
  const confine = (createRequire(import.meta.url)(addon!) as { confine(extraBytes: number, cpuSeconds: number): boolean }).confine;
  if (!confine(limits.extraBytes, limits.cpuSeconds)) throw new Error('not confined');
} catch (error) {
  console.error(`sandbox: ${(error as Error).message}`);
  process.exit(70);
}

const bytes = stdin(limits.fileBytes);
if (!bytes) answer({ ok: false, reason: 'too-large' });
else if (format === 'pdf') answer(await extractPdf(bytes, limits, limits.pdfjs));
else if (format === 'docx') answer(extractDocx(bytes, limits));
else if (format === 'text') answer(extractText(bytes, limits.chars));
else answer({ ok: false, reason: 'unreadable' });
