import { FILE_LIMITS, PICTURE_BOUNDS, pictureBounds, type ThoughtImageType } from '@flux/contracts';

/**
 * A picture from outside Flux, kept only as a picture (#1217, F-036 AG-8, C-59, #1343). The bytes are untrusted (a site an agent named, a
 * person's upload), so they are walked chunk by chunk in one bounded pass and rebuilt from the chunks that draw them; the server's real
 * decoder (`PictureCanonicalizer`, libvips in the API) then decodes every still picture and writes it again, so what a browser draws is
 * exactly what was checked.
 *
 * - The type comes from the bytes' own signature, never a name or a header: PNG, JPEG, GIF or WebP. SVG (which can carry script) and
 *   anything else is refused.
 * - The size from the header is checked before any browser or model decodes it: at most `PICTURE_BOUNDS.side` on a side and
 *   `PICTURE_BOUNDS.pixels` in all, so a small file that would unpack to gigabytes (a decompression bomb) is refused.
 * - One picture to a file: a WebP with a second image chunk, a canvas that is not its image's size, an animation frame outside its canvas
 *   or not the size it says, a second PNG header or an APNG frame outside its canvas, a second JPEG start-of-frame: decoders disagree about
 *   which size such a file has (the first image, the last, the canvas), so it is refused, not guessed at.
 * - Metadata goes: every JPEG APPn but a bare JFIF header, the ICC profile and Adobe's colour transform, and its comments, JPGn and
 *   reserved segments (only the markers a decoder needs stay), and the EXIF but for the camera's orientation, which is rewritten as an EXIF of its
 *   own with that one tag; every PNG chunk but those that draw it; WebP's EXIF and XMP chunks (and
 *   their flags) and any chunk it does not know; GIF's comments and application blocks other than looping. The colour profile stays, as it
 *   changes the colours.
 * - Anything after the picture's own end (a ZIP or a page appended to make a polyglot) is cut, and a file whose structure does not parse
 *   to its end is refused.
 *
 * Pure and synchronous over at most `FILE_LIMITS.fileBytes`; every loop advances by at least one byte.
 */
export const PICTURE_LIMITS = { bytes: FILE_LIMITS.fileBytes, side: PICTURE_BOUNDS.side, pixels: PICTURE_BOUNDS.pixels, frames: 500,
  /** The pixels of every frame of an animation together. */
  framePixels: 200_000_000,
  /**
   * The scans of a JPEG (review of #1343). Each scan of a progressive JPEG makes the decoder visit every block of the picture, and a scan of
   * end-of-band runs costs about 50 bytes: 5 MiB of them held libvips for 4 minutes on 2 CPUs, past its timeout, which only runs between
   * tiles. Encoders write 1 (baseline) to about 10 (progressive) scans.
   */
  scans: 100 } as const;

export type PictureRefusal = 'not_picture' | 'svg' | 'too_large' | 'too_many_pixels' | 'broken';
export type CleanPicture = { ok: true; type: ThoughtImageType; bytes: Uint8Array; width: number; height: number;
  /** 1 for a still picture; more for an animation (a GIF's frames, an APNG's, an animated WebP's). */
  frames: number;
  /** A WebP whose one image is lossless: written again losslessly. */
  lossless: boolean } | { ok: false; reason: PictureRefusal };

/**
 * The real decoder behind a stored picture (#1343), a port of the API (libvips, one picture at a time). It walks the bytes (`cleanPicture`),
 * decodes every still picture in full under the pixel bound, with the camera's orientation applied, and writes it again in its own type with
 * no metadata. An animation is not written again (frames would be lost or the file grow); libvips must agree with the walk on its size.
 * Answers a refusal for a file it cannot vouch for, and throws `ServiceUnavailableError` while it is busy.
 */
export interface PictureCanonicalizer {
  canonical(bytes: Uint8Array): Promise<CleanPicture>;
}

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

type Walked = { bytes: Uint8Array; width: number; height: number; frames?: number; lossless?: boolean };

/**
 * The PNG chunks that draw the picture or say how its colours look, and APNG's frames: kept. Every other chunk goes, text, time and EXIF among
 * them, and any private chunk a polyglot could hide a payload in. APNG's chunks stay only when an `acTL` announces an animation.
 */
const PNG_KEPT = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'bKGD', 'pHYs',
  'acTL']);
const APNG_KEPT = new Set(['fcTL', 'fdAT']);
function png(b: Uint8Array): Walked {
  const kept: Uint8Array[] = [b.subarray(0, 8)];
  let at = 8; let width = 0; let height = 0; let first = true; let frames = 0; let announced = -1; let drawn = false;
  while (true) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + length;
    if (length > 0x7fffffff || end > b.length || !/^[A-Za-z]{4}$/.test(type)) broken();
    if (first) {
      if (type !== 'IHDR' || length !== 13) broken();
      width = u32be(b, at + 8); height = u32be(b, at + 12);
      first = false;
    } else if (type === 'IHDR') broken(); // a second header: decoders would not agree on which size the picture has
    if (type === 'IDAT') drawn = true;
    if (type === 'acTL') {
      if (length !== 8 || announced >= 0 || drawn) broken();
      announced = u32be(b, at + 8);
    }
    if (type === 'fcTL' && announced >= 0) {
      // An APNG frame lies inside the canvas, or the file is refused.
      if (length !== 26) broken();
      const frameWidth = u32be(b, at + 12); const frameHeight = u32be(b, at + 16);
      if (!frameWidth || !frameHeight || u32be(b, at + 20) + frameWidth > width || u32be(b, at + 24) + frameHeight > height) broken();
      frames++;
    }
    if (PNG_KEPT.has(type) || (announced >= 0 && APNG_KEPT.has(type))) kept.push(b.subarray(at, end));
    at = end;
    if (type === 'IEND') break;
  }
  if (!drawn || (announced >= 0 && (announced < 1 || announced !== frames))) broken();
  return { bytes: concat(kept), width, height, frames: Math.max(announced, 1) };
}

/** JPEG markers that have no length; RSTn and TEM appear inside or between scans. */
const standalone = (marker: number) => (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01;
/** Start-of-frame markers (every SOFn but DHT, JPG and DAC), which carry the picture's size. */
const isFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
/** The other markers a decoder needs, and the only ones kept besides the frame and the scan: DHT, DAC, DQT, DNL and DRI. */
const JPEG_TABLES = new Set([0xc4, 0xcc, 0xdb, 0xdc, 0xdd]);
function jpeg(b: Uint8Array): Walked {
  const kept: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2; let width = 0; let height = 0; let orientation = 1; let scans = 0;
  while (true) {
    if (b[at] !== 0xff) broken();
    while (b[at] === 0xff) at++; // fill bytes before a marker
    if (at >= b.length) broken();
    const marker = b[at]!;
    const start = at - 1;
    at++;
    if (marker === 0xd9) { kept.push(Uint8Array.of(0xff, 0xd9)); break; }
    if (marker === 0xd8 || marker === 0x00) broken();
    if (standalone(marker)) continue; // outside a scan they say nothing
    const length = u16be(b, at);
    const end = at + length;
    if (length < 2 || end > b.length) broken();
    if (isFrame(marker)) {
      // One frame to a picture: a second start-of-frame (a decoder would refuse it, or read a size the header check never saw) is refused.
      if (length < 8 || width || height) broken();
      height = u16be(b, at + 3); width = u16be(b, at + 5);
    }
    // An allow-list: the frame, the scan and the tables a decoder needs; APP0 only as the bare JFIF header (no thumbnail, nothing after it),
    // APP2 only as the ICC profile, APP14 only as Adobe's 12-byte colour transform. Every other segment goes: the other APPn, comments, JPGn
    // and the reserved markers (0x02-0xBF), which a payload could hide in (#1343).
    const keep = marker === 0xda || isFrame(marker) || JPEG_TABLES.has(marker)
      || (marker === 0xe0 && length === 16 && ascii(b, at + 2, 5) === 'JFIF\u0000' && b[at + 14] === 0 && b[at + 15] === 0)
      || (marker === 0xe2 && ascii(b, at + 2, 12) === 'ICC_PROFILE\u0000') || (marker === 0xee && length === 14 && ascii(b, at + 2, 5) === 'Adobe');
    if (keep) kept.push(b.subarray(start, end));
    // The one thing of the EXIF that stays is how the camera was held (1-8), which decides which way up the picture is drawn.
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b, at + 2, end);
    at = end;
    if (marker === 0xda) {
      if (++scans > PICTURE_LIMITS.scans) broken();
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
  // Rewritten as an EXIF of its own with that one tag, after the JFIF header when there is one (it must come first).
  if (orientation !== 1) kept.splice(kept[1]?.[1] === 0xe0 ? 2 : 1, 0, orientationSegment(orientation));
  return { bytes: concat(kept), width, height };
}

/** The camera's orientation (1-8) an EXIF block's first directory says, or 1: read with every offset checked against the block. */
function exifOrientation(b: Uint8Array, from: number, to: number): number {
  if (ascii(b, from, 6) !== 'Exif\u0000\u0000') return 1;
  const tiff = from + 6;
  const little = ascii(b, tiff, 2) === 'II';
  if (!little && ascii(b, tiff, 2) !== 'MM') return 1;
  const u16 = (at: number) => (at + 2 <= to ? (little ? b[at]! | (b[at + 1]! << 8) : (b[at]! << 8) | b[at + 1]!) : -1);
  const u32 = (at: number) => (at + 4 <= to ? (little ? u16(at) + u16(at + 2) * 65536 : u16(at) * 65536 + u16(at + 2)) : -1);
  if (u16(tiff + 2) !== 0x2a) return 1;
  const directory = u32(tiff + 4);
  if (directory < 8) return 1;
  const entries = u16(tiff + directory);
  for (let i = 0; i < Math.min(entries, 64); i++) {
    const entry = tiff + directory + 2 + i * 12;
    if (u16(entry) === 0x0112 && u16(entry + 2) === 3 && u32(entry + 4) === 1) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}
/** An EXIF APP1 segment that says only the orientation. */
const orientationSegment = (orientation: number) => Uint8Array.of(0xff, 0xe1, 0x00, 0x22, ...Buffer.from('Exif\u0000\u0000MM\u0000*\u0000\u0000\u0000\u0008', 'latin1'),
  0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0);

/** GIF application blocks that only say how an animation loops: kept. Every other application block (XMP among them) and comments go. */
const LOOPING = new Set(['NETSCAPE2.0', 'ANIMEXTS1.0']);
function gif(b: Uint8Array): Walked {
  // The picture is as big as the screen or any frame's edge: a browser draws the screen, grown to a first frame that reaches past it.
  let width = u16le(b, 6); let height = u16le(b, 8);
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
      const left = u16le(b, at + 1); const top = u16le(b, at + 3);
      const frameWidth = u16le(b, at + 5); const frameHeight = u16le(b, at + 7);
      // A frame counts where it ends: Chromium and libvips grow the picture to the first frame's edge (a 1×1 screen with a 1×1 frame at
      // 7999, 4999 is drawn 8,000×5,000, review of #1343), so every frame's edge is within the bounds and the size is the largest edge.
      if (left + frameWidth > PICTURE_LIMITS.side || top + frameHeight > PICTURE_LIMITS.side) throw new TooManyPixels();
      // Every frame is decoded: their pixels together are bounded too, and a frame larger than the screen counts its own size.
      decoded += Math.max(frameWidth * frameHeight, 1);
      if (frameWidth * frameHeight > PICTURE_LIMITS.pixels || decoded > PICTURE_LIMITS.framePixels) throw new TooManyPixels();
      width = Math.max(width, left + frameWidth); height = Math.max(height, top + frameHeight);
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

/** The chunks of a WebP's RIFF body, or of an animation frame's payload; each one padded to an even size, which must lie inside `to`. */
type Chunk = { type: string; at: number; data: number; size: number; end: number };
const MAX_WEBP_CHUNKS = 4_096;
function chunksOf(b: Uint8Array, from: number, to: number): Chunk[] {
  const out: Chunk[] = [];
  let at = from;
  while (at < to) {
    if (at + 8 > to || out.length >= MAX_WEBP_CHUNKS) broken();
    const size = u32le(b, at + 4);
    const end = at + 8 + size + (size % 2);
    if (end > to || end - (size % 2) > b.length) broken();
    out.push({ type: ascii(b, at, 4), at, data: at + 8, size, end });
    at = end;
  }
  return out;
}
/**
 * The size an image chunk says, as libwebp reads it (a lossy frame header or a lossless one), and whether it is lossless. A frame header
 * libwebp would refuse (not a key frame, a profile over 3, not shown, a first partition longer than the chunk) is refused here too.
 */
function bitstream(b: Uint8Array, chunk: Chunk): { width: number; height: number; lossless: boolean } {
  if (chunk.type === 'VP8 ') {
    if (chunk.size < 10) broken();
    const bits = b[chunk.data]! | (b[chunk.data + 1]! << 8) | (b[chunk.data + 2]! << 16);
    if ((bits & 1) || ((bits >> 1) & 7) > 3 || !((bits >> 4) & 1) || (bits >> 5) >= chunk.size) broken();
    if (b[chunk.data + 3] !== 0x9d || b[chunk.data + 4] !== 0x01 || b[chunk.data + 5] !== 0x2a) broken();
    return { width: u16le(b, chunk.data + 6) & 0x3fff, height: u16le(b, chunk.data + 8) & 0x3fff, lossless: false };
  }
  if (chunk.size < 5 || b[chunk.data] !== 0x2f || (b[chunk.data + 4]! >> 5) !== 0) broken();
  const bits = u32le(b, chunk.data + 1);
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, lossless: true };
}
const WEBP_IMAGE = new Set(['VP8 ', 'VP8L', 'ALPH', 'ANIM', 'ANMF', 'VP8X']);
const le32 = (value: number) => Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);

/**
 * A WebP is one of: a simple file (one `VP8 ` or `VP8L` chunk), an extended still (`VP8X`, its canvas, an optional `ALPH` and `ICCP`, one
 * image whose own size is the canvas) or an extended animation (`VP8X`, `ANIM`, frames each inside the canvas and each exactly the size its
 * bitstream says). Anything with a second image, or with sizes that disagree, is refused: libwebp takes the canvas or the first image,
 * a model vendor's decoder may take another (#1343).
 */
function webp(b: Uint8Array): Walked {
  const declared = u32le(b, 4) + 8;
  if (declared > b.length || declared < 20) broken();
  const top = chunksOf(b, 12, declared);
  const first = top[0] ?? broken();
  const rest = top.slice(1);
  const bytesOf = (chunk: Chunk) => b.subarray(chunk.at, chunk.end);
  const kept: Uint8Array[] = [];
  let width: number; let height: number; let frames = 1; let lossless = false;
  if (first.type === 'VP8 ' || first.type === 'VP8L') {
    if (rest.some((chunk) => WEBP_IMAGE.has(chunk.type))) broken();
    ({ width, height, lossless } = bitstream(b, first));
    kept.push(bytesOf(first));
  } else if (first.type === 'VP8X') {
    if (first.size !== 10) broken();
    const flags = b[first.data]!;
    width = u24le(b, first.data + 4) + 1; height = u24le(b, first.data + 7) + 1;
    const icc = rest.find((chunk) => chunk.type === 'ICCP');
    const head: Uint8Array[] = [];
    const body: Uint8Array[] = [];
    if (flags & 0x02) {
      // An animation: no still image beside its frames, `ANIM` first, then frames that fit the canvas.
      if (rest.some((chunk) => ['VP8 ', 'VP8L', 'ALPH', 'VP8X'].includes(chunk.type))) broken();
      const anim = rest.filter((chunk) => chunk.type === 'ANIM');
      const list = rest.filter((chunk) => chunk.type === 'ANMF');
      if (anim.length !== 1 || anim[0]!.size < 6 || !list.length || rest.indexOf(anim[0]!) > rest.indexOf(list[0]!)) broken();
      body.push(bytesOf(anim[0]!));
      for (const frame of list) {
        if (frame.size < 24) broken();
        const x = u24le(b, frame.data) * 2; const y = u24le(b, frame.data + 3) * 2;
        const frameWidth = u24le(b, frame.data + 6) + 1; const frameHeight = u24le(b, frame.data + 9) + 1;
        if (x + frameWidth > width || y + frameHeight > height) broken();
        const inner = chunksOf(b, frame.data + 16, frame.data + frame.size);
        if (inner.some((chunk) => ['VP8X', 'ANIM', 'ANMF', 'ICCP'].includes(chunk.type))) broken();
        const images = inner.filter((chunk) => chunk.type === 'VP8 ' || chunk.type === 'VP8L');
        const alpha = inner.filter((chunk) => chunk.type === 'ALPH');
        if (images.length !== 1 || alpha.length > 1 || (alpha.length && (images[0]!.type !== 'VP8 ' || inner.indexOf(alpha[0]!) > inner.indexOf(images[0]!)))) broken();
        const size = bitstream(b, images[0]!);
        if (size.width !== frameWidth || size.height !== frameHeight) broken();
        // The frame again with its header, its alpha and its image only, and its own size.
        const parts = [...alpha.map(bytesOf), bytesOf(images[0]!)];
        const length = 16 + parts.reduce((sum, part) => sum + part.length, 0);
        body.push(concat([Uint8Array.of(0x41, 0x4e, 0x4d, 0x46), le32(length), b.subarray(frame.data, frame.data + 16), ...parts]));
      }
      frames = list.length;
    } else {
      // A still: exactly one image, as big as the canvas, with at most one `ALPH` before it (lossy only).
      if (rest.some((chunk) => ['ANIM', 'ANMF', 'VP8X'].includes(chunk.type))) broken();
      const images = rest.filter((chunk) => chunk.type === 'VP8 ' || chunk.type === 'VP8L');
      const alpha = rest.filter((chunk) => chunk.type === 'ALPH');
      if (images.length !== 1 || alpha.length > 1 || (alpha.length && (images[0]!.type !== 'VP8 ' || rest.indexOf(alpha[0]!) > rest.indexOf(images[0]!)))) broken();
      const size = bitstream(b, images[0]!);
      if (size.width !== width || size.height !== height) broken();
      lossless = size.lossless;
      body.push(...alpha.map(bytesOf), bytesOf(images[0]!));
    }
    // A copy whose flags no longer announce the EXIF and XMP chunks that are dropped, and announce the profile only if it stays.
    const extended = b.slice(first.at, first.end);
    extended[8] = (extended[8]! & ~0x2c) | (icc ? 0x20 : 0);
    head.push(extended);
    if (icc) head.push(bytesOf(icc));
    kept.push(...head, ...body);
  } else return broken();
  const body = concat(kept);
  const head = new Uint8Array(12);
  head.set(b.subarray(0, 4)); head.set(b.subarray(8, 12), 8);
  head.set(le32(body.length + 4), 4);
  return { bytes: concat([head, body]), width, height, frames, lossless };
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

/**
 * The picture these bytes are, rebuilt without metadata or anything after its end, or why not. Never throws. `side` is the longest side a
 * stored picture may have; a profile photo or a space icon passes no limit (F-039: any shape within the pixels, cropped to a square).
 */
export function cleanPicture(input: Uint8Array, { side = PICTURE_LIMITS.side }: { side?: number } = {}): CleanPicture {
  if (input.length > PICTURE_LIMITS.bytes) return { ok: false, reason: 'too_large' };
  const type = signature(input);
  if (!type) return { ok: false, reason: looksLikeSvg(input) ? 'svg' : 'not_picture' };
  try {
    const walked = type === 'image/png' ? png(input) : type === 'image/jpeg' ? jpeg(input) : type === 'image/gif' ? gif(input) : webp(input);
    if (!walked.width || !walked.height) return { ok: false, reason: 'broken' };
    if (walked.width > side || walked.height > side || walked.width * walked.height > PICTURE_LIMITS.pixels
      || (walked.frames ?? 1) > PICTURE_LIMITS.frames || walked.width * walked.height * (walked.frames ?? 1) > PICTURE_LIMITS.framePixels)
      return { ok: false, reason: 'too_many_pixels' };
    // What a browser would be asked to allocate for what is kept is what was checked: no header of the rebuilt file claims more.
    const claimed = pictureBounds(walked.bytes);
    if (!claimed || claimed.width > walked.width || claimed.height > walked.height) return { ok: false, reason: 'broken' };
    return { ok: true, type, bytes: walked.bytes, width: walked.width, height: walked.height, frames: walked.frames ?? 1, lossless: walked.lossless ?? false };
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
