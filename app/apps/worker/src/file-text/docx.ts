import { inflateRawSync } from 'node:zlib';
import { cleanText } from './clean.js';
import type { Extracted } from './text.js';

/**
 * A DOCX is a ZIP with the text in `word/document.xml` (C-63, #1382). It is read here by the ZIP's central directory, and only that one entry is ever
 * inflated: never a nested archive, never a second entry, never more than `xmlBytes` of output (`maxOutputLength` stops the inflate itself, whatever the
 * entry's declared size says). The directory is bounded in entries and bytes, every offset is checked against the file, and ZIP64, encryption and any
 * method but "stored" and "deflate" are refused. The XML is read by a scanner that decodes only the five predefined entities and numeric references, so
 * no entity expands into more than itself.
 */
export interface DocxLimits { zipEntries: number; zipDirectoryBytes: number; xmlBytes: number; chars: number }

const u16 = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const u32 = (bytes: Uint8Array, at: number) => (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;

/** The bytes of one entry of a ZIP, or why they cannot be had. */
export function readZipEntry(bytes: Uint8Array, wanted: string, limits: Pick<DocxLimits, 'zipEntries' | 'zipDirectoryBytes' | 'xmlBytes'>): Buffer | 'missing' | 'refused' {
  let eocd = -1;
  for (let at = bytes.length - 22, stop = Math.max(0, bytes.length - 22 - 0xffff); at >= stop; at--) {
    if (bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === 5 && bytes[at + 3] === 6) { eocd = at; break; }
  }
  if (eocd < 0) return 'refused';
  const entries = u16(bytes, eocd + 10);
  const size = u32(bytes, eocd + 12);
  const offset = u32(bytes, eocd + 16);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) return 'refused';
  if (entries > limits.zipEntries || size > limits.zipDirectoryBytes || offset + size > bytes.length) return 'refused';
  let at = offset;
  const end = offset + size;
  for (let index = 0; index < entries; index++) {
    if (at + 46 > end || u32(bytes, at) !== 0x02014b50) return 'refused';
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressed = u32(bytes, at + 20);
    const declared = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const local = u32(bytes, at + 42);
    if (at + 46 + nameLength > end) return 'refused';
    const name = Buffer.from(bytes.buffer, bytes.byteOffset + at + 46, nameLength).toString('latin1');
    at += 46 + nameLength + extraLength + commentLength;
    if (name !== wanted) continue;
    if ((flags & 1) !== 0 || (method !== 0 && method !== 8) || declared > limits.xmlBytes) return 'refused';
    if (local + 30 > bytes.length || u32(bytes, local) !== 0x04034b50) return 'refused';
    const start = local + 30 + u16(bytes, local + 26) + u16(bytes, local + 28);
    if (start + compressed > bytes.length) return 'refused';
    const raw = Buffer.from(bytes.buffer, bytes.byteOffset + start, compressed);
    if (method === 0) return compressed <= limits.xmlBytes ? Buffer.from(raw) : 'refused';
    try { return inflateRawSync(raw, { maxOutputLength: limits.xmlBytes }); } catch { return 'refused'; }
  }
  return 'missing';
}

const ENTITY = /&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g;
const decode = (text: string) => (text.includes('&') ? text.replace(ENTITY, (whole, body: string) => {
  if (body[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[body]!;
  const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
}) : text);

/** The words of a WordprocessingML document: text runs (`w:t`, `m:t`), a line break at the end of each paragraph, tabs and breaks, and a tab after each table cell. */
export function wordText(xml: string, maxChars: number): string {
  const out: string[] = [];
  let length = 0;
  let at = 0;
  while (length < maxChars && (at = xml.indexOf('<', at)) >= 0) {
    // The tag's name, read one character at a time: a tag of megabytes is walked once.
    let name = at + 1;
    const closing = xml.charCodeAt(name) === 47;
    if (closing) name += 1;
    let stop = name;
    while (stop < xml.length) {
      const code = xml.charCodeAt(stop);
      if (code === 62 || code === 32 || code === 47 || code === 9 || code === 10 || code === 13) break;
      stop += 1;
    }
    const tag = xml.slice(name, Math.min(stop, name + 40));
    const close = xml.indexOf('>', stop);
    if (close < 0) break;
    const selfClosing = xml.charCodeAt(close - 1) === 47;
    at = close + 1;
    if (closing) { if (tag === 'w:p') { out.push('\n'); length += 1; } else if (tag === 'w:tc') { out.push('\t'); length += 1; } continue; }
    if (tag === 'w:t' || tag === 'm:t') {
      if (selfClosing) continue;
      const next = xml.indexOf('<', at);
      const text = decode(xml.slice(at, next < 0 ? xml.length : next));
      out.push(text);
      length += text.length;
      at = next < 0 ? xml.length : next;
    } else if (tag === 'w:tab') { out.push('\t'); length += 1; }
    else if (tag === 'w:br' || tag === 'w:cr') { out.push('\n'); length += 1; }
    else if (tag === 'w:noBreakHyphen') { out.push('-'); length += 1; }
    else if (tag === 'mc:Fallback' && !selfClosing) {
      // A text box is in the file twice, drawn and as the fallback for older readers: only the first is read.
      const skip = xml.indexOf('</mc:Fallback>', at);
      at = skip < 0 ? xml.length : skip;
    }
  }
  return out.join('');
}

export function extractDocx(bytes: Uint8Array, limits: DocxLimits): Extracted {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) return { ok: false, reason: 'unreadable' };
  const entry = readZipEntry(bytes, 'word/document.xml', limits);
  if (entry === 'missing') return { ok: false, reason: 'unreadable' };
  if (entry === 'refused') return { ok: false, reason: 'too-large' };
  const text = cleanText(wordText(entry.toString('utf8'), limits.chars * 3));
  return text ? { ok: true, segments: [{ text }] } : { ok: false, reason: 'empty' };
}
