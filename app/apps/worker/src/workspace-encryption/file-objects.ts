import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FILE_LIMITS } from '@flux/contracts';
import type { RotationFileObjects } from '@flux/core';

/**
 * The files step's object store (F-030 S2c): the API's attachment layout (`attachments/objects/<2>/<id>`, scratch in
 * `attachments/tmp`). A re-encrypted object is written as a new file in scratch, fsynced, renamed over the old one
 * (atomic on one filesystem) and its directory synced, so a crash leaves either the old object or the new one. Paths
 * are opened without following symlinks, as in `apps/server/src/files/storage.ts`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const missing = (error: unknown) => ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

export async function diskRotationObjects(filesDir: string): Promise<RotationFileObjects> {
  const root = join(filesDir, 'attachments');
  const tmp = join(root, 'tmp');
  const objects = join(root, 'objects');
  async function realDirectory(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe attachment directory');
  }
  async function syncDirectory(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function objectPath(id: string) {
    if (!UUID.test(id)) throw new Error('Invalid internal attachment object id');
    for (const path of [root, objects, join(objects, id.slice(0, 2))]) await realDirectory(path);
    return join(objects, id.slice(0, 2), id);
  }
  return {
    async read(id) {
      try {
        const file = await open(await objectPath(id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > FILE_LIMITS.fileBytes + 64) return null;
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
    },
    async replace(id, object) {
      const destination = await objectPath(id);
      await realDirectory(tmp);
      const scratch = join(tmp, randomUUID());
      const file = await open(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        let offset = 0;
        while (offset < object.length) offset += (await file.write(object, offset, object.length - offset)).bytesWritten;
        await file.sync();
      } catch (error) {
        await file.close();
        await unlink(scratch).catch(() => undefined);
        throw error;
      }
      await file.close();
      await rename(scratch, destination);
      await syncDirectory(dirname(destination));
      await syncDirectory(tmp);
    },
  };
}
