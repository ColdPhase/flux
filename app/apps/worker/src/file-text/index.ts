import { FILE_TEXT_LIMITS, fileTextFormat, splitIntoParts } from '@flux/core';
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
  const sandbox = options.sandbox ?? createFileTextSandbox();
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
  let retry: ReturnType<typeof setTimeout> | undefined;

  const readOne = async (job: NonNullable<Awaited<ReturnType<typeof rows.claim>>>) => {
    const started = Date.now();
    const format = fileTextFormat(job.name);
    const bytes = format ? await read(job.fileId) : null;
    if (format && (!bytes || bytes.length !== job.size)) throw new Error('The stored file is missing or is not the size it was stored with');
    const result = format && bytes ? await sandbox.extract(bytes, format) : null;
    if (result && !result.ok && result.reason === 'crashed') log('A file could not be read', { file: job.fileId, reason: result.reason, detail: result.detail });
    const split = result?.ok ? splitIntoParts(result.segments, { partChars: FILE_TEXT_LIMITS.partChars, maxChars: FILE_TEXT_LIMITS.chars }) : null;
    // A file that cannot be read (or one that is not text by its name) is finished without text: its name row stays.
    await rows.store(job.fileId, split?.parts ?? []);
    console.log(JSON.stringify({ job: 'file.text', file: job.fileId, ms: Date.now() - started, outcome: result ? (result.ok ? 'read' : result.reason) : 'skipped',
      parts: split?.parts.length ?? 0, chars: split?.chars ?? 0, ...(split?.truncated ? { truncated: true } : {}) }));
  };

  const tick = async () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try {
      do {
        again = false;
        const gaveUp = await rows.giveUp(FILE_TEXT_LIMITS.leaseMs, FILE_TEXT_LIMITS.attempts);
        if (gaveUp.length) log('Files were given up after repeated failures', { files: gaveUp });
        for (;;) {
          if (stopped) break;
          const job = await rows.claim(FILE_TEXT_LIMITS.leaseMs, FILE_TEXT_LIMITS.attempts);
          if (!job) break;
          try { await readOne(job); }
          catch (error) { log('A file could not be read; its job is tried again later', { file: job.fileId, attempt: job.attempts, error: (error as Error).message }); }
          if (pause) await sleep(pause);
        }
      } while (again && !stopped);
      // A job that failed waits for its lease: look again when it is over.
      const wait = stopped ? null : await rows.nextRetryIn(FILE_TEXT_LIMITS.leaseMs, FILE_TEXT_LIMITS.attempts);
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
