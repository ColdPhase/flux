import type { PictureSize } from '@flux/contracts';

/** The three WebP renditions of one picture (F-039, #1226), square, without metadata. */
export type Renditions = Record<PictureSize, Uint8Array>;

/**
 * Turns uploaded bytes into renditions. Only PNG, JPEG and WebP, by their bytes; the implementation refuses anything else, a damaged
 * file and a picture over `PICTURE_LIMITS.pixels` with `InvalidInputError`, and answers `ServiceUnavailableError` while it is busy.
 */
export interface PictureRenderer {
  render(bytes: Uint8Array): Promise<Renditions>;
  /** True while a new picture would be refused as busy: the upload is then refused before its body is read. */
  full(): boolean;
}

export interface PersonPhotoRow {
  /** The photo's version: the random id in its immutable URL. */
  id: string;
  userId: string;
  /** The files-volume object of each rendition. */
  objects: Record<PictureSize, string>;
}

/** Rows only; every method runs in the caller's transaction. A removed row's objects are queued for deletion with it. */
export interface PersonPhotoRepository {
  /** Serializes on the person, removes their current photo and stores this one. */
  replace(row: PersonPhotoRow): Promise<void>;
  remove(userId: string): Promise<boolean>;
  /** The photos of the people the viewer can see (F-039). */
  seenBy(viewerId: string): Promise<Array<{ userId: string; id: string }>>;
  /** One photo, when the viewer can see its person. */
  findSeenBy(viewerId: string, photoId: string): Promise<PersonPhotoRow | null>;
}

export interface PictureUnitOfWork {
  run<T>(action: (photos: PersonPhotoRepository) => Promise<T>): Promise<T>;
}
