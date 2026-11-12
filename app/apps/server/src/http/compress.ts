import { promisify } from 'node:util';
import { brotliCompress, brotliCompressSync, constants, gzip, gzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AUTH_BASE_PATH } from '@flux/contracts';
import { isRouted } from './routed-path.js';

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Below this size compression saves less than the headers and the CPU cost. */
export const JSON_COMPRESS_MIN_BYTES = 2048;
/**
 * Up to this size an answer is compressed on the request's own thread (#1191): handing it to libuv's pool cost more than compressing it,
 * a few tenths of a millisecond. A larger one goes to the pool, so it never holds the event loop for long.
 */
export const JSON_COMPRESS_INLINE_MAX_BYTES = 128 * 1024;
/**
 * Brotli quality 3 (#1191): on the answers of a pass over every view, a third of quality 5's CPU for answers 5% larger (10.9% of their raw
 * size, against 10.4%). At quality 5 compression was about a fifth of the API's CPU in the concurrent phase of check_performance.sh.
 */
const BROTLI_QUALITY = 3;

/** The encoding to use for this request, preferring Brotli; null when the client accepts neither. */
export function chooseEncoding(acceptEncoding: string | undefined): 'br' | 'gzip' | null {
  const accepted = new Map<string, number>();
  for (const part of (acceptEncoding ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map((param) => /^\s*q=([0-9.]+)\s*$/.exec(param)?.[1]).find((value) => value !== undefined);
    accepted.set(name, q === undefined ? 1 : Number(q));
  }
  const weight = (name: string) => accepted.get(name) ?? accepted.get('*') ?? 0;
  if (weight('br') > 0) return 'br';
  if (weight('gzip') > 0) return 'gzip';
  return null;
}

/**
 * Compresses JSON API answers of 2 KiB or more for clients that accept it (#266 item 9): task,
 * decision and message pages shrink to about a fifth, which matters most on a phone's network.
 * Auth answers are never compressed: some carry tokens, and compressing a secret next to
 * request-controlled text is what BREACH-style attacks measure. Streams and files pass untouched.
 */
export function useJsonCompression(app: FastifyInstance) {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (reply.getHeader('content-encoding')) return payload;
    // By what the router decided, not the raw URL: `/api/%61uth/…` is an auth route, and its answer is never compressed (#1047).
    if (isRouted(request, `${AUTH_BASE_PATH}/`) || !isRouted(request, '/api/')) return payload;
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return payload;
    if (!/^application\/(?:[\w.+-]+\+)?json\b/.test(String(reply.getHeader('content-type') ?? ''))) return payload;
    const bytes = typeof payload === 'string' ? Buffer.from(payload) : payload;
    if (bytes.length < JSON_COMPRESS_MIN_BYTES) return payload;
    const vary = String(reply.getHeader('vary') ?? '');
    if (!/\baccept-encoding\b/i.test(vary)) reply.header('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
    const encoding = chooseEncoding(request.headers['accept-encoding']);
    // HEAD carries the same Vary as GET; its body is never sent, so it is not compressed.
    if (!encoding || request.method === 'HEAD') return payload;
    const inline = bytes.length <= JSON_COMPRESS_INLINE_MAX_BYTES;
    const brotliOptions = { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } };
    const compressed = encoding === 'br'
      ? inline ? brotliCompressSync(bytes, brotliOptions) : await brotli(bytes, brotliOptions)
      : inline ? gzipSync(bytes, { level: 6 }) : await gzipAsync(bytes, { level: 6 });
    reply.header('content-encoding', encoding);
    reply.removeHeader('content-length');
    return compressed;
  });
}
