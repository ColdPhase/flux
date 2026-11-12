import sharp from 'sharp';
import { imageTypeOf, PICTURE_LIMITS, PICTURE_SIZES, type PictureSize } from '@flux/contracts';
import { InvalidInputError, PayloadTooLargeError, ServiceUnavailableError, type PictureRenderer, type Renditions } from '@flux/core';

/** The loaders Flux lets libvips use (F-039): PNG, JPEG and WebP from memory. Every other loader (SVG, GIF, TIFF, HEIF, …) stays blocked. */
const ALLOWED_LOADERS = ['VipsForeignLoadPngBuffer', 'VipsForeignLoadJpegBuffer', 'VipsForeignLoadWebpBuffer'];
const FORMAT = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' } as const;
const LARGEST = Math.max(...PICTURE_SIZES) as PictureSize;
const DECODE = { limitInputPixels: PICTURE_LIMITS.pixels, failOn: 'error', sequentialRead: true, pages: 1 } as const;
const SECONDS = 10;

/**
 * The picture renderer of the API (F-039, #1226), made once by the composition root. libvips is set up for untrusted input here: no
 * operation cache, one thread per picture, only the three loaders. One picture is rendered at a time and at most `waiting` more wait,
 * so a burst of uploads cannot take the target host's two vCPUs (#862); past that the upload is refused as busy, before its body is
 * read. The limit is per API process.
 */
export function sharpPictureRenderer({ waiting = 4 }: { waiting?: number } = {}): PictureRenderer {
  sharp.cache(false);
  sharp.concurrency(1);
  sharp.block({ operation: ['VipsForeignLoad'] });
  sharp.unblock({ operation: ALLOWED_LOADERS });
  let running = false;
  const queue: Array<() => void> = [];
  async function turn<T>(work: () => Promise<T>): Promise<T> {
    if (running) {
      if (queue.length >= waiting) throw new ServiceUnavailableError('Flux is busy with other pictures. Try again in a moment.', 'PICTURES_BUSY');
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running = true;
    try { return await work(); }
    finally { const next = queue.shift(); if (next) next(); else running = false; }
  }
  return {
    render: (bytes) => turn(() => render(bytes)),
    full: () => running && queue.length >= waiting,
  };
}

async function render(bytes: Uint8Array): Promise<Renditions> {
  // The bytes say what they are, never a name or a declared type; GIF is a picture Flux shows on a map, not a photo.
  const type = imageTypeOf(bytes);
  if (!type || type === 'image/gif') throw new InvalidInputError('Choose a PNG, JPEG or WebP picture', 'UNSUPPORTED_PICTURE');
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    // The header alone: a picture over the pixel limit is refused here, before anything is decoded.
    const meta = await sharp(input, DECODE).metadata();
    if (meta.format !== FORMAT[type]) throw new InvalidInputError('Choose a PNG, JPEG or WebP picture', 'UNSUPPORTED_PICTURE');
    // The camera's orientation first, so the middle square is the middle of the picture as it is seen.
    const width = meta.autoOrient?.width ?? meta.width;
    const height = meta.autoOrient?.height ?? meta.height;
    if (!width || !height) throw new InvalidInputError('This picture cannot be read', 'UNREADABLE_PICTURE');
    const side = Math.min(width, height);
    // Cropping before resizing keeps every step at most the picture's own size: a 1 × 30,000 strip becomes a 1 × 1 square, not a
    // 256 × 7,680,000 one. The pixels leave libvips once, raw, so no input metadata (EXIF, GPS, ICC, XMP) can reach a rendition.
    const { data, info } = await sharp(input, DECODE).timeout({ seconds: SECONDS }).autoOrient()
      .extract({ left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side })
      .resize(LARGEST, LARGEST, { fit: 'fill' }).toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const renditions = {} as Renditions;
    for (const size of PICTURE_SIZES) {
      renditions[size] = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
        .timeout({ seconds: SECONDS }).resize(size, size, { fit: 'fill' }).webp({ quality: 82, alphaQuality: 90 }).toBuffer();
    }
    return renditions;
  } catch (error) {
    if (error instanceof InvalidInputError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit/i.test(message)) throw new PayloadTooLargeError('A picture is at most 40 megapixels', 'PICTURE_TOO_MANY_PIXELS');
    throw new InvalidInputError('This picture cannot be read', 'UNREADABLE_PICTURE');
  }
}
