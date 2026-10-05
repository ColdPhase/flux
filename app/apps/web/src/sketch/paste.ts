import { FILE_LIMITS, SKETCH_LIMITS, THOUGHT_IMAGE_TYPES, type ThoughtImageType } from '@flux/contracts';

// Paste on the map (#252, docs/design/thought-drafts.md "Paste on the map"): what the clipboard becomes as a private
// draft. Pure, so the rules can be tested without a browser.

/** A clipboard text this long is not a list of thoughts; it is refused before anything is drafted or stored. */
export const PASTE_TEXT_CHARS = 100_000;

export type PastedText =
  | { kind: 'empty' }
  | { kind: 'one'; text: string }
  | { kind: 'lines'; lines: string[] }
  | { kind: 'too-many'; count: number }
  | { kind: 'too-long' };

/** Clipboard text as draft thoughts: trimmed, empty lines dropped; one line is one ordinary draft. */
export function pastedText(text: string): PastedText {
  if (text.length > PASTE_TEXT_CHARS) return { kind: 'too-long' };
  const lines = text.split(/\r\n|\r|\n|\u2028|\u2029/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return { kind: 'empty' };
  if (lines.length === 1) return { kind: 'one', text: lines[0]! };
  if (lines.length > SKETCH_LIMITS.pasteLines) return { kind: 'too-many', count: lines.length };
  return { kind: 'lines', lines };
}

/** The `http:`/`https:` link a whole text is, or null: such a thought shows as a link. Other schemes stay text. */
export function linkOf(text: string): URL | null {
  const value = text.trim();
  if (!/^https?:\/\/\S+$/i.test(value)) return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** The first file on the clipboard, if any (an image wins over text that comes with it). */
export function clipboardFile(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return data.files?.[0] ?? null;
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Why this file cannot become a map image, before anything is uploaded; null when it may. */
export function imageRefusal(file: { type: string; size: number }): string | null {
  if (!THOUGHT_IMAGE_TYPES.includes(file.type as ThoughtImageType)) return 'Only PNG, JPEG, GIF or WebP images can be pasted on a map.';
  if (file.size === 0) return 'That image is empty, so nothing was pasted.';
  if (file.size > FILE_LIMITS.fileBytes) return `That image is ${megabytes(file.size)}; an image on a map is at most 5 MB.`;
  return null;
}

const EXTENSIONS: Record<ThoughtImageType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const two = (value: number) => String(value).padStart(2, '0');

/** A readable stored name: clipboard images are usually all called "image.png". */
export function pastedImageName(type: ThoughtImageType, at = new Date()) {
  return `Pasted image ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.${EXTENSIONS[type]}`;
}

/** The default caption of a pasted image; the person can change it before saving. */
export const IMAGE_CAPTION = 'Pasted image';
/** New image thoughts start larger than text ones, so the image is visible at once. */
export const IMAGE_THOUGHT_SIZE = { width: 240, height: 200 } as const;
