import { basename } from 'node:path';
import type { DocumentPolicies } from '../http/content-security-policy.js';
import { isPdfViewerFile, setPdfViewerHeaders } from '../http/pdf-viewer.js';

/**
 * Cache policy for the built web app (issue #41). Vite's hashed /assets/* never change, so
 * they are immutable. Everything else — the service worker, HTML, manifest and icons — must be
 * revalidated so a deployment is picked up; the service worker in particular is always fetched
 * fresh (browsers also bypass the HTTP cache for it, but proxies may not).
 */
export function setStaticHeaders(reply: { header(name: string, value: string): unknown }, filePath: string) {
  // A precompressed copy (`sw.js.br`, #266) gets the headers of the file it stands for.
  const name = basename(filePath).replace(/\.(?:br|gz)$/, '');
  // The same URL answers Brotli, gzip or plain bytes (#266), so every cache must key on the encoding.
  reply.header('Vary', 'Accept-Encoding');
  if (/[/\\]assets[/\\]/.test(filePath)) {
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  reply.header('Cache-Control', 'no-cache');
  // Content types come from @fastify/send (application/javascript, application/manifest+json).
  if (name === 'sw.js') reply.header('Service-Worker-Allowed', '/');
}

/**
 * The static headers plus the Content-Security-Policy of the pages and the service worker (#979), or the PDF viewer's own headers. The policy is set here, on the
 * response of the file, and not in the hook every response passes (framing.ts), because it names the hashes of that file's inline scripts.
 */
export function staticHeaders(policies: DocumentPolicies, root: string) {
  return (reply: { header(name: string, value: string): unknown }, filePath: string) => {
    setStaticHeaders(reply, filePath);
    // The PDF viewer frame (C-60, #1350) has its own policy and framing, not the app's.
    if (isPdfViewerFile(root, filePath)) { setPdfViewerHeaders(reply, filePath); return; }
    const policy = policies.forFile(filePath);
    if (!policy) return;
    reply.header('Content-Security-Policy', policy.enforced);
    if (policy.reportOnly) reply.header('Content-Security-Policy-Report-Only', policy.reportOnly);
  };
}
