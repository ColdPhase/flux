import { useSyncExternalStore } from 'react';
import { FILE_LIMITS, FILE_LIMITS_PATH, dmFilePosterPath, filePath, filePosterPath, type FileLimits, type StagedFile } from '@flux/contracts';
import { request, send } from './client';

/**
 * A stored file's bytes, as the signed-in person may read them now; null when the server refuses them.
 * Stored files always download as attachments, so the web reads their bytes with the session and shows them
 * from a local object URL. A request that gets no answer throws, like every other call (`NetworkError`).
 */
export async function readFileBytes(fileId: string, init: { signal?: AbortSignal; cache?: RequestCache } = {}): Promise<Uint8Array | null> {
  const response = await send(filePath(fileId), init);
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
}

/**
 * What this instance accepts (C-61): the operator's video cap is the one number that varies. Until the answer arrives the page assumes
 * the default, and the server holds each file to its real limit whatever the page believed.
 */
let limits: FileLimits = { fileBytes: FILE_LIMITS.fileBytes, videoBytes: FILE_LIMITS.videoBytes, messageFiles: FILE_LIMITS.messageFiles, messageBytes: FILE_LIMITS.messageBytes };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
export const fileLimits = () => limits;
export function loadFileLimits(): Promise<void> {
  loading ??= request<FileLimits>(FILE_LIMITS_PATH).then((answer) => {
    if (answer.videoBytes !== limits.videoBytes) { limits = answer; listeners.forEach((listener) => listener()); }
  }).catch(() => { loading = null; });
  return loading;
}
/** The limits, redrawn when the server's answer differs from the default the page started with. */
export function useFileLimits(): FileLimits {
  return useSyncExternalStore((listener) => { listeners.add(listener); void loadFileLimits(); return () => { listeners.delete(listener); }; }, fileLimits);
}

/** Gives a staged video its poster, the picture the browser drew from its first frame (C-61). The server decodes and re-encodes it; nothing here is trusted. */
export const uploadPoster = (place: string | { dmId: string }, fileId: string, picture: Blob) =>
  request<StagedFile>(typeof place === 'string' ? filePosterPath(place, fileId) : dmFilePosterPath(place.dmId, fileId), { method: 'POST', bytes: new Blob([picture], { type: 'application/octet-stream' }) });
