import { plainMessageText } from './message-format.js';

/**
 * Stored files (#154): bytes a person stages privately, then attaches to exactly one message. Contract:
 * docs/development/task-discussions/2026-10-01-contribution-effects-and-files.md ("Real bytes and
 * attachment-only contribution" and its recorded corrections).
 *
 * Staging is `POST projectFilesPath(projectId)?uploadId=<uuid>&name=<display name>` with the raw bytes as
 * `application/octet-stream`. Downloads are `GET filePath(id)`: always an attachment, `nosniff`, private and
 * not stored; current access is checked on every download. A staged, unpublished file is its uploader's only.
 */
export const projectFilesPath = (projectId: string) => `/api/v1/projects/${projectId}/files`;
/**
 * Files in direct messages (#1438 point 10): the same staging, limits, checks, pictures and videos as a space's, in a conversation. A staged
 * file is its sender's alone until it is sent, and a sent one is for the conversation's current people only: every download checks it again.
 */
export const dmFilesPath = (dmId: string) => `/api/v1/dms/${dmId}/files`;
export const filePath = (fileId: string) => `/api/v1/files/${fileId}`;

/**
 * Videos (C-61, #1352): `GET fileVideoPath(id)` plays a video file as its own container type with HTTP Range (206) from disk, as an
 * attachment under `nosniff` and `sandbox`; access is checked on every request. `POST filePosterPath(projectId, id)` with the raw bytes
 * of a picture (at most `FILE_LIMITS.posterBytes`) gives a staged video its poster, which the server decodes and re-encodes.
 * `GET FILE_LIMITS_PATH` says what this instance accepts, as set by its operator.
 */
export const fileVideoPath = (fileId: string) => `/api/v1/files/${fileId}/video`;
export const filePosterPath = (projectId: string, fileId: string) => `/api/v1/projects/${projectId}/files/${fileId}/poster`;
export const dmFilePosterPath = (dmId: string, fileId: string) => `/api/v1/dms/${dmId}/files/${fileId}/poster`;
export const FILE_LIMITS_PATH = '/api/v1/files/limits';

/**
 * A preview of an HTML file in a frame of a Flux page (C-60, #1252): never a tab, never on Flux's origin. The response
 * sandboxes itself (an opaque origin) and fetches nothing; `scripts` turns the page's own inline scripts on for that frame.
 * Other previews read `filePath(id)`: a PDF is drawn by Flux's own viewer frame (#1350), text, Markdown, JSON and CSV/TSV by the web app as text.
 */
export const filePreviewPath = (fileId: string, scripts = false) => `/api/v1/files/${fileId}/preview${scripts ? '?scripts=1' : ''}`;

export const FILE_LIMITS = {
  /** One file: 1 byte to 5 MiB. Empty files are refused. */
  fileBytes: 5 * 1024 * 1024,
  /** One video (C-61): the default of the operator's `FLUX_VIDEO_MAX_MIB`, which can be 1 to `videoMaxMib` MiB. A plain space's video only. */
  videoBytes: 200 * 1024 * 1024,
  videoMaxMib: 1024,
  /** A video has this long to arrive; the rest of the files have `receiveSeconds`. */
  videoReceiveSeconds: 20 * 60,
  /** A video's poster (C-61): at most this many bytes are taken, and the server keeps a WebP of at most `posterEdge` px on a side. */
  posterBytes: 512 * 1024,
  posterEdge: 640,
  /** One message: at most 10 files and 20 MiB together. */
  messageFiles: 10,
  messageBytes: 20 * 1024 * 1024,
  /** Display name: 1–200 characters, no control or path characters, never "." or "..". */
  nameChars: 200,
  /** Live staged bytes per uploader and project: uploads in progress plus ready unpublished files. */
  stagedBytes: 100 * 1024 * 1024,
  /** The bytes of one upload must arrive within this time. */
  receiveSeconds: 30,
  /** An upload that never finished frees its reservation after this. */
  reservationMinutes: 15,
  /** A ready file that was never attached is removed this long after it became ready. */
  unpublishedDays: 7,
} as const;

/**
 * How big a picture may be (#1343, C-59): at most 8,000 pixels on a side and 40 million in all. A stored picture is checked against this
 * when it arrives (an agent's from the web, a person's upload), and the web app checks it again, from the file's own headers, before it asks
 * a browser to draw one inline: a file stored under an earlier rule, or one that was never cleaned, is then a file row, not a picture.
 */
export const PICTURE_BOUNDS = { side: 8_000, pixels: 40_000_000 } as const;

/**
 * What the server read from the bytes at upload (#469, F-026 §6): the pages of a PDF, the data rows of a
 * CSV or TSV (the header line is not one), the playing time of a voice note or recording. Each is absent when
 * the file is another kind or its bytes did not say; a name alone never sets one.
 */
export interface FileDetail {
  pages?: number;
  rows?: number;
  durationMs?: number;
  /** The container the server recognised from a video's bytes (C-61); absent for every other file and in an encrypted space. */
  video?: VideoContainer;
}

/** A file staged by the signed-in person, ready to attach. */
export interface StagedFile extends FileDetail {
  id: string;
  /** The space it was staged in, or (#1438 point 10) the direct message: exactly one of the two is present. */
  projectId?: string;
  dmId?: string;
  /** The client's upload UUID; the same upload again returns this file. */
  uploadId: string;
  name: string;
  size: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256: string;
  readyAt: string;
  /** When it is removed if it is not attached to a message by then. */
  expiresAt: string;
}

/** A file attached to a message: readable name and size. The bytes download from `filePath(id)`. */
export interface MessageFile extends FileDetail {
  id: string;
  name: string;
  size: number;
  /** A video's poster (C-61): the id of its small picture, read through `filePath` like any picture. */
  poster?: string;
}

/** What this instance accepts (`FILE_LIMITS_PATH`): the operator's video cap is the only number that varies. */
export interface FileLimits {
  fileBytes: number;
  videoBytes: number;
  messageFiles: number;
  messageBytes: number;
}

/** The containers a video can be (C-61): what the browser plays natively. Matroska, AVI and the rest are ordinary files. */
export type VideoContainer = 'mp4' | 'webm' | 'mov';
export const VIDEO_MEDIA_TYPES: Record<VideoContainer, string> = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' };
const VIDEO_NAMES: Record<string, VideoContainer> = { mp4: 'mp4', m4v: 'mp4', webm: 'webm', mov: 'mov' };

/** The container a file name proposes (`.mp4`, `.m4v`, `.webm`, `.mov`); only a hint: the bytes decide (`videoContainerOf`). */
export function videoNameContainer(name: string): VideoContainer | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? VIDEO_NAMES[name.slice(dot + 1).toLowerCase()] ?? null : null;
}
export const isVideoName = (name: string) => videoNameContainer(name) !== null;

/** ISO base-media brands that name a picture or a sound, not a video: a HEIC photo, an AVIF, an M4A are not played here. */
const NOT_VIDEO_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'avif', 'avis', 'avio', 'crx ',
  'M4A ', 'M4B ', 'M4P ', 'F4A ', 'F4B ']);
const ascii = (bytes: Uint8Array, at: number, length: number) => String.fromCharCode(...bytes.subarray(at, at + length));

/**
 * The video container these first bytes are, or null (C-61). MP4 and MOV: an ISO base-media `ftyp` box first, 16 to 4,096 bytes long, whose
 * major brand is not a picture's or a sound's (`qt  ` is a MOV, any other an MP4). WebM: an EBML header whose DocType is `webm`
 * (Matroska is not one). A name never sets it, and nothing else (SVG, HTML, a ZIP) passes.
 */
export function videoContainerOf(head: Uint8Array): VideoContainer | null {
  if (head.length >= 12 && ascii(head, 4, 4) === 'ftyp') {
    const size = ((head[0]! << 24) >>> 0) + (head[1]! << 16) + (head[2]! << 8) + head[3]!;
    if (size < 16 || size > 4096) return null;
    const brand = ascii(head, 8, 4);
    return NOT_VIDEO_BRANDS.has(brand) ? null : brand === 'qt  ' ? 'mov' : 'mp4';
  }
  if (head.length >= 8 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return ebmlDocType(head) === 'webm' ? 'webm' : null;
  return null;
}

/** The DocType string of an EBML header at the start of `head` (a size of 1 to 4 bytes, then children), or null. */
function ebmlDocType(head: Uint8Array): string | null {
  const vint = (at: number): { value: number; length: number } | null => {
    const first = head[at];
    if (first === undefined || first === 0) return null;
    const length = Math.clz32(first) - 23;
    if (length > 4 || at + length > head.length) return null; // no EBML header is larger than 4 GiB
    let value = first & (0xff >> length);
    for (let i = 1; i < length; i++) value = value * 256 + head[at + i]!;
    return { value, length };
  };
  const size = vint(4);
  if (!size) return null;
  let at = 4 + size.length;
  const end = Math.min(head.length, at + size.value);
  while (at < end) {
    const id = vint(at); // an element id keeps its marker bits, which is all the comparison below needs
    if (!id) return null;
    const idValue = head.subarray(at, at + id.length).reduce((sum, byte) => sum * 256 + byte, 0);
    const length = vint(at + id.length);
    if (!length) return null;
    const start = at + id.length + length.length;
    if (idValue === 0x4282) return start + length.value <= head.length ? ascii(head, start, length.value) : null;
    at = start + length.value;
  }
  return null;
}

const attachedFiles = (count: number) => (count === 1 ? '1 attached file' : count > 1 ? `${count} attached files` : '');

/** A system preview: the message's words without its formatting marks (#1247). The stored authored message body remains unchanged. */
export function messagePreview(body: string, count = 0): string {
  return plainMessageText(body) || attachedFiles(count);
}

/** A conversation's opening words as they were typed (its first message, or what it attached): the text drawn again as a message, or kept on a map. */
export function messageOpening(body: string, count = 0): string {
  return body || attachedFiles(count);
}

/** Images a map thought may show (#252): checked by their bytes' signature, never by name or a declared type. SVG is never one. */
export type ThoughtImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export const THOUGHT_IMAGE_TYPES: readonly ThoughtImageType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The image type these bytes start with, or null for anything else (including SVG, which can carry script). */
export function imageTypeOf(bytes: Uint8Array): ThoughtImageType | null {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (bytes.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes.length >= 3 && starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (bytes.length >= 6 && (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  if (bytes.length >= 12 && starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}

const ascii4 = (b: Uint8Array, at: number) => String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);
/** A byte that must be there: reading past the end stops the walk (`pictureBounds` keeps what it had read). */
class Short extends Error {}
const at8 = (b: Uint8Array, at: number) => b[at] ?? (() => { throw new Short(); })();
const be16 = (b: Uint8Array, at: number) => (at8(b, at) << 8) | at8(b, at + 1);
const be32 = (b: Uint8Array, at: number) => at8(b, at) * 0x1000000 + ((at8(b, at + 1) << 16) | (at8(b, at + 2) << 8) | at8(b, at + 3));
const le16 = (b: Uint8Array, at: number) => at8(b, at) | (at8(b, at + 1) << 8);
const le24 = (b: Uint8Array, at: number) => at8(b, at) | (at8(b, at + 1) << 8) | (at8(b, at + 2) << 16);
const le32 = (b: Uint8Array, at: number) => le24(b, at) + at8(b, at + 3) * 0x1000000;

/**
 * The largest width and the largest height that any header of a picture's file claims (#1343): a PNG's IHDR and each APNG frame, every
 * JPEG start-of-frame, a GIF's screen and each frame where it ends (its offset and size), a WebP's canvas and every image chunk and animation frame in it. Decoders disagree on
 * which of several sizes they draw (the first image chunk, the last, the canvas), so a file is judged by the largest, and a browser is never
 * asked to allocate more than this says. Reads headers only, in one pass that advances at least a byte a step, never throws: null for
 * bytes that are not one of the four picture types or that give no size.
 */
export function pictureBounds(b: Uint8Array): { width: number; height: number } | null {
  const type = imageTypeOf(b);
  if (!type) return null;
  let width = 0; let height = 0;
  const see = (w: number, h: number) => { if (w > width) width = w; if (h > height) height = h; };
  try {
    if (type === 'image/png') {
      let at = 8; let first = true;
      while (at + 8 <= b.length) {
        const length = be32(b, at); const kind = ascii4(b, at + 4);
        if (first) { if (kind !== 'IHDR' || length < 8) return null; see(be32(b, at + 8), be32(b, at + 12)); first = false; }
        else if (kind === 'fcTL' && length >= 26) see(be32(b, at + 12) + be32(b, at + 20), be32(b, at + 16) + be32(b, at + 24));
        if (kind === 'IEND') break;
        at += 12 + length;
      }
    } else if (type === 'image/jpeg') {
      let at = 2;
      while (at < b.length) {
        if (b[at] !== 0xff) { at++; continue; } // entropy-coded data
        while (b[at] === 0xff) at++;
        const marker = b[at++];
        if (marker === undefined || marker === 0xd9) break;
        if (marker === 0 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
        const length = be16(b, at);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && length >= 8) see(be16(b, at + 5), be16(b, at + 3));
        at += Math.max(length, 2);
      }
    } else if (type === 'image/gif') {
      see(le16(b, 6), le16(b, 8));
      const skip = (from: number) => { let p = from; while (true) { const size = at8(b, p); p += 1 + size; if (size === 0) return p; } };
      const table = (packed: number) => (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      let at = 13 + table(at8(b, 10));
      while (at < b.length) {
        const kind = b[at];
        if (kind === 0x2c) { see(le16(b, at + 1) + le16(b, at + 5), le16(b, at + 3) + le16(b, at + 7)); at = skip(at + 11 + table(at8(b, at + 9))); }
        else if (kind === 0x21) at = skip(at + 2);
        else break;
      }
    } else {
      const walk = (from: number, to: number, nested: boolean) => {
        let at = from;
        while (at + 8 <= to) {
          const kind = ascii4(b, at); const size = le32(b, at + 4); const data = at + 8;
          if (kind === 'VP8X' && size >= 10) see(le24(b, data + 4) + 1, le24(b, data + 7) + 1);
          else if (kind === 'VP8 ' && size >= 10) see(le16(b, data + 6) & 0x3fff, le16(b, data + 8) & 0x3fff);
          else if (kind === 'VP8L' && size >= 5) { const bits = le32(b, data + 1); see((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1); }
          else if (kind === 'ANMF' && size >= 16 && !nested) {
            see(le24(b, data) * 2 + le24(b, data + 6) + 1, le24(b, data + 3) * 2 + le24(b, data + 9) + 1);
            walk(data + 16, Math.min(data + size, to), true);
          }
          at = data + size + (size & 1);
        }
      };
      walk(12, Math.min(le32(b, 4) + 8, b.length), false);
    }
  } catch (error) { if (!(error instanceof Short)) return null; }
  return width && height ? { width, height } : null;
}

/** The image type these bytes are, only when it is within `PICTURE_BOUNDS`: what the web app may ask a browser to draw inline (#1343). */
export function drawablePictureType(bytes: Uint8Array): ThoughtImageType | null {
  const type = imageTypeOf(bytes);
  const size = type ? pictureBounds(bytes) : null;
  if (!type || !size || size.width > PICTURE_BOUNDS.side || size.height > PICTURE_BOUNDS.side || size.width * size.height > PICTURE_BOUNDS.pixels) return null;
  return type;
}
