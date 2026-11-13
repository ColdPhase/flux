import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { FILE_LIMITS } from '@flux/contracts';

/**
 * The bytes of a stored file of a plain space, read-only, by the API's layout (`attachments/objects/<2>/<id>`, apps/server/src/files/storage.ts), without
 * following a symlink. A sealed object is never asked for: the claim leaves encrypted spaces' files alone (C-63).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const missing = (error: unknown) => ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

export type ReadStoredFile = (id: string) => Promise<Buffer | null>;

export function readFromDisk(filesDir: string): ReadStoredFile {
  const objects = join(filesDir, 'attachments', 'objects');
  return async (id) => {
    if (!UUID.test(id)) throw new Error('Invalid internal attachment object id');
    try {
      for (const path of [join(filesDir, 'attachments'), objects, join(objects, id.slice(0, 2))]) {
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe attachment directory');
      }
      const file = await open(join(objects, id.slice(0, 2), id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > FILE_LIMITS.fileBytes) return null;
        const bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) return null;
          offset += read.bytesRead;
        }
        return bytes;
      } finally { await file.close(); }
    } catch (error) { if (missing(error)) return null; throw error; }
  };
}
