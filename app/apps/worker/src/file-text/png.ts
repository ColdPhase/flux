import { crc32, deflateSync } from 'node:zlib';

/**
 * The pictures of a PDF without text (C-69, #1557), made in the sandboxed child: a page's picture as PDF.js decoded it, scaled down to a
 * bounded size by averaging and written as a PNG with Node's own zlib. Nothing here reads a file or the network.
 */

/** What PDF.js hands over for a decoded picture: 1 is one bit a pixel (a set bit is white), 2 is RGB, 3 is RGBA (pdfjs `ImageKind`). */
export interface DecodedPicture { width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray }
/** Eight bits a pixel: one channel (grey) or three (RGB). */
export interface Pixels { width: number; height: number; channels: 1 | 3; data: Uint8Array }

/** A decoded picture as grey or RGB, a transparent one on white; null for a kind PDF.js does not make. */
export function toPixels(picture: DecodedPicture): Pixels | null {
  const { width, height, kind, data } = picture;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  const count = width * height;
  if (kind === 1) {
    const stride = Math.ceil(width / 8);
    if (data.length < stride * height) return null;
    const out = new Uint8Array(count);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = data[y * stride + (x >> 3)]! & (0x80 >> (x & 7)) ? 255 : 0;
    return { width, height, channels: 1, data: out };
  }
  if (kind === 2) {
    if (data.length < count * 3) return null;
    // A view of PDF.js's own pixels, not a copy: a 16-million-pixel picture would otherwise be held twice (48 MB more resident).
    return { width, height, channels: 3, data: new Uint8Array(data.buffer, data.byteOffset, count * 3) };
  }
  if (kind === 3) {
    if (data.length < count * 4) return null;
    const out = new Uint8Array(count * 3);
    for (let i = 0; i < count; i++) {
      const alpha = data[i * 4 + 3]!;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round((data[i * 4 + c]! * alpha + 255 * (255 - alpha)) / 255);
    }
    return { width, height, channels: 3, data: out };
  }
  return null;
}

/** Grey when every pixel is (a scan): a third of the size. */
export function greyIfGrey(pixels: Pixels): Pixels {
  if (pixels.channels === 1) return pixels;
  const { data } = pixels;
  for (let i = 0; i < data.length; i += 3) if (data[i] !== data[i + 1] || data[i] !== data[i + 2]) return pixels;
  const out = new Uint8Array(data.length / 3);
  for (let i = 0; i < out.length; i++) out[i] = data[i * 3]!;
  return { ...pixels, channels: 1, data: out };
}

/** At most `side` pixels on the long side, each target pixel the average of the source pixels it covers; a smaller picture is kept. */
export function scaleDown(pixels: Pixels, side: number): Pixels {
  const { width, height, channels, data } = pixels;
  const scale = Math.min(1, side / Math.max(width, height));
  if (scale === 1) return pixels;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h * channels);
  const sums = new Float64Array(w * channels);
  const counts = new Float64Array(w);
  const column = new Int32Array(width);
  for (let x = 0; x < width; x++) column[x] = Math.min(w - 1, Math.floor(x * w / width));
  let row = 0;
  for (let y = 0; y < height; y++) {
    const target = Math.min(h - 1, Math.floor(y * h / height));
    if (target !== row) { flush(row); row = target; }
    for (let x = 0; x < width; x++) {
      const t = column[x]!;
      counts[t]! += 1;
      for (let c = 0; c < channels; c++) sums[t * channels + c]! += data[(y * width + x) * channels + c]!;
    }
  }
  flush(row);
  return { width: w, height: h, channels, data: out };

  function flush(target: number) {
    for (let t = 0; t < w; t++) {
      const n = counts[t]! || 1;
      for (let c = 0; c < channels; c++) out[(target * w + t) * channels + c] = Math.round(sums[t * channels + c]! / n);
    }
    sums.fill(0);
    counts.fill(0);
  }
}

function chunk(type: string, body: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, tail]);
}

/** A PNG of 8-bit grey or RGB, each row filtered with "Up" (the row above), which keeps a scan's long runs small; zlib's
 * default level (6): level 9 took 40 % more time on a page of 16 million pixels for 1 % fewer bytes. */
export function encodePng(pixels: Pixels): Buffer {
  const { width, height, channels, data } = pixels;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 2;
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = (data[y * stride + i]! - (y ? data[(y - 1) * stride + i]! : 0)) & 0xff;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 1 ? 0 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0))]);
}
