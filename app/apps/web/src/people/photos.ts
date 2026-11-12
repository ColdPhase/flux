import { createContext, useContext } from 'react';
import { imageTypeOf, ME_PHOTO_PATH, ME_PROBE_HEADER, PEOPLE_PHOTOS_PATH, picturePath, PICTURE_LIMITS, PICTURE_SIZES, type PeoplePhotos, type PhotoSet } from '@flux/contracts';
import { request } from '../api/client';

// Profile photos (F-039, #1226). The shell reads, once, the photo id of every person the viewer can see; an avatar with a person's id
// draws their photo from it. A photo's address is immutable (a new photo has a new id), so the browser asks for it once (#862).

/** Read with the shell, so it may be signed out: like the person, it then answers an empty list, not a 401 the console logs (#546). */
export async function readPeoplePhotos(signal?: AbortSignal): Promise<Record<string, string>> {
  return (await request<PeoplePhotos>(PEOPLE_PHOTOS_PATH, { signal, headers: { [ME_PROBE_HEADER]: '1' } })).photos;
}

/** Sends the picture's bytes as they are: the server decides by its bytes what it is, and keeps only its middle square. */
export async function setMyPhoto(file: Blob): Promise<string> {
  return (await request<PhotoSet>(ME_PHOTO_PATH, { method: 'PUT', bytes: new Blob([file], { type: 'application/octet-stream' }) })).photo;
}

export async function removeMyPhoto(): Promise<void> {
  await request(ME_PHOTO_PATH, { method: 'DELETE' });
}

/** What the picker can say before sending: the same rule the server applies, by the first bytes of the file. */
export async function photoProblem(file: Blob): Promise<string | null> {
  if (file.size > PICTURE_LIMITS.photoBytes) return 'A photo is at most 5 MB.';
  const type = imageTypeOf(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  return type && type !== 'image/gif' ? null : 'Choose a PNG, JPEG or WebP picture.';
}

/** The `srcset` of one photo: the browser takes the smallest rendition that is sharp at the screen's density. */
export const photoSources = (photoId: string) => PICTURE_SIZES.map((size) => `${picturePath(photoId, size)} ${size}w`).join(', ');

/** User id → photo id of the people the viewer can see. */
export const PhotosContext = createContext<Record<string, string>>({});

export function usePhotoOf(userId: string | null | undefined): string | null {
  const photos = useContext(PhotosContext);
  return userId ? photos[userId] ?? null : null;
}
