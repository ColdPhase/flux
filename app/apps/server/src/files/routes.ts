import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { FILE_LIMITS } from '@flux/contracts';
import { type Database, type FileStorage, InvalidInputError, PayloadTooLargeError } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';
import { fileUseCases } from './adapters.js';

export async function fileRoutes(app: FastifyInstance, { db, sessions, storage }:
  { db: Database; sessions: SessionResolver; storage: FileStorage }) {
  useDomainErrors(app);
  const files = fileUseCases(db, storage);
  app.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));
  app.post<{ Params: { projectId: string }; Querystring: { uploadId: string; name: string }; Body: Readable | undefined }>(
    '/api/v1/projects/:projectId/files', { bodyLimit: FILE_LIMITS.fileBytes,
      schema: { querystring: { type: 'object', required: ['uploadId', 'name'], additionalProperties: false,
        properties: { uploadId: { type: 'string' }, name: { type: 'string' } } } },
      onRequest: async (request) => {
        if (!/^application\/octet-stream(?:\s*;|$)/i.test(request.headers['content-type'] ?? ''))
          throw new InvalidInputError('Upload raw application/octet-stream bytes', 'INVALID_FILE_CONTENT_TYPE');
        const size = Number(request.headers['content-length']);
        if (size > FILE_LIMITS.fileBytes) throw new PayloadTooLargeError('A file is at most 5 MiB', 'FILE_TOO_LARGE');
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
  app.get<{ Params: { fileId: string } }>('/api/v1/files/:fileId', async (request, reply) => {
    const file = await files.download((await sessions.requirePrincipal(request)).principal, request.params.fileId);
    const encoded = encodeURIComponent(file.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    return reply.header('Content-Type', 'application/octet-stream').header('Content-Length', file.size)
      .header('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encoded}`)
      .header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'private, no-store')
      .header('Content-Security-Policy', 'sandbox').send(Buffer.from(file.bytes));
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
