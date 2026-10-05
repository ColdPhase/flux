import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FILE_LIMITS } from '@flux/contracts';
import { FileReceiveTimeoutError, FileTooLargeError, type FileStorage } from '@flux/core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const missing = (error: unknown) => ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** App-owned 0700 directories and random paths, all opened without following symlinks. */
export async function diskFileStorage(filesDir: string): Promise<FileStorage> {
  async function syncDirectory(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function directory(path: string) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Attachment storage needs owned real directories');
    await syncDirectory(path); await syncDirectory(dirname(path));
  }
  const root = join(filesDir, 'attachments');
  const tmp = join(root, 'tmp');
  const objects = join(root, 'objects');
  await syncDirectory(filesDir);
  await directory(root); await directory(tmp); await directory(objects);
  async function objectPath(id: string, create = false) {
    if (!UUID.test(id)) throw new Error('Invalid internal attachment object id');
    // The volume is writable only by the app account. Check every owned parent as well as the leaf.
    for (const path of [root, objects]) {
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe attachment directory');
    }
    const shard = join(objects, id.slice(0, 2));
    if (create) await directory(shard);
    else {
      const stat = await lstat(shard);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe attachment directory');
    }
    return join(shard, id);
  }
  async function removePath(path: string) {
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    // Also sync a repeated unlink: a previous unlink may have succeeded before fsync failed.
    await syncDirectory(dirname(path));
  }
  const storage: FileStorage = {
    async receive(bytes, limits) {
      const iterator = bytes[Symbol.asyncIterator]();
      await directory(tmp);
      const scratch = join(tmp, randomUUID());
      const file = await open(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256');
      let size = 0;
      try {
        while (true) {
          const remaining = limits.deadline - Date.now();
          if (remaining <= 0) throw new FileReceiveTimeoutError();
          let timer: NodeJS.Timeout | undefined;
          const item = await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new FileReceiveTimeoutError()), remaining);
          })]).finally(() => { if (timer) clearTimeout(timer); });
          if (item.done) break;
          size += item.value.byteLength;
          if (size > limits.maxBytes) throw new FileTooLargeError();
          hash.update(item.value);
          let offset = 0;
          while (offset < item.value.byteLength) {
            const wrote = await file.write(item.value, offset, item.value.byteLength - offset);
            offset += wrote.bytesWritten;
          }
        }
        await file.sync();
      } catch (error) {
        void iterator.return?.().catch(() => undefined);
        await file.close(); await removePath(scratch);
        throw error;
      }
      await file.close();
      return { size, sha256: hash.digest('hex'),
        async commit(id) {
          const destination = await objectPath(id, true);
          // Server random UUIDs are never reused; refuse a pre-existing object, including a symlink.
          try { await lstat(destination); throw new Error('Attachment object already exists'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await rename(scratch, destination);
          await syncDirectory(dirname(destination)); await syncDirectory(tmp);
        },
        discard: () => removePath(scratch),
      };
    },
    async read(id) {
      try {
        const path = await objectPath(id);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
          // An operator changing an object during the read must not make partial bytes appear valid.
          if ((await file.stat()).size !== stat.size) return null;
          return bytes;
        } finally { await file.close(); }
      } catch (error) { if (missing(error)) return null; throw error; }
    },
    async has(id, size, sha256) {
      const bytes = await storage.read(id);
      return bytes !== null && bytes.byteLength === size
        && (sha256 === undefined || createHash('sha256').update(bytes).digest('hex') === sha256);
    },
    async remove(id) {
      try { await removePath(await objectPath(id)); }
      catch (error) { if (!missing(error)) throw error; }
    },
    async sweepScratch(olderThanMs) {
      await directory(tmp);
      let removed = 0;
      for (const name of await readdir(tmp)) {
        if (!UUID.test(name)) continue;
        const path = join(tmp, name);
        try {
          const stat = await lstat(path);
          if (stat.isFile() && stat.mtimeMs < Date.now() - olderThanMs) { await removePath(path); removed++; }
        } catch (error) { if (!missing(error)) throw error; }
      }
      return removed;
    },
  };
  return storage;
}
