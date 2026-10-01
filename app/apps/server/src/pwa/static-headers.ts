import { basename } from 'node:path';

/**
 * Cache policy for the built web app (issue #41). Vite's hashed /assets/* never change, so
 * they are immutable. Everything else — the service worker, HTML, manifest and icons — must be
 * revalidated so a deployment is picked up; the service worker in particular is always fetched
 * fresh (browsers also bypass the HTTP cache for it, but proxies may not).
 */
export function setStaticHeaders(res: { setHeader(name: string, value: string): unknown }, filePath: string) {
  const name = basename(filePath);
  if (/[/\\]assets[/\\]/.test(filePath)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  res.setHeader('Cache-Control', 'no-cache');
  // Content types come from @fastify/send (application/javascript, application/manifest+json).
  if (name === 'sw.js') res.setHeader('Service-Worker-Allowed', '/');
}
