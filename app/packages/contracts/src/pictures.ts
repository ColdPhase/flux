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
  /** An uploaded space icon picture (F-040): 1 byte to 2 MiB. */
  spaceIconBytes: 2 * 1024 * 1024,
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

/**
 * A space's icon (F-040, #1227): an emoji or a picture in its tile; null keeps its letter.
 *
 * - `PUT spaceIconPath(projectId)` with JSON `{ emoji }` (one RGI emoji) or with a picture's raw bytes (as `ME_PHOTO_PATH`, at most
 *   `PICTURE_LIMITS.spaceIconBytes`) sets it and answers the space's `SpaceIcon`; `DELETE` goes back to the letter (204). Both need the
 *   right to rename the space and record `project.updated.v1`. An encrypted space keeps its letter (409 `WORKSPACE_ENCRYPTED_UNSUPPORTED`).
 * - The picture is served by `picturePath(picture, size)` to the people who can open the space.
 */
export type SpaceIcon = { emoji: string; picture?: never } | { picture: string; emoji?: never };
export const spaceIconPath = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/icon`;
export interface SetSpaceEmoji { emoji: string }

/** One RGI emoji (a single emoji as Unicode recommends it, with its modifiers and joiners), nothing else. */
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
export const isSpaceEmoji = (value: unknown): value is string => typeof value === 'string' && value.length <= 32 && RGI_EMOJI.test(value);
