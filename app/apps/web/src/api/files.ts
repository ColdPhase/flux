import { filePath } from '@flux/contracts';
import { send } from './client';

/**
 * A stored file's bytes, as the signed-in person may read them now; null when the server refuses them.
 * Stored files always download as attachments, so the web reads their bytes with the session and shows them
 * from a local object URL. A request that gets no answer throws, like every other call (`NetworkError`).
 */
export async function readFileBytes(fileId: string, init: { signal?: AbortSignal; cache?: RequestCache } = {}): Promise<Uint8Array | null> {
  const response = await send(filePath(fileId), init);
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
}
