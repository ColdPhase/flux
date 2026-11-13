import { FILE_LIMITS } from '@flux/contracts';
import { EMBED_TEXT_LIMIT } from '../search/embeddings.js';

/**
 * What reading the text of a file costs and keeps (C-63, #1382). Every number is a strict bound of the child process that reads a file the
 * sender chose (apps/worker/src/file-text); a file over one keeps what was read in time, and a file that cannot be read is found by its name.
 */
export const FILE_TEXT_LIMITS = {
  /** The file as the upload allows it. */
  fileBytes: FILE_LIMITS.fileBytes,
  /** A PDF's pages read, from the first. */
  pages: 100,
  /** The text kept of one file, in characters; what lies beyond is not searched (the preview shows all of it). */
  chars: 200_000,
  /**
   * The text of one search row. A part is at most what the optional embeddings embed of a row, so all the text is covered by them; a snippet is cut
   * from a text this small (`ts_headline` reads a body's first 20,000 characters).
   */
  partChars: EMBED_TEXT_LIMIT,
  /** A DOCX: entries of its ZIP directory, and what its one text entry (`word/document.xml`) inflates to. Nothing else is ever inflated. */
  zipEntries: 1000,
  zipDirectoryBytes: 1024 * 1024,
  xmlBytes: 24 * 1024 * 1024,
  /** What the child may print, in bytes (the text is at most `chars` characters, and a character is at most three bytes in UTF-8, plus the JSON around it). */
  outputBytes: 4 * 1024 * 1024,
  /**
   * Wall time, CPU time and memory of the child. The worker kills it at 20 s and at 320 MiB resident; the kernel (`sandbox.node`) stops it at 30 s of CPU and
   * at 256 MiB of data segment beyond what Node starts with; its JavaScript heap is 160 MiB.
   */
  timeoutMs: 20_000,
  cpuSeconds: 30,
  memoryBytes: 320 * 1024 * 1024,
  extraBytes: 256 * 1024 * 1024,
  heapMb: 160,
  /** A job is claimed for this long (a worker that died leaves it to be claimed again) and tried this many times. */
  leaseMs: 2 * 60_000,
  attempts: 3,
} as const;
