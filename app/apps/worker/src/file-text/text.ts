import { cleanText } from './clean.js';

/**
 * Plain, Markdown, log, CSV and TSV files (C-63): UTF-8, or UTF-16 with a byte-order mark, else Windows-1252 (the preview's rule, C-60). A file with
 * NUL bytes that is not UTF-16 is binary and is not read. The text is cut to `maxChars` before it is cleaned, so a file of one huge line costs no more
 * than a short one.
 */
export type Extracted = { ok: true; segments: { text: string; page?: number }[]; pages?: number } | { ok: false; reason: 'not-text' | 'empty' | 'encrypted' | 'unreadable' | 'too-large' };

export function extractText(bytes: Uint8Array, maxChars: number): Extracted {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; start = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; start = 2; }
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  if (encoding === 'utf-8') for (let i = 0, end = Math.min(body.length, 8192); i < end; i++) if (body[i] === 0) return { ok: false, reason: 'not-text' };
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(body); }
  catch {
    if (encoding !== 'utf-8') return { ok: false, reason: 'unreadable' };
    text = new TextDecoder('windows-1252').decode(body);
  }
  const cleaned = cleanText(text.length > maxChars * 3 ? text.slice(0, maxChars * 3) : text);
  return cleaned ? { ok: true, segments: [{ text: cleaned }] } : { ok: false, reason: 'empty' };
}
