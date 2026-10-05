import { filePath, projectFilesPath, type StagedFile } from '@flux/contracts';
import { ApiError, NetworkError } from './client';

// Stored files (#154, #252). Staging sends raw bytes; a staged file stays its uploader's own until something
// publishes it. Downloads are always attachments, so an image is shown from its bytes, never by URL.

/** Stages `bytes` privately in the project. The same `uploadId` again returns the same file. */
export async function stageFile(projectId: string, bytes: Blob, name: string, uploadId: string): Promise<StagedFile> {
  let response: Response;
  try {
    response = await fetch(`${projectFilesPath(projectId)}?${new URLSearchParams({ uploadId, name })}`, {
      method: 'POST', credentials: 'same-origin', body: bytes,
      headers: { accept: 'application/json', 'content-type': 'application/octet-stream' },
    });
  } catch {
    throw new NetworkError();
  }
  let data: unknown = null;
  try { data = await response.json(); } catch { data = null; }
  if (!response.ok) {
    const record = (data && typeof data === 'object' ? data : {}) as { code?: unknown; message?: unknown };
    throw new ApiError(response.status, typeof record.code === 'string' ? record.code : null,
      typeof record.message === 'string' ? record.message : response.statusText, data);
  }
  return data as StagedFile;
}

/** A stored file's bytes, as the signed-in person may read them now; null when unavailable. */
export async function fileBytes(fileId: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(filePath(fileId), { credentials: 'same-origin' });
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
