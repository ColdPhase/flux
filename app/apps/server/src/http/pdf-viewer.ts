import { relative, sep } from 'node:path';

/**
 * The PDF viewer frame (C-60, #1350): a page of its own, built into `<web root>/pdf-viewer/`, that Flux's file preview frames to draw someone
 * else's PDF. It is not an app page, so it gets neither the app's policy nor its hashes. The page runs PDF.js and nothing else, in a frame
 * with the `sandbox` attribute, so its origin is opaque: no cookie, storage, API or parent access, and no navigation or window of its own.
 * Its policy repeats that and gives it only what it needs: its own script and style (the worker is a blob the script makes), drawing into
 * canvases and blobs, and nothing fetched from anywhere (no `connect-src`, no frames, no forms).
 *
 * An opaque-origin page loads its script and stylesheet as another origin would, so those two files answer `Access-Control-Allow-Origin: *`
 * and `Cross-Origin-Resource-Policy: cross-origin`; they are the public code of the app and carry no data. Only a Flux page may frame
 * the page (`SAMEORIGIN`, `frame-ancestors 'self'`), and the page itself does nothing unless it is framed and its parent sends the file.
 */
export const PDF_VIEWER_DIRECTORY = 'pdf-viewer';

export const PDF_VIEWER_POLICY = [
  'sandbox allow-scripts',
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  'worker-src blob:',
  'img-src blob: data:',
  'font-src blob: data:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** Whether a built file is one of the PDF viewer's (a precompressed copy included), by its place under the web root. */
export function isPdfViewerFile(root: string, filePath: string): boolean {
  return relative(root, filePath).split(sep)[0] === PDF_VIEWER_DIRECTORY;
}

export function setPdfViewerHeaders(reply: { header(name: string, value: string): unknown }, filePath: string) {
  if (/(?:^|[/\\])index\.html(?:\.(?:br|gz))?$/.test(filePath)) {
    reply.header('Content-Security-Policy', PDF_VIEWER_POLICY);
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    return;
  }
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
}
