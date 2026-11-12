import { crc32, deflateSync } from 'node:zlib';

/**
 * TEST ONLY (#1217): small real pictures and hostile variants of them, for the picture cleaner, the link mock (`/pic/…`) and the UI suite.
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

/**
 * A structurally complete baseline JPEG of 16×8 (one scan of placeholder data: the cleaner walks markers, it does not decode), with an
 * EXIF APP1 that carries a location, an XMP APP1, a comment and an IPTC APP13 when `metadata`.
 */
export function jpeg(options: { metadata?: boolean; width?: number; height?: number } = {}): Buffer {
  const segment = (marker: number, data: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), Buffer.from([(data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);
  const width = options.width ?? 16; const height = options.height ?? 8;
  const app0 = segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1'));
  const meta = options.metadata ? [segment(0xe1, Buffer.from('Exif\0\0MM\0*GPS 52.2297N 21.0122E Ada Nowak', 'latin1')),
    segment(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>Ada Nowak</x:xmpmeta>', 'latin1')),
    segment(0xfe, Buffer.from('Taken at home', 'latin1')), segment(0xed, Buffer.from('Photoshop 3.0\0IPTC Ada', 'latin1'))] : [];
  const dqt = segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
  const sof = segment(0xc0, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]));
  const dht = segment(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from([0])]));
  const sos = segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
  // Entropy-coded data with a stuffed 0xFF00 and a restart marker inside it.
  const scan = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, ...meta, dqt, sof, dht, sos, scan, Buffer.from([0xff, 0xd9])]);
}

export const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>');
/** A ZIP's local header, appended after a picture's end to make a polyglot. */
export const APPENDED = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('<html><script>alert(document.cookie)</script></html>')]);
