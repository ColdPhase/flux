import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ME_PHOTO_PATH, ME_PROBE_HEADER, PEOPLE_PHOTOS_PATH, PICTURE_LIMITS, type PeoplePhotos, type PhotoSet, type PictureSize, type SpaceIcon } from '@flux/contracts';
import { createPictureUseCases, createSpaceIconUseCases, InvalidInputError, NotFoundError, ServiceUnavailableError, type FileStorage, type PictureRenderer, type Principal } from '@flux/core';
import { accessPorts, personPhotoRows, spaceIconRows, type Database, type DbExecutor } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';
import { useDomainErrors } from '../http/commands.js';

/** `spaceIconPath` as a route. */
const SPACE_ICON_ROUTE = '/api/v1/projects/:projectId/icon';
/** The raw picture types an upload may declare; the bytes decide what it is either way (F-039). */
const UPLOAD_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'];

/**
 * Profile photos (F-039, #1226): set and remove your own, the photos of the people you can see, and one rendition. Space icons
 * (F-040, #1227): an emoji or a picture for a space, by the people who can rename it. A rendition is
 * immutable under its random id, so the browser keeps it for a year and a view asks nothing again (#862); it is only ever an image.
 */
export async function pictureRoutes(app: FastifyInstance, { db, sessions, storage, renderer }:
  { db: Database; sessions: SessionResolver; storage: FileStorage; renderer: PictureRenderer }) {
  useDomainErrors(app);
  const pictures = createPictureUseCases({ run: (action) => db.transaction((tx) => action(personPhotoRows(tx))) }, storage, renderer);
  const spaceIcons = createSpaceIconUseCases(db, { ...accessPorts, icons: (tx) => spaceIconRows(tx as DbExecutor) }, storage, renderer);
  app.addContentTypeParser(UPLOAD_TYPES, { parseAs: 'buffer', bodyLimit: PICTURE_LIMITS.photoBytes }, (_request, body, done) => done(null, body));
  // A busy renderer refuses the upload before its body is read, so a burst does not make Flux hold 5 MiB per waiting request.
  const refuseWhenBusy = () => { if (renderer.full()) throw new ServiceUnavailableError('Flux is busy with other pictures. Try again in a moment.', 'PICTURES_BUSY'); };
  // The person is known before a byte of the upload is read: nobody without a session makes Flux hold 5 MiB.
  const principals = new WeakMap<FastifyRequest, Principal>();

  app.put<{ Body: unknown }>(ME_PHOTO_PATH, { bodyLimit: PICTURE_LIMITS.photoBytes,
    onRequest: async (request) => { principals.set(request, (await sessions.requirePrincipal(request)).principal); refuseWhenBusy(); } },
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

  // A space's icon: JSON `{ emoji }`, or a picture's raw bytes (F-040).
  app.put<{ Params: { projectId: string }; Body: unknown }>(SPACE_ICON_ROUTE, { bodyLimit: PICTURE_LIMITS.spaceIconBytes,
    onRequest: async (request) => { principals.set(request, (await sessions.requirePrincipal(request)).principal); refuseWhenBusy(); } },
  async (request): Promise<SpaceIcon> => {
    const principal = principals.get(request)!;
    if (Buffer.isBuffer(request.body)) return spaceIcons.setPicture(principal, request.params.projectId, request.body);
    const emoji = (request.body as { emoji?: unknown } | null)?.emoji;
    if (emoji === undefined) throw new InvalidInputError('Send { emoji } or a picture\'s bytes', 'INVALID_SPACE_EMOJI');
    return spaceIcons.setEmoji(principal, request.params.projectId, emoji);
  });

  app.delete<{ Params: { projectId: string } }>(SPACE_ICON_ROUTE, async (request, reply) => {
    await spaceIcons.removeIcon((await sessions.requirePrincipal(request)).principal, request.params.projectId);
    return reply.code(204).send();
  });

  app.get<{ Params: { pictureId: string; size: string } }>('/api/v1/pictures/:pictureId/:size', async (request, reply) => {
    const principal = (await sessions.requirePrincipal(request)).principal;
    const size = Number(request.params.size) as PictureSize;
    // A person's photo or a space's picture: each is served only to whoever may see it now; anything else is the same 404.
    const bytes = await pictures.readPicture(principal, request.params.pictureId, size) ?? await spaceIcons.readPicture(principal, request.params.pictureId, size);
    if (!bytes) throw new NotFoundError('Picture', 'PICTURE_NOT_FOUND');
    return reply.header('Content-Type', 'image/webp').header('Content-Length', bytes.byteLength)
      .header('Cache-Control', 'private, max-age=31536000, immutable').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox").header('Cross-Origin-Resource-Policy', 'same-origin')
      .send(Buffer.from(bytes));
  });
}
