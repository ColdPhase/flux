import { cleanPicture, FILE_TEXT_LIMITS, fileTextFormat, isOcrPicture, splitIntoParts, type TextSegment } from '@flux/core';
import { FILE_TEXT_CHANNEL, fileTextRows, listen, type Database } from '@flux/db';
import { readFromDisk, type ReadStoredFile } from './objects.js';
import { createFileTextSandbox, type FileTextSandbox } from './sandbox.js';

// What is inside the files people send is read here (C-63, #1382). A file attached to a message of a plain space is queued by the trigger of migration
// 0072 (and the files already there by that migration); this worker wakes on its NOTIFY, claims one file at a time with a lease, reads its bytes from the
// files volume, has them read in the sandbox (sandbox.ts), cuts the text into parts and writes them as search rows in one transaction that holds the
// file's row. Nothing polls: with the queue empty no timer runs, and one runs only after a failure, until the lease of the job that failed is over.
// A file the sandbox cannot read (a scan, a password, a malformed or hostile file) is finished without text, never tried again; only the worker's own
// errors (the database, the disk) leave the job to be claimed again, three times at most.

type Log = (message: string, details?: Record<string, unknown>) => void;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface FileTextOptions {
  db: Database;
  connectionString: string;
  env?: NodeJS.ProcessEnv;
  /** Test support: the sandbox, the file reader and the pause between two files in place of the real ones. */
  sandbox?: FileTextSandbox;
  readObject?: ReadStoredFile;
  pauseMs?: number;
  log?: Log;
}

export async function startFileText(options: FileTextOptions) {
  const { db, connectionString, env = process.env, log = (message, details) => console.warn(message, details ?? {}) } = options;
  // C-70 (#1575): the operator's OCR switch, off by default; anything but on or off stops the worker, as the other switches do.
  const ocrSetting = (env.FLUX_FILE_OCR ?? '').trim() || 'off';
  if (ocrSetting !== 'on' && ocrSetting !== 'off') throw new Error('FLUX_FILE_OCR must be on or off');
  const sandbox = options.sandbox ?? createFileTextSandbox({ ocr: ocrSetting === 'on' });
  if (ocrSetting === 'on' && !sandbox.ocr && !sandbox.unavailable) log('Scans and pictures are not read by OCR: Tesseract or its language data is not installed', {});
  if (sandbox.unavailable) {
    // Never read without the sandbox. The queue keeps its jobs; an image that has it reads them at its first start.
    log('Files are not searched: no file is read without its sandbox', { reason: sandbox.unavailable });
    return { async tick() { /* off */ }, async stop() { /* off */ } };
  }
  const rows = fileTextRows(db);
  const read = options.readObject ?? readFromDisk(env.FLUX_FILES_DIR ?? '/data/files');
  const pause = options.pauseMs ?? 100;
  let running = false;
  let again = false;
  let stopped = false;
  /** Set when the sandbox turns out not to work on this host: the queue is left as it is, for the next start. */
  let off = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  /** OCR of one picture (C-70), one child at a time: its text, or null when there is none confident enough or it could not be read. */
  const recognise = async (fileId: string, bytes: Uint8Array) => {
    const found = await sandbox.recognise(bytes);
    if (!found.ok && found.reason === 'unconfined') {
      // As for any read: nothing is read without the sandbox, and the job stays (never marked as read by OCR with nothing found).
      off = true;
      log('Files are not searched: no file is read without its sandbox', { reason: found.detail ?? 'the child could not confine itself' });
      throw new Error('The file-text sandbox could not confine its child');
    }
    if (!found.ok && found.reason !== 'empty') log('A picture could not be read by OCR', { file: fileId, reason: found.reason, detail: found.detail });
    return found.ok ? found.text : null;
  };

  const readOne = async (job: NonNullable<Awaited<ReturnType<typeof rows.claim>>>) => {
    const started = Date.now();
    if (sandbox.ocr && isOcrPicture(job.name)) return readPicture(job, started);
    // A file over the text bound (#1549) is finished as one that is not text by its name: found by its name.
    const format = job.size <= FILE_TEXT_LIMITS.fileBytes ? fileTextFormat(job.name) : null;
    const bytes = format ? await read(job.fileId) : null;
    if (format && (!bytes || bytes.length !== job.size)) throw new Error('The stored file is missing or is not the size it was stored with');
    const result = format && bytes ? await sandbox.extract(bytes, format) : null;
    if (result && !result.ok && result.reason === 'unconfined') {
      // The child could not confine itself (the kernel refused the filter): nothing is read here any more, and the job stays for a worker that can.
      off = true;
      log('Files are not searched: no file is read without its sandbox', { reason: result.detail ?? 'the child could not confine itself' });
      throw new Error('The file-text sandbox could not confine its child');
    }
    if (result && !result.ok && result.reason === 'crashed') log('A file could not be read', { file: job.fileId, reason: result.reason, detail: result.detail });
    // A file that cannot be read (or one that is not text by its name) is finished without text: its name row stays. A PDF without text
    // keeps its pages' pictures instead, for the agents whose model sees pictures (C-69, #1557), and with OCR on its pages are read by OCR,
    // one at a time, and their text is the file's text (C-70).
    const pictures = result && !result.ok ? result.pictures ?? [] : [];
    const scan = format === 'pdf' && !!result && !result.ok && result.reason === 'empty';
    const ocrSegments: TextSegment[] = [];
    if (scan && sandbox.ocr) for (const picture of pictures) {
      const text = picture.ocr ? await recognise(job.fileId, picture.ocr) : null;
      if (text) ocrSegments.push({ text, page: picture.page });
    }
    const segments = result?.ok ? result.segments : ocrSegments;
    const split = segments.length ? splitIntoParts(segments, { partChars: FILE_TEXT_LIMITS.partChars, maxChars: FILE_TEXT_LIMITS.chars }) : null;
    await rows.store(job.fileId, split?.parts ?? [], { pictures, noText: scan && !ocrSegments.length, ...(scan && sandbox.ocr ? { ocr: ocrSegments.length ? 'text' as const : 'none' as const } : {}) });
    console.log(JSON.stringify({ job: 'file.text', file: job.fileId, ms: Date.now() - started, outcome: ocrSegments.length ? 'ocr' : result ? (result.ok ? 'read' : result.reason) : 'skipped',
      parts: split?.parts.length ?? 0, chars: split?.chars ?? 0, ...(split?.truncated ? { truncated: true } : {}), ...(pictures.length ? { pictures: pictures.length } : {}) }));
  };

  /**
   * A picture people sent (C-70), with OCR on: within C-59's bounds (its bytes are a PNG, JPEG, WebP or GIF of at most 8,000 px on a side)
   * and OCR's own pixel bound, read by OCR; its text, when confident, is its text. Anything else is finished with nothing.
   */
  const readPicture = async (job: NonNullable<Awaited<ReturnType<typeof rows.claim>>>, started: number) => {
    const bytes = await read(job.fileId);
    if (!bytes || bytes.length !== job.size) throw new Error('The stored file is missing or is not the size it was stored with');
    const picture = cleanPicture(bytes);
    const fits = picture.ok && picture.width * picture.height <= FILE_TEXT_LIMITS.ocr.pixels;
    const text = fits ? await recognise(job.fileId, picture.bytes) : null;
    const split = text ? splitIntoParts([{ text }], { partChars: FILE_TEXT_LIMITS.partChars, maxChars: FILE_TEXT_LIMITS.chars }) : null;
    await rows.store(job.fileId, split?.parts ?? [], { pictures: [], noText: false, ocr: split?.parts.length ? 'text' : 'none' });
    console.log(JSON.stringify({ job: 'file.text', file: job.fileId, ms: Date.now() - started, outcome: split?.parts.length ? 'ocr' : fits ? 'empty' : 'skipped',
      parts: split?.parts.length ?? 0, chars: split?.chars ?? 0 }));
  };

  const tick = async () => {
    if (stopped || off) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const gaveUp = await rows.giveUp(FILE_TEXT_LIMITS.leaseMs, FILE_TEXT_LIMITS.attempts);
        if (gaveUp.length) log('Files were given up after repeated failures', { files: gaveUp });
        for (;;) {
          if (stopped || off) break;
          let job = await rows.claim(FILE_TEXT_LIMITS.leaseMs, FILE_TEXT_LIMITS.attempts);
          // With OCR on, an empty queue takes the next bounded batch of what OCR has yet to read (C-70): new pictures, and v0.2.1's.
          if (!job && sandbox.ocr && await rows.queueOcr(FILE_TEXT_LIMITS.ocr.batch)) job = await rows.claim(FILE_TEXT_LIMITS.leaseMs, FILE_TEXT_LIMITS.attempts);
          if (!job) break;
          try { await readOne(job); }
          catch (error) { if (off) break; log('A file could not be read; its job is tried again later', { file: job.fileId, attempt: job.attempts, error: (error as Error).message }); }
          if (pause) await sleep(pause);
        }
      } while (again && !stopped && !off);
      // A job that failed waits for its lease: look again when it is over.
      const wait = stopped || off ? null : await rows.nextRetryIn(FILE_TEXT_LIMITS.leaseMs, FILE_TEXT_LIMITS.attempts);
      if (wait !== null) { clearTimeout(retry); retry = setTimeout(() => void tick(), wait + 1000).unref(); }
    } catch (error) {
      log('The file reader could not reach the database; trying again later', { error: (error as Error).message });
      clearTimeout(retry);
      retry = setTimeout(() => void tick(), 30_000).unref();
    } finally {
      running = false;
    }
  };

  const listener = listen(connectionString, FILE_TEXT_CHANNEL, () => void tick(), () => void tick(), (error) => log('File listener interrupted', { error: error.message }));
  void tick();
  return {
    tick,
    async stop() {
      stopped = true;
      clearTimeout(retry);
      await listener.close();
    },
  };
}
