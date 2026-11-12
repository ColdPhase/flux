/**
 * Pictures (F-039, #1226): a person's profile photo. Only PNG, JPEG and WebP are taken, recognised by their magic bytes; the
 * server keeps the middle square as three WebP renditions without metadata and never keeps the upload.
 *
 * - `PUT ME_PHOTO_PATH` with the raw bytes (`image/png`, `image/jpeg`, `image/webp` or `application/octet-stream`) sets the
 *   signed-in person's photo and answers `PhotoSet`; `DELETE ME_PHOTO_PATH` removes it (204, also when there was none).
 * - `GET PEOPLE_PHOTOS_PATH` answers `PeoplePhotos`: the photos of the people the caller can see, by user id.
 * - `GET picturePath(id, size)` answers one rendition, `image/webp`, cached as immutable: a new photo has a new id. A picture the
 *   caller cannot see (or one that was replaced or removed) is a 404.
 */
export const ME_PHOTO_PATH = '/api/v1/me/photo';
export const PEOPLE_PHOTOS_PATH = '/api/v1/people/photos';

export const PICTURE_SIZES = [64, 128, 256] as const;
export type PictureSize = (typeof PICTURE_SIZES)[number];
export const picturePath = (pictureId: string, size: PictureSize) => `/api/v1/pictures/${encodeURIComponent(pictureId)}/${size}`;

export const PICTURE_LIMITS = {
  /** An uploaded profile photo: 1 byte to 5 MiB. */
  photoBytes: 5 * 1024 * 1024,
  /** The decoded picture: at most 40 megapixels (a decompression bomb is refused before it is decoded). */
  pixels: 40_000_000,
} as const;

export interface PhotoSet {
  /** The new photo's id, the version in `picturePath`. */
  photo: string;
}

export interface PeoplePhotos {
  /** User id → photo id, only for people who have a photo and whom the caller can see. */
  photos: Record<string, string>;
}
