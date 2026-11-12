import { randomUUID } from 'node:crypto';
import { PICTURE_LIMITS, PICTURE_SIZES, type PeoplePhotos, type PhotoSet, type PictureSize } from '@flux/contracts';
import { ForbiddenError, InvalidInputError, NotFoundError, PayloadTooLargeError } from '../access/errors.js';
import { isUuid } from '../access/policy.js';
import type { Principal } from '../principal.js';
import type { FileStorage } from '../files/ports.js';
import type { PictureRenderer, PictureUnitOfWork, Renditions } from './ports.js';

/** A rendition is a few kilobytes; this only bounds a broken renderer. */
const RENDITION_BYTES = 1024 * 1024;
const RECEIVE_MS = 30_000;

function person(principal: Principal): string {
  // Only a signed-in person has a photo: an agent keeps Kreska and is never mistaken for a person (F-039).
  if (principal.kind !== 'human') throw new ForbiddenError('Only a person can have a photo', 'PHOTO_PEOPLE_ONLY');
  return principal.id;
}

/**
 * Profile photos (F-039, #1226). The upload is rendered in memory and never stored: only the renditions reach the files volume, each
 * made durable before the row that names them is written, and removed again when that write fails.
 */
export function createPictureUseCases(unit: PictureUnitOfWork, storage: FileStorage, renderer: PictureRenderer) {
  async function removeObjects(ids: readonly string[]) {
    for (const id of ids) await storage.remove(id).catch(() => undefined);
  }
  async function store(renditions: Renditions): Promise<Record<PictureSize, string>> {
    const objects: Partial<Record<PictureSize, string>> = {};
    const written: string[] = [];
    try {
      for (const size of PICTURE_SIZES) {
        const id = randomUUID();
        const received = await storage.receive((async function* () { yield renditions[size]; })(),
          { maxBytes: RENDITION_BYTES, deadline: Date.now() + RECEIVE_MS });
        try { await received.commit(id); } catch (error) { await received.discard(); throw error; }
        written.push(id);
        objects[size] = id;
      }
    } catch (error) {
      await removeObjects(written);
      throw error;
    }
    return objects as Record<PictureSize, string>;
  }
  return {
    async setPhoto(principal: Principal, bytes: Uint8Array): Promise<PhotoSet> {
      const userId = person(principal);
      if (bytes.byteLength > PICTURE_LIMITS.photoBytes) throw new PayloadTooLargeError('A photo is at most 5 MiB', 'PHOTO_TOO_LARGE');
      if (bytes.byteLength < 1) throw new InvalidInputError('Send the picture\'s bytes', 'UNSUPPORTED_PICTURE');
      const objects = await store(await renderer.render(bytes));
      const id = randomUUID();
      try {
        await unit.run((photos) => photos.replace({ id, userId, objects }));
      } catch (error) {
        await removeObjects(Object.values(objects));
        throw error;
      }
      return { photo: id };
    },
    async removePhoto(principal: Principal): Promise<void> {
      const userId = person(principal);
      await unit.run((photos) => photos.remove(userId));
    },
    async photosSeenBy(principal: Principal): Promise<PeoplePhotos> {
      if (principal.kind !== 'human') return { photos: {} };
      const rows = await unit.run((photos) => photos.seenBy(principal.id));
      return { photos: Object.fromEntries(rows.map((row) => [row.userId, row.id])) };
    },
    /** One rendition's bytes, when the caller can see the person now; a replaced or removed photo is gone (404). */
    async readPicture(principal: Principal, pictureId: string, size: PictureSize): Promise<Uint8Array> {
      if (principal.kind !== 'human' || !isUuid(pictureId) || !PICTURE_SIZES.includes(size)) throw new NotFoundError('Picture', 'PICTURE_NOT_FOUND');
      const row = await unit.run((photos) => photos.findSeenBy(principal.id, pictureId));
      const bytes = row ? await storage.read(row.objects[size]) : null;
      if (!bytes) throw new NotFoundError('Picture', 'PICTURE_NOT_FOUND');
      return bytes;
    },
  };
}
export type PictureUseCases = ReturnType<typeof createPictureUseCases>;
