import sharp from 'sharp';
import { FILE_LIMITS, imageTypeOf, PICTURE_LIMITS, PICTURE_SIZES, type PictureSize } from '@flux/contracts';
import { cleanPicture, InvalidInputError, PayloadTooLargeError, ServiceUnavailableError, type CleanPicture, type PictureCanonicalizer, type PictureRenderer,
  type Renditions } from '@flux/core';

/**
 * The loaders Flux lets libvips use: PNG, JPEG and WebP from memory (F-039), and GIF only to read the size of an animation a stored picture
 * keeps (#1343). Every other loader (SVG, TIFF, HEIF, …) stays blocked.
 */
const ALLOWED_LOADERS = ['VipsForeignLoadPngBuffer', 'VipsForeignLoadJpegBuffer', 'VipsForeignLoadWebpBuffer', 'VipsForeignLoadNsgifBuffer'];
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
export function sharpPictureRenderer({ waiting = 4, picturesWaiting = 16 }: { waiting?: number; picturesWaiting?: number } = {}): PictureRenderer & PictureCanonicalizer {
  sharp.cache(false);
  sharp.concurrency(1);
  sharp.block({ operation: ['VipsForeignLoad'] });
  sharp.unblock({ operation: ALLOWED_LOADERS });
  let running = false;
  const queue: Array<() => void> = [];
  async function turn<T>(work: () => Promise<T>, limit = waiting): Promise<T> {
    if (running) {
      if (queue.length >= limit) throw new ServiceUnavailableError('Flux is busy with other pictures. Try again in a moment.', 'PICTURES_BUSY');
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    running = true;
    try { return await work(); }
    finally { const next = queue.shift(); if (next) next(); else running = false; }
  }
  return {
    render: (bytes) => turn(() => render(bytes)),
    poster: (bytes) => turn(() => poster(bytes)),
    full: () => running && queue.length >= waiting,
    // Stored pictures wait in the same line, a few more than photos may: a message carries up to ten files, and each one has already arrived.
    canonical: (bytes) => turn(() => canonical(bytes), picturesWaiting),
  };
}

const SECONDS_PER_PICTURE = SECONDS;
const CANONICAL_PIXELS = { limitInputPixels: PICTURE_LIMITS.pixels, failOn: 'error' } as const;
const refused = (reason: Extract<CleanPicture, { ok: false }>['reason']): CleanPicture => ({ ok: false, reason });

/**
 * A stored picture, decoded and written again (#1343, C-59): the bytes are walked first (`cleanPicture`: one picture to a file, a size every
 * decoder agrees on, within `PICTURE_BOUNDS`), then libvips, a real decoder, decodes a still picture in full under the pixel bound with the
 * camera's orientation applied and writes it in its own type with no metadata: a PNG lossless (a palette stays a palette), a JPEG at
 * quality 85, a WebP lossless if it was and at quality 85 if not. What comes out is walked again and must be one picture of the size
 * libvips wrote. An animation (a GIF, an APNG, an animated WebP) is kept as the walk rebuilt it, only when libvips reads the same canvas.
 */
async function canonical(input: Uint8Array): Promise<CleanPicture> {
  const walked = cleanPicture(input);
  if (!walked.ok) return walked;
  const format = FORMAT[walked.type as keyof typeof FORMAT] ?? 'gif';
  try {
    if (walked.frames > 1 || walked.type === 'image/gif') {
      const meta = await sharp(Buffer.from(walked.bytes), CANONICAL_PIXELS).metadata();
      return meta.format === format && meta.width === walked.width && (meta.pageHeight ?? meta.height) === walked.height ? walked : refused('broken');
    }
    // libvips reads the picture as the walk rebuilt it: no metadata of the file's own but the orientation, no segment a payload could hide in.
    const source = Buffer.from(walked.bytes);
    const meta = await sharp(source, CANONICAL_PIXELS).metadata();
    if (meta.format !== format || (meta.pages ?? 1) > 1) return refused('broken');
    const image = sharp(source, CANONICAL_PIXELS).timeout({ seconds: SECONDS_PER_PICTURE }).autoOrient();
    const written = await (walked.type === 'image/png' ? image.png(meta.isPalette ? { palette: true, colours: 256, dither: 0, compressionLevel: 9 } : { compressionLevel: 9 })
      : walked.type === 'image/jpeg' ? image.jpeg({ quality: 85 })
        // Lossless WebP at the least effort (review of #1343): libwebp's lossless encoder at effort 2 took 1.4 GiB for a 155 KB, 40 MP file
        // and the API was killed at its 1.5 GiB limit; at effort 0 it is about 0.6 GiB, like a lossy one.
        : walked.lossless ? image.webp({ lossless: true, effort: 0, exact: true }) : image.webp({ quality: 85, alphaQuality: 100 })).toBuffer({ resolveWithObject: true });
    if (written.data.byteLength > FILE_LIMITS.fileBytes) return refused('too_large');
    // What libvips wrote is checked the way a file from outside is: one picture, of the size it says.
    const again = cleanPicture(written.data);
    if (!again.ok || again.type !== walked.type || again.frames !== 1 || again.width !== written.info.width || again.height !== written.info.height) return refused('broken');
    return again;
  } catch (error) {
    return refused(/pixel limit/i.test(error instanceof Error ? error.message : '') ? 'too_many_pixels' : 'broken');
  }
}

async function render(bytes: Uint8Array): Promise<Renditions> {
  // The bytes say what they are, never a name or a declared type; GIF is a picture Flux shows on a map, not a photo.
  const type = imageTypeOf(bytes);
  if (!type || type === 'image/gif') throw new InvalidInputError('Choose a PNG, JPEG or WebP picture', 'UNSUPPORTED_PICTURE');
  // The walk every stored picture takes first (review of #1343): one picture to a file, within the pixels, and a JPEG of at most 100 scans
  // (thousands of progressive scans hold libvips for minutes, past its timeout, in the one line every picture waits in). Any side: a photo
  // is cropped to its middle square, so a 30,000 × 1 strip is a 1 × 1 one (F-039).
  const walked = cleanPicture(bytes, { side: Number.POSITIVE_INFINITY });
  if (!walked.ok) {
    if (walked.reason === 'too_many_pixels') throw new PayloadTooLargeError('A picture is at most 40 megapixels', 'PICTURE_TOO_MANY_PIXELS');
    throw new InvalidInputError('This picture cannot be read', 'UNREADABLE_PICTURE');
  }
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

/**
 * A video's poster (C-61) from the picture the sender's browser drew, on the path every stored picture takes (#1343): the bytes say what it
 * is (PNG, JPEG or WebP, never anything else), the walk (`cleanPicture`) wants one still picture whose headers agree on one size within the
 * bounds, libvips reads the picture as the walk rebuilt it, and only the pixels leave libvips, as a WebP at most `FILE_LIMITS.posterEdge` px on
 * its longest side, so no input metadata and nothing appended to the file survives. The stored poster is then canonicalized like any picture.
 */
async function poster(bytes: Uint8Array): Promise<Uint8Array> {
  const type = imageTypeOf(bytes);
  if (!type || type === 'image/gif') throw new InvalidInputError('The poster must be a PNG, JPEG or WebP picture', 'UNSUPPORTED_PICTURE');
  const walked = cleanPicture(bytes);
  if (!walked.ok || walked.frames !== 1) {
    if (!walked.ok && walked.reason === 'too_many_pixels') throw new PayloadTooLargeError('A picture is at most 8,000 pixels on a side and 40 megapixels', 'PICTURE_TOO_MANY_PIXELS');
    throw new InvalidInputError('This picture cannot be read', 'UNREADABLE_PICTURE');
  }
  const input = Buffer.from(walked.bytes);
  try {
    const meta = await sharp(input, DECODE).metadata();
    if (meta.format !== FORMAT[type]) throw new InvalidInputError('The poster must be a PNG, JPEG or WebP picture', 'UNSUPPORTED_PICTURE');
    return await sharp(input, DECODE).timeout({ seconds: SECONDS }).autoOrient()
      .resize(FILE_LIMITS.posterEdge, FILE_LIMITS.posterEdge, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb').webp({ quality: 78 }).toBuffer();
  } catch (error) {
    if (error instanceof InvalidInputError) throw error;
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit/i.test(message)) throw new PayloadTooLargeError('A picture is at most 40 megapixels', 'PICTURE_TOO_MANY_PIXELS');
    throw new InvalidInputError('This picture cannot be read', 'UNREADABLE_PICTURE');
  }
}
