import type { IncomingHttpHeaders } from 'node:http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function single(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function originOf(value: string) {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * CSRF/origin policy for state-changing requests. The only accepted browser origin is
 * the configured public origin; Host and X-Forwarded-* headers are never consulted.
 * Non-browser clients without cookies (bearer tokens, CLI) send no Origin and pass.
 * Returns the violation reason, or null when the request may proceed.
 */
export function originViolation(method: string, headers: IncomingHttpHeaders, publicOrigin: string): string | null {
  if (SAFE_METHODS.has(method.toUpperCase())) return null;
  const origin = single(headers.origin);
  if (origin !== undefined) return origin === publicOrigin ? null : 'foreign_origin';
  const site = single(headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return 'cross_site_request';
  const referer = single(headers.referer);
  if (referer !== undefined) return originOf(referer) === publicOrigin ? null : 'foreign_referer';
  if (headers.cookie) return 'missing_origin';
  return null;
}
