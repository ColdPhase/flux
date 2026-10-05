import { createHash, randomUUID } from 'node:crypto';
import { FILE_LIMITS, type MessageFile, type StagedFile } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, PayloadTooLargeError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import type { ActorRef } from '../work/ports.js';
import { id } from '../work/validation.js';
import { FileReceiveTimeoutError, FileTooLargeError, type FileRepository, type FileStorage, type FileUnitOfWork, type StoredFileRow } from './ports.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Control, path and bidirectional-override characters a display name may not contain. */
const UNSAFE_NAME = /[/\\‪-‮⁦-⁩]/;
const hasControls = (value: string) => [...value].some((char) => {
  const code = char.codePointAt(0)!;
  return code < 32 || (code >= 127 && code <= 159);
});

/** A file's display name: 1–200 characters, no control or path characters, never "." or "..". */
export function displayName(value: unknown): string {
  const normalized = typeof value === 'string' ? value.normalize('NFC') : '';
  if ((UNSAFE_NAME.test(normalized) || hasControls(normalized))) throw new InvalidInputError('A file name cannot contain control or path characters', 'INVALID_FILE_NAME');
  const name = normalized.trim();
  if (!name || name.length > FILE_LIMITS.nameChars) throw new InvalidInputError(`A file name must be 1–${FILE_LIMITS.nameChars} characters`, 'INVALID_FILE_NAME');
  if (UNSAFE_NAME.test(name) || name === '.' || name === '..') throw new InvalidInputError('A file name cannot contain control or path characters', 'INVALID_FILE_NAME');
  return name;
}

/** Files are staged by a signed-in person. Agent file operations stay unavailable until #152/#153 compose them. */
function uploaderOf(principal: Principal): ActorRef {
  if (principal.kind === 'human') return { kind: 'human', id: principal.id };
  throw new ForbiddenError('Agents cannot stage or attach files yet', 'AGENT_FILES_UNAVAILABLE');
}
const same = (a: ActorRef, b: ActorRef) => a.kind === b.kind && a.id === b.id;
const unavailable = () => new NotFoundError('File', 'FILE_UNAVAILABLE');
const attachmentUnavailable = () => new NotFoundError('Attachment', 'ATTACHMENT_UNAVAILABLE');

/** Verifies a ready UUID without a second disk copy, including at a full staging quota. */
async function digestOnly(bytes: AsyncIterable<Uint8Array>, limits: { maxBytes: number; deadline: number }) {
  const iterator = bytes[Symbol.asyncIterator]();
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
    }
  } catch (error) { void iterator.return?.().catch(() => undefined); throw error; }
  return { size, sha256: hash.digest('hex'), discard: async () => undefined,
    commit: async () => { throw new Error('A digest verification cannot publish bytes'); } };
}


function staged(row: StoredFileRow): StagedFile {
  if (row.state !== 'ready' || row.size === null || row.sha256 === null || row.readyAt === null || row.expiresAt === null)
    throw new Error('A staged file must be ready and unpublished');
  return { id: row.id, projectId: row.projectId, uploadId: row.uploadId, name: row.name, size: row.size, sha256: row.sha256,
    readyAt: row.readyAt.toISOString(), expiresAt: row.expiresAt.toISOString() };
}

/**
 * Locks the files a new message will carry, in ascending id order, and checks that each is the author's own,
 * in this project, ready, unexpired, not attached elsewhere and present with its exact size. Call it after the
 * message's command identity and before any task or conversation lock (#154 correction 4); nothing it reads
 * comes after the message insert. Returns the files in the message's order.
 */
export async function lockAttachments(files: FileRepository, storage: Pick<FileStorage, 'has'>, projectId: string,
  author: ActorRef, ids: readonly string[], clock: () => Date): Promise<StoredFileRow[]> {
  if (!ids.length) return [];
  if (author.kind !== 'human') throw new ForbiddenError('Agents cannot stage or attach files yet', 'AGENT_FILES_UNAVAILABLE');
  const rows = new Map((await files.lockFiles(ids)).map((row) => [row.id, row]));
  const now = clock();
  let total = 0;
  const ordered: StoredFileRow[] = [];
  for (const fileId of ids) {
    const row = rows.get(fileId);
    // Another person's file, another project's, a reservation or a guessed id are all the same unknown file.
    if (!row || row.projectId !== projectId || !same(row.uploader, author) || row.state !== 'ready' || row.size === null)
      throw attachmentUnavailable();
    if (row.messageId !== null) throw new ConflictError('A file is already attached to another message', 'ATTACHMENT_ALREADY_PUBLISHED');
    if (!row.expiresAt || row.expiresAt <= now || !row.sha256 || !await storage.has(row.id, row.size, row.sha256)) throw attachmentUnavailable();
    total += row.size;
    ordered.push(row);
  }
  if (total > FILE_LIMITS.messageBytes) throw new InvalidInputError('The files of one message are at most 20 MiB together', 'ATTACHMENTS_TOO_LARGE');
  return ordered;
}

/** The current file list of each message, for read projections. */
export function messageFiles(rows: Map<string, MessageFile[]>, messageId: string): { files?: MessageFile[] } {
  const files = rows.get(messageId);
  return files?.length ? { files } : {};
}

/**
 * Staging, download and cleanup of stored files (#154). The upload holds no SQL transaction or lock while
 * bytes arrive: a short admission reserves the maximum size under the uploader's lock, the bytes stream into
 * private scratch, then a short generation-fenced finalization rechecks access and makes local bytes durable before the row is
 * ready. A ready row therefore always names durable bytes.
 */
export function createFileUseCases(unit: FileUnitOfWork, storage: FileStorage, clock: () => Date = () => new Date()) {
  /** Best effort: frees a reservation whose bytes never became ready. */
  const release = (projectId: string, uploader: ActorRef, fileId: string) => unit.run(async (ports) => {
    await ports.files.lockUploader(projectId, uploader);
    const row = await ports.files.findFile(fileId);
    if (row?.state === 'receiving') await ports.files.removeUnpublished(fileId);
  }).catch(() => { /* the reservation expires on its own */ });

  return {
    /**
     * Stages one file for the signed-in person. The same uploadId with the same bytes and name returns the
     * original file; anything else under that uploadId conflicts, and one still arriving is UPLOAD_IN_PROGRESS.
     */
    async stage(principal: Principal, projectIdInput: string, query: { uploadId?: unknown; name?: unknown },
      bytes: AsyncIterable<Uint8Array>, declaredLength?: number): Promise<StagedFile> {
      const projectId = id(projectIdInput, 'projectId').toLowerCase();
      const uploadId = id(query.uploadId, 'uploadId').toLowerCase();
      const name = displayName(query.name);
      const uploader = uploaderOf(principal);
      if (declaredLength !== undefined && declaredLength > FILE_LIMITS.fileBytes)
        throw new PayloadTooLargeError('A file is at most 5 MiB', 'FILE_TOO_LARGE');
      if (declaredLength === 0) throw new InvalidInputError('A file needs at least one byte', 'EMPTY_FILE');

      const admitted = await unit.run(async (ports) => {
        const project = await ports.access.requireProject(principal, 'write', projectId, { lock: true });
        await ports.files.lockUploader(projectId, uploader);
        const now = clock();
        const existing = await ports.files.findUpload(projectId, uploader, uploadId);
        if (existing?.state === 'ready' && (existing.messageId !== null || (existing.expiresAt && existing.expiresAt > now))) {
          if (await ports.files.activeReplay(existing.id, now))
            throw new ConflictError('This upload is being verified', 'UPLOAD_IN_PROGRESS');
          const verification = await ports.files.reserve({ id: randomUUID(), workspaceId: project.workspaceId, projectId, uploader,
            uploadId: randomUUID(), name, reservedBytes: 0, replayOf: existing.id,
            expiresAt: new Date(now.getTime() + FILE_LIMITS.reservationMinutes * MINUTE) });
          return { replay: existing, verification };
        }
        if (existing && existing.expiresAt && existing.expiresAt > now)
          throw new ConflictError('This upload is still arriving', 'UPLOAD_IN_PROGRESS');
        // An abandoned reservation is replaced by a new row and id: its late finish cannot touch these bytes.
        if (existing) await ports.files.removeUnpublished(existing.id);
        if (await ports.files.stagedBytes(projectId, uploader, now) + FILE_LIMITS.fileBytes > FILE_LIMITS.stagedBytes)
          throw new ConflictError('Too many files are waiting to be sent in this project. Send or remove some first.', 'UPLOAD_QUOTA_EXCEEDED');
        const reserved = await ports.files.reserve({ id: randomUUID(), workspaceId: project.workspaceId, projectId, uploader, uploadId,
          name, reservedBytes: FILE_LIMITS.fileBytes, expiresAt: new Date(now.getTime() + FILE_LIMITS.reservationMinutes * MINUTE) });
        return { reserved };
      });

      let received;
      try {
        const limits = { maxBytes: FILE_LIMITS.fileBytes, deadline: Date.now() + FILE_LIMITS.receiveSeconds * 1000 };
        received = admitted.replay ? await digestOnly(bytes, limits) : await storage.receive(bytes, limits);
      } catch (error) {
        if (admitted.reserved ?? admitted.verification) await release(projectId, uploader, (admitted.reserved ?? admitted.verification)!.id);
        if (error instanceof FileTooLargeError) throw new PayloadTooLargeError('A file is at most 5 MiB', 'FILE_TOO_LARGE');
        if (error instanceof FileReceiveTimeoutError) throw new InvalidInputError('The file did not arrive in time', 'UPLOAD_TIMEOUT');
        throw error;
      }
      if (received.size === 0) {
        await received.discard();
        if (admitted.reserved ?? admitted.verification) await release(projectId, uploader, (admitted.reserved ?? admitted.verification)!.id);
        throw new InvalidInputError('A file needs at least one byte', 'EMPTY_FILE');
      }
      if (admitted.replay) {
        try {
          await received.discard();
          const original = admitted.replay;
          return await unit.run(async (ports) => {
            await ports.access.requireProject(principal, 'write', projectId, { lock: true });
            await ports.files.lockUploader(projectId, uploader);
            const current = await ports.files.findUpload(projectId, uploader, uploadId);
            if (!current || current.id !== original.id || current.state !== 'ready'
              || (current.messageId === null && (!current.expiresAt || current.expiresAt <= clock()))
              || !await storage.has(current.id, current.size!, current.sha256!)) throw unavailable();
            if (original.size !== received.size || original.sha256 !== received.sha256 || original.name !== name)
              throw new ConflictError('This uploadId was used for another file', 'UPLOAD_CONFLICT');
            return staged({ ...current, expiresAt: current.expiresAt ?? new Date(current.readyAt!.getTime() + FILE_LIMITS.unpublishedDays * DAY) });
          });
        } finally { await release(projectId, uploader, admitted.verification!.id); }
      }

      const reservation = admitted.reserved!;
      try {
        return await unit.run(async (ports) => {
          await ports.access.requireProject(principal, 'write', projectId, { lock: true });
          await ports.files.lockUploader(projectId, uploader);
          const live = await ports.files.findFile(reservation.id);
          if (!live || live.state !== 'receiving' || !live.expiresAt || live.expiresAt <= clock())
            throw new ConflictError('The upload took too long; send the file again', 'UPLOAD_EXPIRED');
          // Only local rename/directory sync is inside this short generation fence. Network,
          // hash and file fsync finished in private scratch; cleanup cannot retire us mid-rename.
          await received.commit(reservation.id);
          const now = clock();
          const ready = await ports.files.markReady(reservation.id, { size: received.size, sha256: received.sha256, readyAt: now,
            expiresAt: new Date(now.getTime() + FILE_LIMITS.unpublishedDays * DAY) });
          if (!ready) throw new ConflictError('The upload took too long; send the file again', 'UPLOAD_EXPIRED');
          return staged((await ports.files.findFile(reservation.id))!);
        });
      } catch (error) {
        // COMMIT may have succeeded despite a lost acknowledgement. Under the same admission lock,
        // establish the actual row state before removing bytes; an uncertain read always retains them.
        const unpublished = await unit.run(async (ports) => {
          await ports.files.lockUploader(projectId, uploader);
          const current = await ports.files.findFile(reservation.id);
          if (current?.state === 'ready') return false;
          if (current) await ports.files.removeUnpublished(reservation.id);
          return true;
        }).catch(() => false);
        await received.discard().catch(() => { /* scratch is bounded and swept after abandonment */ });
        if (unpublished) await storage.remove(reservation.id).catch(() => { /* durable tombstone retries deletion */ });
        throw error;
      }
    },

    /**
     * A file's bytes, after current access: a published file to anyone who can read its project now, an
     * unpublished one only to its uploader. Missing or corrupt bytes are unavailable, never served.
     */
    async download(principal: Principal, fileIdInput: string): Promise<{ name: string; size: number; bytes: Uint8Array }> {
      const fileId = id(fileIdInput, 'fileId').toLowerCase();
      const row = await unit.run(async (ports) => {
        const file = await ports.files.findFile(fileId);
        if (!file || file.state !== 'ready' || file.size === null) throw unavailable();
        try { await ports.access.requireProject(principal, 'read', file.projectId); }
        catch (error) { if (error instanceof NotFoundError || error instanceof ForbiddenError) throw unavailable(); throw error; }
        if (file.messageId === null) {
          const mine = principal.kind === 'human' && file.uploader.kind === 'human' && file.uploader.id === principal.id;
          if (!mine || !file.expiresAt || file.expiresAt <= clock()) throw unavailable();
        }
        return file;
      });
      const bytes = await storage.read(row.id);
      if (!bytes || bytes.byteLength !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw unavailable();
      return { name: row.name, size: row.size!, bytes };
    },

    /**
     * Removes up to `limit` expired unpublished files: rows under the uploader lock, then the sorted file
     * locks, rechecked; bytes after commit. Published files and their bytes are never touched here.
     */
    async cleanup(limit = 50): Promise<number> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new InvalidInputError('Cleanup batch must be 1–50 files');
      const removed = await unit.run(async (ports) => {
        const now = clock();
        const candidates = await ports.files.expired(now, limit);
        const uploaders = [...new Map(candidates.map((row) => [`${row.projectId}:${row.uploader.kind}:${row.uploader.id}`, row])).entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
        for (const row of uploaders) await ports.files.lockUploader(row.projectId, row.uploader);
        const gone: StoredFileRow[] = [];
        for (const row of await ports.files.lockFiles(candidates.map((candidate) => candidate.id))) {
          if (row.messageId !== null || !row.expiresAt || row.expiresAt > now) continue;
          if (await ports.files.removeUnpublished(row.id)) gone.push(row);
        }
        return gone;
      });
      // Retired objects stay in a durable queue until unlink and directory fsync both succeed.
      // A crash or I/O failure cannot strand an object that cleanup can no longer discover.
      const garbage = await unit.run((ports) => ports.files.pendingGarbage(limit));
      const deleted: string[] = [];
      for (const id of garbage) {
        try { await storage.remove(id); deleted.push(id); } catch { /* retry the durable tombstone next sweep */ }
      }
      if (deleted.length) await unit.run((ports) => ports.files.forgetGarbage(deleted));
      await storage.sweepScratch(FILE_LIMITS.reservationMinutes * MINUTE);
      return removed.length;
    },
  };
}
