import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ME_PHOTO_PATH, ME_PROBE_HEADER, PEOPLE_PHOTOS_PATH, PICTURE_LIMITS, type PeoplePhotos, type PhotoSet, type PictureSize } from '@flux/contracts';
import { createPictureUseCases, InvalidInputError, type FileStorage, type PictureRenderer, type Principal } from '@flux/core';
import { personPhotoRows, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';

/** The raw picture types an upload may declare; the bytes decide what it is either way (F-039). */
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'];

/**
 * Profile photos (F-039, #1226): set and remove your own, the photos of the people you can see, and one rendition. A rendition is
 * immutable under its random id, so the browser keeps it for a year and a view asks nothing again (#862); it is only ever an image.
 */
export async function pictureRoutes(app: FastifyInstance, { db, sessions, storage, renderer }:
  { db: Database; sessions: SessionResolver; storage: FileStorage; renderer: PictureRenderer }) {
  useDomainErrors(app);
  const pictures = createPictureUseCases({ run: (action) => db.transaction((tx) => action(personPhotoRows(tx))) }, storage, renderer);
  app.addContentTypeParser(UPLOAD_TYPES, { parseAs: 'buffer', bodyLimit: PICTURE_LIMITS.photoBytes }, (_request, body, done) => done(null, body));
  // The person is known before a byte of the upload is read: nobody without a session makes Flux hold 5 MiB.
  const principals = new WeakMap<FastifyRequest, Principal>();

  app.put<{ Body: unknown }>(ME_PHOTO_PATH, { bodyLimit: PICTURE_LIMITS.photoBytes,
    onRequest: async (request) => { principals.set(request, (await sessions.requirePrincipal(request)).principal); } },
  async (request): Promise<PhotoSet> => {
    if (!Buffer.isBuffer(request.body)) throw new InvalidInputError('Send the picture\'s bytes as image/png, image/jpeg or image/webp', 'UNSUPPORTED_PICTURE');
    return pictures.setPhoto(principals.get(request)!, request.body);
  });

  app.delete(ME_PHOTO_PATH, async (request, reply) => {
    await pictures.removePhoto((await sessions.requirePrincipal(request)).principal);
    return reply.code(204).send();
  });

  app.get(PEOPLE_PHOTOS_PATH, async (request, reply): Promise<PeoplePhotos> => {
    reply.header('Cache-Control', 'private, no-store');
    // The shell reads this beside the person, possibly signed out: with the probe header that is an empty list, not a 401 (#546).
    if (request.headers[ME_PROBE_HEADER] === '1' && !await sessions.resolveSession(request.headers)) return { photos: {} };
    const found = await pictures.photosSeenBy((await sessions.requirePrincipal(request)).principal);
    return found;
  });

  app.get<{ Params: { id: string; size: string } }>('/api/v1/pictures/:id/:size', async (request, reply) => {
    const principal = (await sessions.requirePrincipal(request)).principal;
    const bytes = await pictures.readPicture(principal, request.params.id, Number(request.params.size) as PictureSize);
    return reply.header('Content-Type', 'image/webp').header('Content-Length', bytes.byteLength)
      .header('Cache-Control', 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox").header('Cross-Origin-Resource-Policy', 'same-origin')
      .send(Buffer.from(bytes));
  });
}
