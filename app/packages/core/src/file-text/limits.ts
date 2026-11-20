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
  /**
   * A PDF without text (a scan, an exported map, slides saved as pictures; C-69, #1557): the picture of each of its first `pages` pages, the
   * largest one drawn on it, at most `side` pixels on its long side (Anthropic's advice for the sharpest picture a model is sent, docs.claude.com
   * "Vision", read 2026-11-20), as a PNG of at most `pictureBytes`; a picture of more than `pixels` is not decoded, and the pictures of one file
   * stop at `totalBytes`. No page is begun after `untilMs` of the child's life (the text read included), so a long scan keeps the pages made
   * in time instead of losing all of them to the 20-second bound (measured: ten pages of 16 million pixels took 6.6 s on one core). The child's output then may hold them as base64 (`outputBytes` with `pictureOutputBytes`).
   */
  pictures: { pages: 10, side: 1568, pixels: 16_000_000, pictureBytes: 3_600_000, totalBytes: 20 * 1024 * 1024, untilMs: 12_000 },
  pictureOutputBytes: 28 * 1024 * 1024,
  /**
   * OCR (C-70, #1575; only with FLUX_FILE_OCR=on): one picture at a time (a PDF page drawn again at most `side` px on its long side, or a
   * picture people sent of at most `pixels`), each in a child of its own with these bounds (measured 2026-11-20 on a Ryzen 9 7900X, two
   * CPUs: a dense A4 page at 300 dpi took 3.7 s and 200 MiB, a 12-megapixel photo 1.5 s and 270 MiB). Its text is kept only when Tesseract's
   * mean confidence is at least `confidence` and it found at least `words` words of three letters or more (a selfie or a landscape keeps
   * nothing). While the switch is on, the worker queues at most `batch` files that OCR has yet to read whenever its queue is empty.
   */
  ocr: { side: 2480, pixels: 24_000_000, timeoutMs: 60_000, cpuSeconds: 60, memoryBytes: 384 * 1024 * 1024, extraBytes: 384 * 1024 * 1024,
    outputBytes: 1024 * 1024, confidence: 60, words: 3, batch: 50 },
  /** A job is claimed for this long (a worker that died leaves it to be claimed again) and tried this many times. */
  leaseMs: 2 * 60_000,
  attempts: 3,
} as const;
