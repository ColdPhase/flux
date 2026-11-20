import { FILE_LIMITS, type FileDetail } from '@flux/contracts';

/**
 * What the bytes of a file say about it (#469, F-026 §6): pages of a PDF, data rows of a CSV or TSV, the
 * playing time of audio. Read once, at upload, as the bytes arrive (`detailReader`), so no later read needs the stored object: the pages and
 * the rows are counted over the whole stream, the playing time is read from the first `FILE_LIMITS.wholeBytes` (all of a file up to that size,
 * the head of a larger one, #1549). Every reader is bounded and answers nothing rather than a guess: a file whose bytes do not say (an
 * unreadable header, a PDF with its page tree compressed, an Ogg file larger than its head) shows no detail.
 */

/** The file extensions this module reads; the upload buffers its bytes only for these. */
export const DETAIL_EXTENSIONS = new Set(['pdf', 'csv', 'tsv', 'wav', 'mp3', 'm4a', 'mp4', 'mov', 'm4v', 'ogg', 'oga', 'opus', 'webm', 'weba']);

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
};
export const readsDetail = (name: string) => DETAIL_EXTENSIONS.has(extensionOf(name));

const positive = (value: number) => Number.isFinite(value) && value >= 0 && value < 2 ** 31 ? Math.round(value) : undefined;
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const ascii = (bytes: Uint8Array, at: number, length: number) => {
  let out = '';
  for (let i = at; i < Math.min(bytes.length, at + length); i++) out += String.fromCharCode(bytes[i]!);
  return out;
};

/** A piece of a PDF longer than this keeps only its first `PIECE_HEAD` characters: an object's dictionary comes before its stream (#1549). */
const PIECE_LONGEST = 1024 * 1024;
const PIECE_HEAD = 64 * 1024;

/**
 * Pages, counted as the bytes arrive: the root of the page tree's `/Count`, else the leaf pages found; nothing when the tree is in an object
 * stream. The text is cut at `endobj` and each piece is read with patterns that cannot backtrack across it: an upload is untrusted, so no
 * pattern may be quadratic in its length (a run of digits must not stall the server), and a piece over `PIECE_LONGEST` (a picture's stream)
 * keeps only its head, so the counter holds at most about a megabyte whatever the file's size.
 */
export function pdfPageCounter() {
  let started = '';
  let pdf: boolean | null = null;
  let carry = '';
  let skipping = false;
  let root: number | undefined;
  let widest = 0;
  let leaves = 0;
  const piece = (text: string) => {
    const header = text.indexOf(' obj');
    if (header < 0) return;
    const body = text.slice(header + 4);
    if (/\/Type\s*\/Pages\b/.test(body)) {
      const count = Number(/\/Count\s+(\d+)/.exec(body)?.[1]);
      if (Number.isFinite(count)) { widest = Math.max(widest, count); if (!/\/Parent\b/.test(body)) root = count; }
    } else if (/\/Type\s*\/Page(?![A-Za-z])/.test(body)) leaves++;
  };
  const take = (text: string) => {
    while (text) {
      if (skipping) {
        // Within a long piece: only its end (`endobj`, possibly split across two chunks) matters.
        const joined = carry + text;
        const end = joined.indexOf('endobj');
        if (end < 0) { carry = joined.slice(-5); return; }
        skipping = false; carry = ''; text = joined.slice(end + 6);
        continue;
      }
      const parts = (carry + text).split('endobj');
      carry = parts.pop()!;
      for (const part of parts) piece(part);
      if (carry.length > PIECE_LONGEST) { piece(carry.slice(0, PIECE_HEAD)); carry = ''; skipping = true; }
      return;
    }
  };
  return {
    push(chunk: Uint8Array) {
      if (pdf === false) return;
      const text = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('latin1');
      if (pdf === null) {
        started += text.slice(0, 5 - started.length);
        if (started.length < 5) { if (!'%PDF-'.startsWith(started)) pdf = false; carry += text; return; }
        pdf = started === '%PDF-';
        if (!pdf) return;
        const held = carry; carry = '';
        take(held + text);
        return;
      }
      take(text);
    },
    end(): number | undefined {
      if (!pdf) return undefined;
      if (!skipping && carry) piece(carry);
      carry = '';
      const pages = root ?? (widest || leaves);
      return pages > 0 ? positive(pages) : undefined;
    },
  };
}

/** The pages of a whole PDF (`pdfPageCounter` over one chunk). */
export function pdfPages(bytes: Uint8Array): number | undefined {
  const counter = pdfPageCounter();
  counter.push(bytes);
  return counter.end();
}

/** Data rows of a delimited text file, counted as the bytes arrive: the records outside quotes that hold something, less the header line. */
export function tableRowCounter() {
  let records = 0;
  let quoted = false;
  let filled = false;
  let afterReturn = false;
  return {
    push(bytes: Uint8Array) {
      let i = 0;
      // A CRLF split across two chunks is one line break.
      if (afterReturn && bytes.length && bytes[0] === 0x0a) i = 1;
      afterReturn = false;
      for (; i < bytes.length; i++) {
        const byte = bytes[i]!;
        if (byte === 0x22) { quoted = !quoted; filled = true; continue; }
        if (!quoted && (byte === 0x0a || byte === 0x0d)) {
          if (byte === 0x0d) { if (i + 1 === bytes.length) afterReturn = true; else if (bytes[i + 1] === 0x0a) i++; }
          if (filled) records++;
          filled = false;
          continue;
        }
        if (byte !== 0x20 && byte !== 0x09 && byte !== 0xef && byte !== 0xbb && byte !== 0xbf) filled = true;
      }
    },
    end(): number | undefined {
      const total = records + (filled ? 1 : 0);
      return total > 0 ? positive(total - 1) : undefined;
    },
  };
}

/** The data rows of a whole delimited text file (`tableRowCounter` over one chunk). */
export function tableRows(bytes: Uint8Array): number | undefined {
  const counter = tableRowCounter();
  counter.push(bytes);
  return counter.end();
}

function wavDuration(bytes: Uint8Array, total: number): number | undefined {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WAVE') return undefined;
  const data = view(bytes);
  let byteRate = 0;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = ascii(bytes, at, 4);
    let size = data.getUint32(at + 4, true);
    if (id === 'fmt ' && at + 20 <= bytes.length) byteRate = data.getUint32(at + 16, true);
    if (id === 'data') {
      // A streamed recording may declare no length: the rest of the file is the audio.
      if (size === 0xffffffff || at + 8 + size > total) size = total - at - 8;
      return byteRate > 0 ? positive(size / byteRate * 1000) : undefined;
    }
    at += 8 + size + (size % 2);
  }
  return undefined;
}

function mp4Duration(bytes: Uint8Array): number | undefined {
  const data = view(bytes);
  const find = (type: string, from: number, to: number): [number, number] | null => {
    for (let at = from; at + 8 <= to;) {
      let size = data.getUint32(at, false);
      const header = size === 1 ? 16 : 8;
      if (size === 1 && at + 16 <= to) size = Number(data.getBigUint64(at + 8, false));
      if (size === 0) size = to - at;
      if (size < header || at + size > to) return null;
      if (ascii(bytes, at + 4, 4) === type) return [at + header, at + size];
      at += size;
    }
    return null;
  };
  const moov = find('moov', 0, bytes.length);
  const mvhd = moov && find('mvhd', moov[0], moov[1]);
  if (!mvhd) return undefined;
  const [start, end] = mvhd;
  const version = bytes[start];
  if (version === 0 && start + 20 <= end) {
    const scale = data.getUint32(start + 12, false);
    return scale > 0 ? positive(data.getUint32(start + 16, false) / scale * 1000) : undefined;
  }
  if (version === 1 && start + 32 <= end) {
    const scale = data.getUint32(start + 20, false);
    return scale > 0 ? positive(Number(data.getBigUint64(start + 24, false)) / scale * 1000) : undefined;
  }
  return undefined;
}

/** The last page's granule position: read only from a whole file (the head of a larger one does not hold its last page). */
function oggDuration(bytes: Uint8Array, total: number): number | undefined {
  if (ascii(bytes, 0, 4) !== 'OggS' || total > bytes.length) return undefined;
  const data = view(bytes);
  let last = -1;
  for (let at = bytes.length - 14; at >= 0; at--) {
    if (bytes[at] === 0x4f && ascii(bytes, at, 4) === 'OggS') { last = at; break; }
  }
  if (last < 0) return undefined;
  const granule = Number(data.getBigUint64(last + 6, true));
  if (!Number.isFinite(granule) || granule <= 0) return undefined;
  const opus = ascii(bytes, 0, 128).indexOf('OpusHead');
  if (opus >= 0) return positive((granule - data.getUint16(opus + 10, true)) / 48000 * 1000);
  const vorbis = ascii(bytes, 0, 128).indexOf('\u0001vorbis');
  if (vorbis >= 0 && vorbis + 16 <= bytes.length) {
    const rate = data.getUint32(vorbis + 12, true);
    return rate > 0 ? positive(granule / rate * 1000) : undefined;
  }
  return undefined;
}

/** The Segment/Info `Duration` of a WebM (a recording the browser made often has none, and then there is no detail). */
function webmDuration(bytes: Uint8Array): number | undefined {
  const data = view(bytes);
  const vint = (at: number, keepMarker: boolean): [number, number] | null => {
    const first = bytes[at];
    if (first === undefined || first === 0) return null;
    const length = Math.clz32(first) - 23;
    if (length > 8 || at + length > bytes.length) return null;
    let value = keepMarker ? first : first & (0xff >> length);
    for (let i = 1; i < length; i++) value = value * 256 + bytes[at + i]!;
    return [value, length];
  };
  let scale = 1_000_000;
  let duration: number | undefined;
  const walk = (from: number, to: number, depth: number) => {
    for (let at = from; at < to;) {
      const id = vint(at, true);
      if (!id) return;
      const size = vint(at + id[1], false);
      if (!size) return;
      const body = at + id[1] + size[1];
      const end = Math.min(to, body + size[0]);
      if (depth < 2 && (id[0] === 0x18538067 || id[0] === 0x1549a966)) walk(body, end, depth + 1);
      else if (id[0] === 0x2ad7b1) { let value = 0; for (let i = body; i < end; i++) value = value * 256 + bytes[i]!; if (value > 0) scale = value; }
      else if (id[0] === 0x4489) { if (end - body === 8) duration = data.getFloat64(body, false); else if (end - body === 4) duration = data.getFloat32(body, false); }
      at = end;
    }
  };
  walk(0, bytes.length, 0);
  return duration === undefined ? undefined : positive(duration * scale / 1_000_000);
}

const BITRATE_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATE_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATE: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** MPEG audio layer III: the frame count of a Xing/Info header, else the size at the first frame's constant bitrate. */
function mp3Duration(bytes: Uint8Array, total: number): number | undefined {
  let at = 0;
  if (ascii(bytes, 0, 3) === 'ID3' && bytes.length > 10) at = 10 + (((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f));
  while (at + 4 < bytes.length && !(bytes[at] === 0xff && (bytes[at + 1]! & 0xe0) === 0xe0 && (bytes[at + 1]! & 0x06) === 0x02)) at++;
  if (at + 4 >= bytes.length) return undefined;
  const version = (bytes[at + 1]! >> 3) & 3;
  const bitrateIndex = bytes[at + 2]! >> 4;
  const rateIndex = (bytes[at + 2]! >> 2) & 3;
  const rate = SAMPLE_RATE[version]?.[rateIndex];
  const bitrate = (version === 3 ? BITRATE_V1_L3 : BITRATE_V2_L3)[bitrateIndex];
  if (!rate || !bitrate || version === 1 || bitrateIndex === 15) return undefined;
  const samples = version === 3 ? 1152 : 576;
  const mono = (bytes[at + 3]! >> 6) === 3;
  const side = version === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const tag = at + 4 + side;
  if (['Xing', 'Info'].includes(ascii(bytes, tag, 4)) && (bytes[tag + 7]! & 1) && tag + 12 <= bytes.length) {
    const frames = view(bytes).getUint32(tag + 8, false);
    return frames > 0 ? positive(frames * samples / rate * 1000) : undefined;
  }
  return positive((total - at) * 8 / (bitrate * 1000) * 1000);
}

/**
 * The detail the bytes of `name` give; an empty object when the kind is not read or the bytes do not say. `bytes` is the whole file, or the
 * first bytes of a file of `total` bytes (a video's head, a large file's first `FILE_LIMITS.wholeBytes`).
 */
export function fileDetailOf(name: string, bytes: Uint8Array, total = bytes.length): FileDetail {
  try {
    const extension = extensionOf(name);
    const found = (key: keyof FileDetail, value: number | undefined): FileDetail => value === undefined ? {} : { [key]: value };
    if (extension === 'pdf') return total > bytes.length ? {} : found('pages', pdfPages(bytes));
    if (extension === 'csv' || extension === 'tsv') return total > bytes.length ? {} : found('rows', tableRows(bytes));
    if (extension === 'wav') return found('durationMs', wavDuration(bytes, total));
    if (extension === 'mp3') return found('durationMs', mp3Duration(bytes, total));
    if (['m4a', 'mp4', 'mov', 'm4v'].includes(extension)) return found('durationMs', mp4Duration(bytes));
    if (['ogg', 'oga', 'opus'].includes(extension)) return found('durationMs', oggDuration(bytes, total));
    if (extension === 'webm' || extension === 'weba') return found('durationMs', webmDuration(bytes));
  } catch { /* unreadable bytes show no detail */ }
  return {};
}

/**
 * Reads the detail of an upload as its bytes pass (#469, #1549): the pages of a PDF and the rows of a CSV or TSV are counted over the whole
 * stream, and the first `FILE_LIMITS.wholeBytes` are kept for the playing time of audio. It holds at most that head and the counters' own
 * bounded state, whatever the file's size.
 */
export function detailReader(name: string) {
  const extension = extensionOf(name);
  const pages = extension === 'pdf' ? pdfPageCounter() : null;
  const rows = extension === 'csv' || extension === 'tsv' ? tableRowCounter() : null;
  const head: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  let broken = false;
  return {
    push(chunk: Uint8Array) {
      total += chunk.byteLength;
      if (broken) return;
      try {
        if (pages) pages.push(chunk);
        else if (rows) rows.push(chunk);
        else if (kept < FILE_LIMITS.wholeBytes) { const part = chunk.subarray(0, FILE_LIMITS.wholeBytes - kept); head.push(part); kept += part.byteLength; }
      } catch { broken = true; }
    },
    detail(): FileDetail {
      if (broken) return {};
      try {
        if (pages) { const value = pages.end(); return value === undefined ? {} : { pages: value }; }
        if (rows) { const value = rows.end(); return value === undefined ? {} : { rows: value }; }
        return fileDetailOf(name, Buffer.concat(head), total);
      } catch { return {}; } finally { head.length = 0; }
    },
  };
}
