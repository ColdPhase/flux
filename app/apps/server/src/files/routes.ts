import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { FILE_LIMITS, FILE_LIMITS_PATH, VIDEO_MEDIA_TYPES, isVideoName, type FileLimits, type StagedFile } from '@flux/contracts';
import { type FileStorage, ForbiddenError, InvalidInputError, NotFoundError, PayloadTooLargeError, type PictureCanonicalizer } from '@flux/core';
import type { Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { fileUseCases } from './adapters.js';

export async function fileRoutes(app: FastifyInstance, { db, sessions, storage, pictures, videoBytes = FILE_LIMITS.videoBytes, poster }:
  { db: Database; sessions: SessionResolver; storage: FileStorage; pictures?: PictureCanonicalizer; videoBytes?: number; poster?: (bytes: Uint8Array) => Promise<Uint8Array> }) {
  useDomainErrors(app);
  const files = fileUseCases(db, storage, { videoBytes, ...(pictures ? { pictures } : {}), ...(poster ? { poster } : {}) });
  // The most any upload may be (a video); the use case holds each file to its own limit once it knows what the file is (C-61).
  const largest = Math.max(FILE_LIMITS.fileBytes, videoBytes);
  app.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));
  app.get(FILE_LIMITS_PATH, async (request): Promise<FileLimits> => {
    await sessions.requirePrincipal(request);
    return files.limits();
  });
  app.post<{ Params: { projectId: string }; Querystring: { uploadId: string; name: string }; Body: Readable | undefined }>(
    '/api/v1/projects/:projectId/files', { bodyLimit: largest,
      schema: { querystring: { type: 'object', required: ['uploadId', 'name'], additionalProperties: false,
        properties: { uploadId: { type: 'string' }, name: { type: 'string' } } } },
      onRequest: async (request) => {
        if (!/^application\/octet-stream(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
          throw new InvalidInputError('Upload raw application/octet-stream bytes', 'INVALID_FILE_CONTENT_TYPE');
        const size = Number(request.headers['content-length']);
        if (size > largest) {
          // Over anything a video may be: said in the words of what the name says it is (the use case says the rest).
          const name = (request.query as { name?: unknown }).name;
          throw new PayloadTooLargeError(typeof name === 'string' && isVideoName(name) ? `A video is at most ${Math.round(videoBytes / (1024 * 1024) * 10) / 10} MiB` : 'A file is at most 5 MiB', 'FILE_TOO_LARGE');
        }
      },
      onSend: async (request, reply, payload) => {
        if (!request.raw.complete) reply.header('connection', 'close');
        return payload;
      },
      onResponse: async (request) => {
        // A timeout or admission refusal must also release a stalled raw-body iterator/socket.
        // Finish the error response first, then terminate any incomplete request transport.
        if (!request.raw.complete) request.raw.destroy();
      } }, async (request, reply) => {
      const principal = (await sessions.requirePrincipal(request)).principal;
      const size = request.headers['content-length'];
      // Without Content-Length or Transfer-Encoding Fastify parses no body: that is an empty file.
      const staged = await files.stage(principal, request.params.projectId, request.query, request.body ?? Readable.from([]),
        size === undefined ? undefined : Number(size));
      return reply.code(201).send(staged);
    });
  // Every stored file is an attachment, whole or by byte range (C-61: a resumed download), read from disk as a stream. Access is checked
  // on every request.
  // HEAD is its own route, not Fastify's automatic one, which would answer a Content-Length of 0.
  app.route<{ Params: { fileId: string } }>({ method: ['GET', 'HEAD'], url: '/api/v1/files/:fileId', handler: async (request, reply) => {
    const file = await files.open((await sessions.requirePrincipal(request)).principal, request.params.fileId, openRequest(request));
    return sendStored(reply, file, 'application/octet-stream');
  } });
  // A video played by the page's own `<video>` (C-61): the container type its bytes were recognised as, an attachment under `nosniff` and
  // `sandbox` all the same (a navigation to it saves it, never shows it), with Range so it starts at once and seeks.
  app.route<{ Params: { fileId: string } }>({ method: ['GET', 'HEAD'], url: '/api/v1/files/:fileId/video', handler: async (request, reply) => {
    const file = await files.open((await sessions.requirePrincipal(request)).principal, request.params.fileId, { ...openRequest(request), video: true });
    return sendStored(reply, file, VIDEO_MEDIA_TYPES[file.video!]);
  } });
  // The picture the sender's browser drew from a staged video (C-61): raw bytes, decoded and re-encoded by the server.
  app.post<{ Params: { projectId: string; fileId: string }; Body: Readable | undefined }>('/api/v1/projects/:projectId/files/:fileId/poster', {
    bodyLimit: FILE_LIMITS.posterBytes,
    onRequest: async (request) => {
      if (!/^application\/octet-stream(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
        throw new InvalidInputError('Upload raw application/octet-stream bytes', 'INVALID_FILE_CONTENT_TYPE');
      if (Number(request.headers['content-length']) > FILE_LIMITS.posterBytes) throw new PayloadTooLargeError('A poster is at most 512 KiB', 'POSTER_TOO_LARGE');
    },
    onSend: async (request, reply, payload) => { if (!request.raw.complete) reply.header('connection', 'close'); return payload; },
    onResponse: async (request) => { if (!request.raw.complete) request.raw.destroy(); },
  }, async (request, reply): Promise<StagedFile> => {
    const principal = (await sessions.requirePrincipal(request)).principal;
    const size = request.headers['content-length'];
    const staged = await files.stagePoster(principal, request.params.projectId, request.params.fileId, request.body ?? Readable.from([]), size === undefined ? undefined : Number(size));
    return reply.code(201).send(staged);
  });
  // A preview of someone else's HTML page or PDF (C-60, #1252): only inside a frame of a Flux page, sandboxed to an opaque origin
  // by its own policy, with nothing fetched. The frame's `sandbox` attribute repeats the HTML sandbox; access is the download's.
  app.get<{ Params: { fileId: string }; Querystring: { scripts?: '1' } }>('/api/v1/files/:fileId/preview', {
    schema: { querystring: { type: 'object', additionalProperties: false, properties: { scripts: { type: 'string', enum: ['1'] } } } },
  }, async (request, reply) => {
    // A tab, a link from elsewhere or a navigation of the preview itself (an opaque origin is cross-site) never gets a page here:
    // a page with Flux's address in the address bar could pose as Flux.
    if (request.headers['sec-fetch-dest'] !== 'iframe' || request.headers['sec-fetch-site'] !== 'same-origin')
      throw new ForbiddenError('A preview opens only inside Flux', 'PREVIEW_FRAME_ONLY');
    const file = await files.download((await sessions.requirePrincipal(request)).principal, request.params.fileId);
    const kind = previewKind(file.name);
    if (!kind) throw new NotFoundError('Preview', 'FILE_NO_PREVIEW');
    const scripts = kind === 'html' && request.query.scripts === '1';
    const body = kind === 'html' ? inertHead(file.bytes) : Buffer.from(file.bytes);
    return reply.header('Content-Type', kind === 'html' ? 'text/html; charset=utf-8' : 'application/pdf').header('Content-Length', body.byteLength)
      .header('Content-Disposition', `inline; filename="preview"; filename*=UTF-8''${encodedName(file.name)}`)
      .header('Content-Security-Policy', previewPolicy(kind, scripts))
      .header('X-Frame-Options', 'SAMEORIGIN').header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
      .header('Referrer-Policy', 'no-referrer').header('X-DNS-Prefetch-Control', 'off').header('Permissions-Policy', PREVIEW_PERMISSIONS)
      .header('Cross-Origin-Resource-Policy', 'same-origin').send(body);
  });
  let running = false;
  const sweep = async () => {
    if (running) return;
    running = true;
    try { await files.cleanup(); } catch (error) { app.log.warn({ error }, 'Attachment cleanup is pending'); }
    finally { running = false; }
  };
  const timer = setInterval(() => { void sweep(); }, 10 * 60_000);
  timer.unref();
  app.addHook('onClose', async () => { clearInterval(timer); });
}

const encodedName = (name: string) => encodeURIComponent(name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
/**
 * Every `<link>` and `<meta>` of a previewed page becomes an inert, unknown element (`<x-link>`, `<x-meta>`) before it is sent (C-60).
 * WebKit opens a connection for `<link rel="preconnect">` without asking the Content-Security-Policy, and DNS prefetch, prefetch and
 * preload are hints a browser may act on before any policy; a `<meta http-equiv>` could turn DNS prefetch back on. A still page loses
 * nothing it could use: the policy already refuses every stylesheet, icon and font a link names, and the response's own header sets the
 * charset. A tag name ends at a space, `/` or `>`.
 *
 * The rewrite must see the page as the browser decodes it. The response says UTF-8, and only a byte-order mark overrides that (the
 * WHATWG encoding sniff puts the BOM first; a `<meta charset>` is ignored after a header, and is made inert anyway). So:
 * - a UTF-16 BOM (`FF FE`, `FE FF`; a UTF-32 BOM begins with one and decodes the same way): the page is decoded as UTF-16, rewritten
 *   and sent as UTF-8 without a BOM, which is what the header says;
 * - anything else is ASCII-compatible to the browser (UTF-8, with or without its BOM): the bytes are read as Latin-1, so that every
 *   other byte is sent exactly as stored.
 */
const INERT = /<(link|meta)(?=[\t\n\f\r />])/gi;
export function inertHead(bytes: Uint8Array): Buffer {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : null;
  if (utf16) return Buffer.from(new TextDecoder(utf16).decode(bytes).replace(INERT, '<x-$1'), 'utf8');
  return Buffer.from(Buffer.from(bytes).toString('latin1').replace(INERT, '<x-$1'), 'latin1');
}
const previewKind = (name: string): 'html' | 'pdf' | null => /\.html?$/i.test(name) ? 'html' : /\.pdf$/i.test(name) ? 'pdf' : null;

/**
 * The preview's own Content-Security-Policy (C-60). `sandbox` without `allow-same-origin` gives the page an opaque origin (no Flux
 * cookie, storage, API or parent), and without `allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-downloads` and
 * `allow-modals` none of those. `default-src 'none'` with only `data:` images and inline styles: nothing is fetched, so no third
 * party learns the file was read. Run scripts adds `allow-scripts` and inline scripts only; there is still no `connect-src`.
 */
export function previewPolicy(kind: 'html' | 'pdf', scripts: boolean): string {
  const directives = [
    `sandbox${scripts ? ' allow-scripts' : ''}`,
    "default-src 'none'",
    ...(kind === 'html' ? ["img-src data:", "style-src 'unsafe-inline'"] : []),
    ...(scripts ? ["script-src 'unsafe-inline' 'unsafe-eval'"] : []),
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ];
  return directives.join('; ');
}

/** A preview may ask the browser for nothing: no camera or microphone (even when Flux holds them for a call), no location, no screen. */
export const PREVIEW_PERMISSIONS = 'camera=(), microphone=(), display-capture=(), geolocation=(), payment=(), usb=(), serial=(), midi=(), '
  + 'accelerometer=(), gyroscope=(), magnetometer=(), fullscreen=()';

/** What a request asks of a stored file: its byte range, and nothing at all for a HEAD. `If-Range` needs a validator Flux does not send, so it gets the whole file. */
function openRequest(request: FastifyRequest): { range?: string; head: boolean } {
  const range = request.headers.range;
  return { head: request.method === 'HEAD', ...(typeof range === 'string' && !request.headers['if-range'] ? { range } : {}) };
}

/** A stored file as an attachment of `type` under `nosniff` and `sandbox`: all of it (200), a byte range (206) or a refusal of the range (416). */
function sendStored(reply: FastifyReply, file: { name: string; size: number; status: 200 | 206 | 416; start: number; end: number; body: AsyncIterable<Uint8Array> | null }, type: string) {
  reply.header('Content-Type', type).header('Accept-Ranges', 'bytes')
    .header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodedName(file.name)}`)
    .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
    .header('Content-Security-Policy', 'sandbox').header('Cross-Origin-Resource-Policy', 'same-origin');
  if (file.status === 416) return reply.code(416).header('Content-Range', `bytes */${file.size}`).header('Content-Length', 0).send();
  reply.header('Content-Length', file.end - file.start + 1);
  if (file.status === 206) reply.code(206).header('Content-Range', `bytes ${file.start}-${file.end}/${file.size}`);
  return reply.send(file.body ? file.body instanceof Readable ? file.body : Readable.from(file.body) : undefined);
}
