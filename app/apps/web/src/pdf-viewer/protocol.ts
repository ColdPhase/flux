// What a Flux page and its PDF viewer frame say to each other (C-60, #1350). The viewer is a page of its own that runs in a sandboxed,
// opaque-origin frame; the only channel between it and Flux is these messages, each read by the other side as untrusted data.

/** Where the built viewer page is served from (`http/pdf-viewer.ts` gives it its own policy). */
export const PDF_VIEWER_URL = '/pdf-viewer/index.html';

/** Tags every message, so another frame's message is never mistaken for one of ours. */
export const PDF_FRAME = 'flux-pdf-viewer';

/** Flux gives the viewer the file's bytes (read through the download route's access check) once the frame says it is ready. */
export interface OpenMessage { frame: typeof PDF_FRAME; type: 'open'; bytes: ArrayBuffer }
export type ViewerMessage =
  | { frame: typeof PDF_FRAME; type: 'ready' }
  /** The first page is drawn. */
  | { frame: typeof PDF_FRAME; type: 'drawn' }
  /** The person pressed a link whose address is http or https. Nothing opens until they press Open in Flux's own page. */
  | { frame: typeof PDF_FRAME; type: 'link'; url: string }
  | { frame: typeof PDF_FRAME; type: 'failed'; reason: 'password' | 'damaged' };

const LONGEST_ADDRESS = 4096;

/**
 * The address of a link, or null when it must not be offered: only `http:` and `https:` are ever opened, and only as a new tab after the
 * person has seen the address. `javascript:`, `data:`, `file:`, `blob:`, `ftp:`, `mailto:` and every other scheme are dropped, as is an
 * address with a user name or password (`https://flux.example@evil.example/` reads as Flux) or one that is not an address at all.
 */
export function externalLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > LONGEST_ADDRESS) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** A message from the viewer, or null when it is not one of ours or is malformed. */
export function readViewerMessage(data: unknown): ViewerMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const message = data as Record<string, unknown>;
  if (message.frame !== PDF_FRAME) return null;
  if (message.type === 'ready' || message.type === 'drawn') return { frame: PDF_FRAME, type: message.type };
  if (message.type === 'link') {
    const url = externalLink(message.url);
    return url ? { frame: PDF_FRAME, type: 'link', url } : null;
  }
  if (message.type === 'failed') return { frame: PDF_FRAME, type: 'failed', reason: message.reason === 'password' ? 'password' : 'damaged' };
  return null;
}
