import { crc32, deflateSync } from 'node:zlib';

/**
 * TEST ONLY (#1217, #1343): small real pictures and hostile variants of them, for the picture cleaner, the link mock (`/pic/…`) and the UI suite.
 * Every one is built here, from bytes, so no fixture file is needed.
 */

const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value >>> 0); return out; };
const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, u32(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])))]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A decodable RGB PNG of `width`×`height` in a two-colour pattern, with what a camera or an editor would write in it when `metadata`. */
export function png(width = 48, height = 32, options: { metadata?: boolean; declared?: { width: number; height: number } } = {}): Buffer {
  const header = Buffer.concat([u32(options.declared?.width ?? width), u32(options.declared?.height ?? height), Buffer.from([8, 2, 0, 0, 0])]);
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const green = ((x >> 3) + (y >> 3)) % 2 === 0;
      row.set(green ? [76, 140, 74] : [160, 120, 80], 1 + x * 3);
    }
    rows.push(row);
  }
  const extra = options.metadata ? [chunk('tEXt', Buffer.from('Author\0Ada Nowak, Kraków')), chunk('tIME', Buffer.from([7, 234, 11, 12, 9, 30, 0])),
    chunk('eXIf', Buffer.from('MM\0*GPS 52.2297N 21.0122E'))] : [];
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), ...extra, chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** A 1×1 GIF (the classic one), and one with a comment block. */
export const GIF = Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64');
export function gifWithComment(): Buffer {
  // The comment extension goes right before the image's trailer: 0x21 0xFE, one sub-block, a terminator.
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 11]), Buffer.from('GPS 52.2297'), Buffer.from([0])]);
  return Buffer.concat([GIF.subarray(0, GIF.length - 1), comment, Buffer.from([0x3b])]);
}

/** A GIF of a 1×1 screen and one 1×1 frame placed at `left`, `top` (review of #1343): Chromium and libvips grow the picture to the frame's edge. */
export const gifFrameAt = (left: number, top: number) => Buffer.concat([GIF.subarray(0, 13 + 6),
  Buffer.from([0x2c, left & 0xff, left >> 8, top & 0xff, top >> 8, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0, 0x3b])]);

/** A 1×1 lossless WebP, and the same in an extended file with an EXIF chunk that its flags announce. */
export const WEBP = Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64');
export function webpWithExif(): Buffer {
  const le32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32LE(value); return out; };
  const vp8l = WEBP.subarray(12);
  const vp8x = Buffer.concat([Buffer.from('VP8X'), le32(10), Buffer.from([0x08, 0, 0, 0, 0, 0, 0, 0, 0, 0])]);
  const exifData = Buffer.from('Exif\0\0GPS 52.2297N');
  const exif = Buffer.concat([Buffer.from('EXIF'), le32(exifData.length), exifData, exifData.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
  const body = Buffer.concat([Buffer.from('WEBP'), vp8x, vp8l, exif]);
  return Buffer.concat([Buffer.from('RIFF'), le32(body.length), body]);
}

/** A real 16×8 baseline JPEG (made by libjpeg, no metadata): the base of `jpeg()`. */
const REAL_JPEG = Buffer.from('/9j/2wBDAAUDBAQEAwUEBAQFBQUGBwwIBwcHBw8LCwkMEQ8SEhEPERETFhwXExQaFRERGCEYGh0dHx8fExciJCIeJBweHx7/2wBDAQUFBQcGBw4ICA4eFBEUHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh7/wAARCAAIABADAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAABf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAWAQEBAQAAAAAAAAAAAAAAAAAGBAf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwAccFCydqD/2Q==', 'base64');
const segment = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
/** A little-endian EXIF block (TIFF) with one tag: the camera's orientation (1-8). */
const exifOrientation = (orientation: number) => Buffer.concat([Buffer.from('Exif\0\0MM\0*\0\0\0\x08', 'latin1'), Buffer.from([0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0])]);

/**
 * A real, decodable baseline JPEG of `width`×`height` as its header says (16×8 by its data: a header that says more makes a decoder fill the rest),
 * with an EXIF APP1 that carries a location, an XMP APP1, a comment and an IPTC APP13 when `metadata`, and an `orientation` when one is given.
 */
export function jpeg(options: { metadata?: boolean; width?: number; height?: number; orientation?: number; reserved?: Buffer } = {}): Buffer {
  const width = options.width ?? 16; const height = options.height ?? 8;
  const app0 = segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
  const meta = options.metadata ? [segment(0xe1, Buffer.from('Exif\0\0MM\0*GPS 52.2297N 21.0122E Ada Nowak', 'latin1')),
    segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Ada Nowak</x:xmpmeta>', 'latin1')),
    segment(0xfe, Buffer.from('Taken at home', 'latin1')), segment(0xed, Buffer.from('Photoshop 3.0\0IPTC Ada', 'latin1'))] : [];
  if (options.orientation) meta.push(segment(0xe1, exifOrientation(options.orientation)));
  // A reserved marker (0xFF02-0xFFBF) a decoder skips or refuses, and a payload could hide in (#1343).
  if (options.reserved) meta.push(segment(0x7a, options.reserved));
  const body = Buffer.from(REAL_JPEG.subarray(2));
  const sof = body.indexOf(Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08]));
  body.writeUInt16BE(height, sof + 5); body.writeUInt16BE(width, sof + 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, ...meta, body]);
}

/** A JPEG of `scans` scans (review of #1343): the real one's scan again and again, as a progressive file's scans follow one another. */
export function jpegWithScans(scans: number): Buffer {
  const plain = jpeg();
  const sos = plain.indexOf(Buffer.from([0xff, 0xda]));
  const scan = plain.subarray(sos, plain.length - 2);
  return Buffer.concat([plain.subarray(0, sos), ...Array.from({ length: scans }, () => scan), Buffer.from([0xff, 0xd9])]);
}

/** A JPEG whose EXIF carries a thumbnail JPEG with a start-of-frame of its own, 60,000×60,000: gone with the rest of the EXIF. */
export function jpegWithBombThumbnail(): Buffer {
  const plain = jpeg();
  return Buffer.concat([plain.subarray(0, 2), segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0MM\0*', 'latin1'), jpeg({ width: 60_000, height: 60_000 })])), plain.subarray(2)]);
}

/** Lossless WebP data of one colour (#1343, from the audit of #1270): every prefix code has one symbol, so a pixel costs no bits and any size is a few bytes. */
function vp8l(width: number, height: number): Buffer {
  const bits: number[] = [];
  const put = (value: number, count: number) => { for (let i = 0; i < count; i++) bits.push((value >>> i) & 1); };
  put(width - 1, 14); put(height - 1, 14); put(1, 1); put(0, 3); // size, alpha used, version 0
  put(0, 1); put(0, 1); put(0, 1); // no transform, no colour cache, no meta prefix codes
  for (const symbol of [0x40, 0xc0, 0x20, 0xff, 0]) { put(1, 1); put(0, 1); if (symbol < 2) { put(0, 1); put(symbol, 1); } else { put(1, 1); put(symbol, 8); } }
  const packed = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => { if (bit) packed[index >> 3]! |= 1 << (index & 7); });
  return Buffer.concat([Buffer.from([0x2f]), packed]);
}
const le = (value: number, bytes: number) => { const out = Buffer.alloc(bytes); out.writeUIntLE(value, 0, bytes); return out; };
const riffChunk = (type: string, data: Buffer) => Buffer.concat([Buffer.from(type, 'latin1'), le(data.length, 4), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const riff = (...chunks: Buffer[]) => { const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]); return Buffer.concat([Buffer.from('RIFF'), le(body.length, 4), body]); };
const vp8x = (width: number, height: number, flags: number) => riffChunk('VP8X', Buffer.concat([Buffer.from([flags, 0, 0, 0]), le(width - 1, 3), le(height - 1, 3)]));

/** A lossy `VP8 ` chunk that says `width`×`height` (a key frame header libwebp accepts, then bytes that are no picture: only the walk reads it). */
const vp8 = (width: number, height: number) => Buffer.concat([Buffer.from([0x30, 0, 0, 0x9d, 0x01, 0x2a]), le(width, 2), le(height, 2), Buffer.alloc(8)]);

/** WebP files for #1343: one lossless image of one colour, and the hostile shapes of the audit. */
export const webp = {
  solid: (width: number, height: number) => riff(riffChunk('VP8L', vp8l(width, height))),
  /** A 16383×16383 image first and a 1×1 one after it: a decoder draws the first, a reader of the last chunk saw 1×1. */
  twoChunks: () => riff(riffChunk('VP8L', vp8l(16_383, 16_383)), riffChunk('VP8L', vp8l(1, 1))),
  twoChunksReversed: () => riff(riffChunk('VP8L', vp8l(1, 1)), riffChunk('VP8L', vp8l(16_383, 16_383))),
  /** The same with two lossy `VP8 ` chunks. */
  twoLossyChunks: () => riff(riffChunk('VP8 ', vp8(16_383, 16_383)), riffChunk('VP8 ', vp8(1, 1))),
  /** A canvas of 1×1 and an image of 16383×16383 inside it. */
  stillMismatch: () => riff(vp8x(1, 1, 0x10), riffChunk('VP8L', vp8l(16_383, 16_383))),
  /** The same canvas with one animation frame that says 16383×16383 and carries that image. */
  animatedMismatch: () => riff(vp8x(1, 1, 0x12), riffChunk('ANIM', Buffer.alloc(6)),
    riffChunk('ANMF', Buffer.concat([le(0, 3), le(0, 3), le(16_382, 3), le(16_382, 3), le(100, 3), Buffer.from([0]), riffChunk('VP8L', vp8l(16_383, 16_383))]))),
  /** A well-formed animation of `frames` frames, each `width`×`height`, on a canvas of that size (a frame placed `shift` pixels, an even number, to the right). */
  animated: (width: number, height: number, frames: number, shift = 0) => riff(vp8x(width, height, 0x12), riffChunk('ANIM', Buffer.alloc(6)),
    ...Array.from({ length: frames }, () => riffChunk('ANMF', Buffer.concat([le(shift / 2, 3), le(0, 3), le(width - 1, 3), le(height - 1, 3), le(100, 3), Buffer.from([0]), riffChunk('VP8L', vp8l(width, height))])))),
  /** An extended still whose canvas and image agree, with an EXIF chunk that its flags announce. */
  extended: (width: number, height: number) => riff(vp8x(width, height, 0x18), riffChunk('VP8L', vp8l(width, height)), riffChunk('EXIF', Buffer.from('Exif\0\0GPS 52.2297N'))),
};

/** An APNG: a `width`×`height` canvas, a default image and `frames` animation frames (each as `[width, height, x, y]`). */
export function apng(width: number, height: number, frames: Array<[number, number, number, number]>): Buffer {
  const base = png(width, height);
  const idat = base.subarray(base.indexOf(Buffer.from('IDAT')) - 4, base.length - 12);
  let sequence = 0;
  const control = ([w, h, x, y]: [number, number, number, number]) => chunk('fcTL', Buffer.concat([u32(sequence++), u32(w), u32(h), u32(x), u32(y), Buffer.from([0, 1, 0, 10, 0, 0])]));
  const data = ([w, h]: [number, number]) => { const inner = png(w, h); const part = inner.subarray(inner.indexOf(Buffer.from('IDAT')) + 4, inner.length - 12 - 4); return chunk('fdAT', Buffer.concat([u32(sequence++), part.subarray(0, part.length)])); };
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', Buffer.concat([u32(width), u32(height), Buffer.from([8, 2, 0, 0, 0])])), chunk('acTL', Buffer.concat([u32(frames.length), u32(0)])),
    control(frames[0]!), idat, ...frames.slice(1).flatMap((frame) => [control(frame), data([frame[0], frame[1]])]), chunk('IEND', Buffer.alloc(0))]);
}

/** A GIF of `frames` frames of the 1×1 picture, looping, with a comment. */
export function animatedGif(frames: number): Buffer {
  const frame = GIF.subarray(GIF.indexOf(Buffer.from([0x21, 0xf9])), GIF.length - 1);
  const loop = Buffer.from([0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0]);
  const comment = Buffer.concat([Buffer.from([0x21, 0xfe, 11]), Buffer.from('GPS 52.2297'), Buffer.from([0])]);
  return Buffer.concat([GIF.subarray(0, GIF.indexOf(Buffer.from([0x21, 0xf9]))), loop, comment, ...Array.from({ length: frames }, () => frame), Buffer.from([0x3b])]);
}

export const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
/** A ZIP's local header, appended after a picture's end to make a polyglot. */
export const APPENDED = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('<html><script>alert(document.cookie)</script></html>')]);
