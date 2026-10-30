import type { StoredFileCipher } from '@flux/db';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FILE_LIMITS } from '@flux/contracts';
import { FileReceiveTimeoutError, FileTooLargeError, type FileStorage } from '@flux/core';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const missing = (error: unknown) => ['ENOENT', 'ELOOP', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

/** App-owned 0700 directories and random paths, all opened without following symlinks. */
/**
 * F-030: the cipher of one stored object, or null for a plain workspace's file. Resolved from the file's row (its
 * reservation is committed before the first byte arrives); a sealed workspace that is locked here throws 423, so a
 * locked workspace's bytes are neither written nor served.
 */
/** A sealed object's header (magic, key version, nonce) and GCM tag around the plaintext. */
const SEALED_OBJECT_OVERHEAD = 4 + 4 + 12 + 16;

export type ObjectCipherResolver = (objectId: string) => Promise<StoredFileCipher | null>;

export async function diskFileStorage(filesDir: string, options: { cipherFor?: ObjectCipherResolver } = {}): Promise<FileStorage> {
  const cipherFor: ObjectCipherResolver = options.cipherFor ?? (async () => null);
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
  /** The stored object's bytes as they are on disk (an encrypted workspace's are sealed), or null when missing. */
  async function readObject(id: string): Promise<Buffer | null> {
    try {
        const path = await objectPath(id);
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size < 1 || stat.size > FILE_LIMITS.fileBytes + SEALED_OBJECT_OVERHEAD) return null;
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
  }
  async function writeAll(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.byteLength) offset += (await file.write(bytes, offset, bytes.byteLength - offset)).bytesWritten;
  }
  const storage: FileStorage = {
    async receive(bytes, limits, objectId) {
      const sealer = objectId ? (await cipherFor(objectId))?.sealer() ?? null : null;
      const iterator = bytes[Symbol.asyncIterator]();
      await directory(tmp);
      const scratch = join(tmp, randomUUID());
      const file = await open(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const hash = createHash('sha256');
      let size = 0;
      // F-030 S2c: the key version in the sealed object's header (bytes 4–8 of its first output).
      let keyVersion: number | null = null;
      const sealed = (chunk: Buffer) => { if (keyVersion === null && chunk.length >= 8) keyVersion = chunk.readUInt32BE(4); return chunk; };
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
          await writeAll(file, sealer ? sealed(sealer.update(item.value)) : item.value);
        }
        if (sealer) await writeAll(file, sealed(sealer.final()));
        await file.sync();
      } catch (error) {
        void iterator.return?.().catch(() => undefined);
        await file.close(); await removePath(scratch);
        throw error;
      }
      await file.close();
      return { size, sha256: hash.digest('hex'), keyVersion,
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
      const bytes = await readObject(id);
      if (!bytes) return null;
      const cipher = await cipherFor(id);
      if (!cipher) return bytes;
      try { return cipher.open(Buffer.from(bytes)); } catch { return null; } // tampered or truncated: unavailable, never served
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
