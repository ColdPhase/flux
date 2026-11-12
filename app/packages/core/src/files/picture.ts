import { FILE_LIMITS, type ThoughtImageType } from '@flux/contracts';

/**
 * A picture from outside Flux, kept only as a picture (#1217, F-036 AG-8, C-59). The bytes are untrusted (a site an agent named), so
 * nothing is decoded or re-encoded: the file is walked chunk by chunk in one bounded pass and rebuilt from the chunks that draw it.
 *
 * - The type comes from the bytes' own signature, never a name or a header: PNG, JPEG, GIF or WebP. SVG (which can carry script) and
 *   anything else is refused.
 * - The size from the header is checked before any browser or model decodes it: at most `PICTURE_LIMITS.side` on a side and
 *   `PICTURE_LIMITS.pixels` in all, so a small file that would unpack to gigabytes (a decompression bomb) is refused.
 * - Metadata goes: every JPEG APPn but a bare JFIF header, the ICC profile and Adobe's colour transform, and its comments and JPGn
 *   segments; every PNG chunk but those that draw it; WebP's EXIF and
 *   XMP chunks (and their flags); GIF's comments and application blocks other than looping. The colour profile stays, as it changes the
 *   colours.
 * - Anything after the picture's own end (a ZIP or a page appended to make a polyglot) is cut, and a file whose structure does not parse
 *   to its end is refused.
 *
 * Pure and synchronous over at most `FILE_LIMITS.fileBytes`; every loop advances by at least one byte.
 */
export const PICTURE_LIMITS = { bytes: FILE_LIMITS.fileBytes, side: 8_000, pixels: 40_000_000, frames: 500,
  /** The pixels of every frame of an animation together. */
  framePixels: 200_000_000 } as const;

export type PictureRefusal = 'not_picture' | 'svg' | 'too_large' | 'too_many_pixels' | 'broken';
export type CleanPicture = { ok: true; type: ThoughtImageType; bytes: Uint8Array; width: number; height: number } | { ok: false; reason: PictureRefusal };

class Broken extends Error {}
const broken = (): never => { throw new Broken('broken'); };
const ascii = (bytes: Uint8Array, at: number, length: number) => {
  let out = '';
  for (let i = at; i < at + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
};
const u16be = (b: Uint8Array, at: number) => (at + 2 <= b.length ? (b[at]! << 8) | b[at + 1]! : broken());
const u32be = (b: Uint8Array, at: number) => (at + 4 <= b.length ? ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]! : broken());
const u16le = (b: Uint8Array, at: number) => (at + 2 <= b.length ? b[at]! | (b[at + 1]! << 8) : broken());
const u24le = (b: Uint8Array, at: number) => (at + 3 <= b.length ? b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) : broken());
const u32le = (b: Uint8Array, at: number) => (at + 4 <= b.length ? (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000 : broken());
const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
};

type Walked = { bytes: Uint8Array; width: number; height: number; frames?: number };

/**
 * The PNG chunks that draw the picture or say how its colours look, and APNG's frames: kept. Every other chunk goes, text, time and EXIF among
 * them, and any private chunk a polyglot could hide a payload in.
 */
const PNG_KEPT = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'bKGD', 'pHYs',
  'acTL', 'fcTL', 'fdAT']);
function png(b: Uint8Array): Walked {
  const kept: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8; let width = 0; let height = 0; let first = true; let frames = 0;
  while (true) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > b.length || !/^[A-Za-z]{4}$/.test(type)) broken();
    if (first) {
      if (type !== 'IHDR' || length !== 13) broken();
      width = u32be(b, at + 8); height = u32be(b, at + 12);
      first = false;
    }
    if (type === 'fcTL') frames++;
    if (PNG_KEPT.has(type)) kept.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  return { bytes: concat(kept), width, height, frames: Math.max(frames, 1) };
}

/** JPEG markers that have no length; RSTn and TEM appear inside or between scans. */
const standalone = (marker: number) => (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
/** Start-of-frame markers (every SOFn but DHT, JPG and DAC), which carry the picture's size. */
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
function jpeg(b: Uint8Array): Walked {
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2; let width = 0; let height = 0;
  while (true) {
    if (b[at] !== 0xff) broken();
    while (b[at] === 0xff) at++; // fill bytes before a marker
    if (at >= b.length) broken();
    const marker = b[at]!;
    const start = at - 1;
    at++;
    if (marker === 0xd9) { kept.push(Uint8Array.of(0xff, 0xd9)); break; }
    if (marker === 0xd8) broken();
    if (standalone(marker)) { kept.push(b.subarray(start, at)); continue; }
    const length = u16be(b, at);
    const end = at + length;
    if (length < 2 || end > b.length) broken();
    if (isFrame(marker)) {
      // One frame to a picture: a second start-of-frame (a decoder would refuse it, or read a size the header check never saw) is refused.
      if (length < 8 || width || height) broken();
      height = u16be(b, at + 3); width = u16be(b, at + 5);
    }
    // APP0 only as the bare JFIF header (no thumbnail, nothing after it), APP2 only as the ICC profile, APP14 only as Adobe's 12-byte colour
    // transform: what changes how it looks. Every other APPn, COM and JPGn (0xF0-0xFD) segment goes.
    const appOrExtra = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe || (marker >= 0xf0 && marker <= 0xfd);
    const keep = !appOrExtra || (marker === 0xe0 && length === 16 && ascii(b, at + 2, 5) === 'JFIF\u0000' && b[at + 14] === 0 && b[at + 15] === 0)
      || (marker === 0xe2 && ascii(b, at + 2, 12) === 'ICC_PROFILE\u0000') || (marker === 0xee && length === 14 && ascii(b, at + 2, 5) === 'Adobe');
    if (keep) kept.push(b.subarray(start, end));
    at = end;
    if (marker === 0xda) {
      // The entropy-coded scan: up to the next marker that is neither a stuffed 0xFF00 nor a restart marker.
      const scan = at;
      while (at < b.length) {
        if (b[at] === 0xff && at + 1 < b.length && b[at + 1] !== 0x00 && !(b[at + 1]! >= 0xd0 && b[at + 1]! <= 0xd7) && b[at + 1] !== 0xff) break;
        at++;
      }
      if (at >= b.length) broken();
      kept.push(b.subarray(scan, at));
    }
  }
  if (!width || !height) broken();
  return { bytes: concat(kept), width, height };
}

/** GIF application blocks that only say how an animation loops: kept. Every other application block (XMP among them) and comments go. */
const LOOPING = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);
function gif(b: Uint8Array): Walked {
  const width = u16le(b, 6); const height = u16le(b, 8);
  const packed = b[10] ?? broken();
  let at = 13 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
  if (at > b.length) broken();
  const kept: Uint8Array[] = [b.subarray(0, at)];
  /** The data sub-blocks from `from`, through their zero terminator; returns where they end. */
  const subBlocks = (from: number) => {
    let p = from;
    while (true) {
      const size = b[p] ?? broken();
      p += 1 + size;
      if (p > b.length) broken();
      if (size === 0) return p;
    }
  };
  let frames = 0;
  let decoded = 0;
  while (true) {
    const kind = b[at] ?? broken();
    if (kind === 0x3b) { kept.push(Uint8Array.of(0x3b)); break; }
    if (kind === 0x21) {
      const label = b[at + 1] ?? broken();
      const end = subBlocks(at + 2);
      const keep = label === 0xf9 || label === 0x01 || (label === 0xff && b[at + 2] === 11 && LOOPING.has(ascii(b, at + 3, 11)));
      if (keep) kept.push(b.subarray(at, end));
      at = end;
    } else if (kind === 0x2c) {
      const frameWidth = u16le(b, at + 5); const frameHeight = u16le(b, at + 7);
      if (frameWidth > PICTURE_LIMITS.side || frameHeight > PICTURE_LIMITS.side) throw new TooManyPixels();
      // Every frame is decoded: their pixels together are bounded too, and a frame larger than the screen counts its own size.
      decoded += Math.max(frameWidth * frameHeight, 1);
      if (frameWidth * frameHeight > PICTURE_LIMITS.pixels || decoded > PICTURE_LIMITS.framePixels) throw new TooManyPixels();
      const flags = b[at + 9] ?? broken();
      const data = at + 10 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
      if (data >= b.length) broken();
      const end = subBlocks(data + 1);
      kept.push(b.subarray(at, end));
      at = end;
      frames++;
    } else broken();
  }
  if (!frames) broken();
  return { bytes: concat(kept), width, height, frames };
}

const WEBP_KEPT = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);
function webp(b: Uint8Array): Walked {
  const declared = u32le(b, 4) + 8;
  if (declared > b.length || declared < 20) broken();
  const kept: Uint8Array[] = [];
  let at = 12; let width = 0; let height = 0; let frames = 0; let extended: Uint8Array | null = null;
  while (at < declared) {
    const type = ascii(b, at, 4);
    const size = u32le(b, at + 4);
    const end = at + 8 + size + (size % 2);
    if (end > declared || end - (size % 2) > b.length) broken();
    const data = at + 8;
    if (type === 'VP8X') {
      if (size < 10 || kept.length) broken();
      width = u24le(b, data + 4) + 1; height = u24le(b, data + 7) + 1;
      // A copy whose flags no longer announce the EXIF and XMP chunks that are dropped.
      extended = b.slice(at, end);
      extended[8] = extended[8]! & ~0x0c;
      kept.push(extended);
    } else {
      if (type === 'VP8 ' && !extended) {
        if (size < 10 || b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) broken();
        width = u16le(b, data + 6) & 0x3fff; height = u16le(b, data + 8) & 0x3fff;
      }
      if (type === 'VP8L' && !extended) {
        if (size < 5 || b[data] !== 0x2f) broken();
        const bits = u32le(b, data + 1);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      }
      if (type === 'ANMF') frames++;
      if (WEBP_KEPT.has(type)) kept.push(b.subarray(at, end));
    }
    at = end;
  }
  if (!kept.some((chunk) => ['VP8 ', 'VP8L', 'ANMF'].includes(ascii(chunk, 0, 4)))) broken();
  const body = concat(kept);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 4)); head.set(b.subarray(8, 12), 8);
  const size = body.length + 4;
  head[4] = size & 0xff; head[5] = (size >>> 8) & 0xff; head[6] = (size >>> 16) & 0xff; head[7] = (size >>> 24) & 0xff;
  return { bytes: concat([head, body]), width, height, frames: Math.max(frames, 1) };
}

class TooManyPixels extends Error {}

/** The type these bytes start with, or null. The same signatures as `imageTypeOf` of the contracts. */
function signature(b: Uint8Array): ThoughtImageType | null {
  const starts = (...bytes: number[]) => bytes.every((value, index) => b[index] === value);
  if (b.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 3 && starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 6 && (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  if (b.length >= 12 && starts(0x52, 0x49, 0x46, 0x46) && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  return null;
}

/** Whether the bytes look like SVG (XML with an `<svg` element near its start), only to say so in plain words. */
function looksLikeSvg(b: Uint8Array): boolean {
  const head = ascii(b, 0, 2048).replace(/^\xEF\xBB\xBF/, '').trimStart().toLowerCase();
  return head.startsWith('<') && head.includes('<svg');
}

/** The picture these bytes are, rebuilt without metadata or anything after its end, or why not. Never throws. */
export function cleanPicture(input: Uint8Array): CleanPicture {
  if (input.length > PICTURE_LIMITS.bytes) return { ok: false, reason: 'too_large' };
  const type = signature(input);
  if (!type) return { ok: false, reason: looksLikeSvg(input) ? 'svg' : 'not_picture' };
  try {
    const walked = type === 'image/png' ? png(input) : type === 'image/jpeg' ? jpeg(input) : type === 'image/gif' ? gif(input) : webp(input);
    if (!walked.width || !walked.height) return { ok: false, reason: 'broken' };
    if (walked.width > PICTURE_LIMITS.side || walked.height > PICTURE_LIMITS.side || walked.width * walked.height > PICTURE_LIMITS.pixels
      || (walked.frames ?? 1) > PICTURE_LIMITS.frames || walked.width * walked.height * (walked.frames ?? 1) > PICTURE_LIMITS.framePixels)
      return { ok: false, reason: 'too_many_pixels' };
    return { ok: true, type, bytes: walked.bytes, width: walked.width, height: walked.height };
  } catch (error) {
    if (error instanceof TooManyPixels) return { ok: false, reason: 'too_many_pixels' };
    return { ok: false, reason: 'broken' };
  }
}

/** The extension a stored picture's name ends with. */
export const PICTURE_EXTENSIONS: Readonly<Record<ThoughtImageType, string>> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

/**
 * The display name of a picture: the caption the agent gave, else the address's last path segment, with the extension of its real type.
 * Within the 200 characters of a file name, with no control or path characters (`displayName` checks it again).
 */
export function pictureName(caption: string | null | undefined, address: string, type: ThoughtImageType): string {
  const clean = (value: string) => [...value.normalize('NFC')].filter((char) => {
    const code = char.codePointAt(0)!;
    return code >= 32 && !(code >= 127 && code <= 159) && !/[/\\\u202a-\u202e\u2066-\u2069]/.test(char);
  }).join('').replace(/\s+/g, ' ').trim();
  let base = clean(caption ?? '');
  if (!base) {
    try {
      const segment = decodeURIComponent(new URL(address).pathname.split('/').filter(Boolean).at(-1) ?? '');
      base = clean(segment).replace(/\.(png|jpe?g|gif|webp|svg|bmp|tiff?|avif|heic)$/i, '');
    } catch { base = ''; }
  }
  if (!base || base === '.' || base === '..') base = 'Picture';
  const extension = PICTURE_EXTENSIONS[type];
  return `${base.slice(0, 200 - extension.length - 1).trim()}.${extension}`;
}
