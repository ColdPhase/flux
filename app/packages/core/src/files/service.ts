import { createHash, randomUUID } from 'node:crypto';
import { FILE_LIMITS, imageTypeOf, videoContainerOf, videoNameContainer, type FileDetail, type FileLimits, type StagedFile, type ThoughtFile, type VideoContainer } from '@flux/contracts';
import { ConflictError, ForbiddenError, InvalidInputError, NotFoundError, PayloadTooLargeError, RateLimitedError } from '../access/errors.js';
import { Readable } from 'node:stream';
import type { Principal } from '../principal.js';
import type { ActorRef } from '../work/ports.js';
import { id } from '../work/validation.js';
import { fileDetailOf, readsDetail } from './detail.js';
import type { CleanPicture, PictureCanonicalizer } from './picture.js';
import { parseRange } from './range.js';
import { FileReceiveTimeoutError, FileTooLargeError, type FilePorts, type FileRepository, type FileStorage, type FileUnitOfWork, type StoredFileRow } from './ports.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Batches of retired objects one cleanup sweep removes at most: 5,000 files a sweep, so a deleted space does not take hours to leave the disk. */
const GARBAGE_BATCHES_PER_SWEEP = 100;
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
/** Published to a message or (#252) to a map thought; unpublished files are their uploader's private staging. */
export const isPublished = (row: Pick<StoredFileRow, 'messageId' | 'thoughtId'> & { dmMessageId?: string | null }) => row.messageId !== null || row.dmMessageId != null || row.thoughtId !== null;
/** The id of the place a file belongs to: its space's, or its direct message's (#1438 point 10). */
export const fileScopeOf = (row: Pick<StoredFileRow, 'projectId' | 'dmId'>) => (row.projectId ?? row.dmId)!;
/** Where a file is staged: a space, or a direct message (#1438 point 10). */
export type Place = 'project' | 'dm';
const unavailable = () => new NotFoundError('File', 'FILE_UNAVAILABLE');
const attachmentUnavailable = () => new NotFoundError('Attachment', 'ATTACHMENT_UNAVAILABLE');

/** The bytes of an upload, until more than `maxBytes` arrive (`FileTooLargeError`) or its deadline passes (`FileReceiveTimeoutError`). */
async function* bounded(bytes: AsyncIterable<Uint8Array>, limits: { maxBytes: number; deadline: number }): AsyncGenerator<Uint8Array> {
  const iterator = bytes[Symbol.asyncIterator]();
  let size = 0; let ended = false;
  try {
    while (true) {
      const remaining = limits.deadline - Date.now();
      if (remaining <= 0) throw new FileReceiveTimeoutError();
      let timer: NodeJS.Timeout | undefined;
      const item = await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new FileReceiveTimeoutError()), remaining);
      })]).finally(() => { if (timer) clearTimeout(timer); });
      if (item.done) { ended = true; return; }
      size += item.value.byteLength;
      if (size > limits.maxBytes) throw new FileTooLargeError();
      yield item.value;
    }
  } finally { if (!ended) void iterator.return?.().catch(() => undefined); }
}

/** Verifies a ready UUID without a second disk copy, including at a full staging quota. */
async function digestOnly(bytes: AsyncIterable<Uint8Array>, limits: { maxBytes: number; deadline: number }) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of bounded(bytes, limits)) { size += chunk.byteLength; hash.update(chunk); }
  return { size, sha256: hash.digest('hex'), discard: async () => undefined,
    commit: async () => { throw new Error('A digest verification cannot publish bytes'); } };
}

/** What a person is told when the real decoder cannot vouch for a picture they sent (#1343). */
function pictureRefused(reason: Extract<CleanPicture, { ok: false }>['reason']): Error {
  if (reason === 'too_many_pixels') return new PayloadTooLargeError('A picture is at most 8,000 pixels on a side and 40 megapixels', 'PICTURE_TOO_MANY_PIXELS');
  // The upload itself was within 5 MiB (that is refused before this); the picture written again is not.
  if (reason === 'too_large') return new PayloadTooLargeError('A file is at most 5 MiB, and this picture is larger once it is cleaned. Save it smaller and send it again', 'FILE_TOO_LARGE');
  return new InvalidInputError('This picture cannot be read: it is damaged, or its parts do not agree on one image', 'UNREADABLE_PICTURE');
}

/**
 * Looks at the first bytes of an upload (#1343, C-59): a file that starts like a PNG, JPEG, GIF or WebP is read whole, decoded and written again
 * by the real decoder (`PictureCanonicalizer`), so what every reader's browser draws is exactly what was checked, and goes on as that picture;
 * a picture it cannot vouch for is refused. Any other file passes through unchanged, as it arrived.
 */
async function canonicalUpload(bytes: AsyncIterable<Uint8Array>, canonicalizer: PictureCanonicalizer): Promise<AsyncIterable<Uint8Array>> {
  const iterator = bytes[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let seen = 0; let finished = false;
  const more = async () => { const item = await iterator.next(); if (item.done) finished = true; else { chunks.push(item.value); seen += item.value.byteLength; } };
  try { while (seen < 12 && !finished) await more(); }
  catch (error) { void iterator.return?.().catch(() => undefined); throw error; }
  if (!imageTypeOf(Buffer.concat(chunks))) {
    return (async function* () {
      yield* chunks;
      try { while (!finished) { const item = await iterator.next(); if (item.done) { finished = true; return; } yield item.value; } }
      finally { if (!finished) void iterator.return?.().catch(() => undefined); }
    })();
  }
  try { while (!finished) await more(); }
  catch (error) { void iterator.return?.().catch(() => undefined); throw error; }
  const picture = await canonicalizer.canonical(Buffer.concat(chunks));
  if (!picture.ok) throw pictureRefused(picture.reason);
  return (async function* () { yield picture.bytes; })();
}


function staged(row: StoredFileRow): StagedFile {
  if (row.state !== 'ready' || row.size === null || row.sha256 === null || row.readyAt === null || row.expiresAt === null)
    throw new Error('A staged file must be ready and unpublished');
  return { id: row.id, ...(row.projectId !== null ? { projectId: row.projectId } : { dmId: row.dmId! }), uploadId: row.uploadId, name: row.name, size: row.size, sha256: row.sha256,
    readyAt: row.readyAt.toISOString(), expiresAt: row.expiresAt.toISOString(), ...storedDetail(row) };
}

/** What a stored row says about its file (#469), as the keys of `FileDetail`; a key only where there is a value. */
export function storedDetail(row: Pick<StoredFileRow, 'pageCount' | 'rowCount' | 'durationMs' | 'videoContainer'>): FileDetail {
  return { ...(row.pageCount != null ? { pages: row.pageCount } : {}), ...(row.rowCount != null ? { rows: row.rowCount } : {}),
    ...(row.durationMs != null ? { durationMs: row.durationMs } : {}), ...(row.videoContainer ? { video: row.videoContainer } : {}) };
}

/** Passes the bytes on unchanged and keeps them (at most the file limit, which the receiver enforces) for the one reader of their detail. */
async function* observed(bytes: AsyncIterable<Uint8Array>, keep: Uint8Array[]): AsyncGenerator<Uint8Array> {
  let kept = 0;
  for await (const chunk of bytes) {
    if (kept <= FILE_LIMITS.fileBytes) { keep.push(chunk); kept += chunk.byteLength; }
    yield chunk;
  }
}

/** A file named like a video whose first bytes are no video container (C-61). */
class NotAVideoError extends Error {}
/** The first bytes of a video are kept for the container check and the playing time; the rest of it is never held. */
const VIDEO_HEAD_BYTES = 64 * 1024;
/** An ISO base-media `ftyp` box is at most 4 KiB, so the container can be told from this many bytes. */
const SNIFF_BYTES = 4096 + 16;
interface VideoHead { chunks: Uint8Array[]; length: number; container: VideoContainer | null }

/**
 * Passes a video's bytes on unchanged, keeps its first {@link VIDEO_HEAD_BYTES}, and refuses the upload as soon as the first bytes say it is
 * no video container (C-61), so a mislabelled gigabyte stops after its first chunk. It never closes the source it reads: a request
 * stream destroyed here would take the connection with it before the refusal could be sent; the route closes an unfinished request once the
 * answer has gone out.
 */
async function* sniffed(bytes: AsyncIterable<Uint8Array>, head: VideoHead): AsyncGenerator<Uint8Array> {
  const check = () => {
    head.container = videoContainerOf(Buffer.concat(head.chunks));
    if (!head.container) throw new NotAVideoError();
  };
  const iterator = bytes[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = next.value;
    if (head.length < VIDEO_HEAD_BYTES) {
      const part = chunk.subarray(0, VIDEO_HEAD_BYTES - head.length);
      head.chunks.push(part);
      head.length += part.byteLength;
    }
    if (!head.container && head.length >= SNIFF_BYTES) check();
    yield chunk;
  }
  if (!head.container) check();
}

/** At most `max` bytes of a small upload (a poster), within the same time a file has. */
async function collect(bytes: AsyncIterable<Uint8Array>, max: number): Promise<Buffer> {
  const iterator = bytes[Symbol.asyncIterator]();
  const parts: Uint8Array[] = [];
  let size = 0;
  const deadline = Date.now() + FILE_LIMITS.receiveSeconds * 1000;
  try {
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new FileReceiveTimeoutError();
      let timer: NodeJS.Timeout | undefined;
      const item = await Promise.race([iterator.next(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FileReceiveTimeoutError()), remaining); })])
        .finally(() => { if (timer) clearTimeout(timer); });
      if (item.done) break;
      size += item.value.byteLength;
      if (size > max) throw new FileTooLargeError();
      parts.push(item.value);
    }
  } catch (error) { void iterator.return?.().catch(() => undefined); throw error; }
  return Buffer.concat(parts);
}

/** How many of one person's videos may be arriving at once (C-61): each holds a connection for up to 20 minutes. */
const VIDEO_ARRIVALS = 3;

const mib = (bytes: number) => `${Math.round(bytes / (1024 * 1024) * 10) / 10} MiB`;
const tooLarge = (limit: number, video: boolean) => new PayloadTooLargeError(video ? `A video is at most ${mib(limit)}` : 'A file is at most 5 MiB', 'FILE_TOO_LARGE');

/**
 * Locks the files a new message will carry, in ascending id order, and checks that each is the author's own,
 * in this project, ready, unexpired, not attached elsewhere and present with its exact size. Call it after the
 * message's command identity and before any task or conversation lock (#154 correction 4); nothing it reads
 * comes after the message insert. Returns the files in the message's order.
 *
 * #1411: it runs inside the message's transaction, so it reads no byte of any file: the row's recorded size and SHA-256 (computed once,
 * from the bytes as the upload arrived) and the object's size on disk. Hashing a 200 MiB video here held a database connection per send,
 * and a few sends at once held them all. A file up to 5 MiB has had its bytes checked just before, by `verifyAttachmentBytes`; a larger
 * video's changed bytes are refused where they are read (C-61).
 */
export async function lockAttachments(files: FileRepository, storage: Pick<FileStorage, 'present'>, projectId: string,
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
    // A video's poster (C-61) is no attachment of its own: it goes to the message with its video.
    if (!row || fileScopeOf(row) !== projectId || !same(row.uploader, author) || row.state !== 'ready' || row.size === null || row.posterOf)
      throw attachmentUnavailable();
    if (isPublished(row)) throw new ConflictError(row.messageId !== null || row.dmMessageId != null ? 'A file is already attached to another message'
      : 'A file is already the image of a map thought', 'ATTACHMENT_ALREADY_PUBLISHED');
    if (!row.expiresAt || row.expiresAt <= now || !row.sha256 || !await storage.present(row.id, row.size, row.keyVersion != null)) throw attachmentUnavailable();
    // A video (C-61) has its own cap and staging allowance, which already keep a message's videos within one cap.
    if (!row.videoContainer) total += row.size;
    ordered.push(row);
  }
  if (total > FILE_LIMITS.messageBytes) throw new InvalidInputError('The files of one message are at most 20 MiB together, not counting videos', 'ATTACHMENTS_TOO_LARGE');
  return ordered;
}

/**
 * #154, #1411: checks the bytes of each file up to 5 MiB a new message will carry against the SHA-256 computed as its upload arrived (a
 * sealed one opened by its tag too), so a file changed on disk since its upload still cannot be sent. Call it before the message's
 * transaction opens: it holds no database connection while it reads (at most 10 files of 5 MiB). It reads only the author's own ready,
 * unsent files and refuses with the same unknown-file answer as `lockAttachments`, which still makes every check of the rows inside the
 * transaction. A larger video is not read here; its size is checked on every range and its digest in the export bundle (C-61).
 */
export async function verifyAttachmentBytes(files: Pick<FileRepository, 'findFiles'>, storage: Pick<FileStorage, 'has'>,
  author: ActorRef, ids: readonly string[]): Promise<void> {
  if (!ids.length || author.kind !== 'human') return;
  for (const row of await files.findFiles(ids)) {
    if (!same(row.uploader, author) || row.state !== 'ready' || row.size === null || row.size > FILE_LIMITS.fileBytes || !row.sha256
      || row.posterOf || isPublished(row)) continue;
    if (!await storage.has(row.id, row.size, row.sha256)) throw attachmentUnavailable();
  }
}

/**
 * #252: makes `fileId` the image of the map thought `thoughtId` of a project sketch, inside the thought's transaction
 * (after the sketch lock). The file must be the caller's own ready, unexpired, unpublished file of `projectId`, with its
 * exact stored bytes, which must be a PNG, JPEG, GIF or WebP image by signature. A file already published to this same
 * thought id (Undo re-creating a removed thought) is accepted as it is; any other published file is refused.
 */
export async function prepareThoughtImage(files: FileRepository, storage: Pick<FileStorage, 'read'>, principal: Principal,
  input: { projectId: string; fileId: string; thoughtId: string }, clock: () => Date = () => new Date()): Promise<()=>Promise<ThoughtFile>> {
  const author = uploaderOf(principal);
  const fileId = id(input.fileId, 'fileId').toLowerCase();
  const [row] = await files.lockFiles([fileId]);
  // Another project's file, a reservation or a guessed id are all the same unknown file.
  if (!row || row.projectId !== input.projectId || row.state !== 'ready' || row.size === null || row.sha256 === null) throw attachmentUnavailable();
  const view={id:row.id,name:row.name,size:row.size};
  if (row.thoughtId === input.thoughtId) return async()=>view;
  if (isPublished(row)) throw new ConflictError(row.messageId !== null ? 'A file is already attached to a message'
    : 'A file is already the image of another map thought', 'ATTACHMENT_ALREADY_PUBLISHED');
  if (!same(row.uploader, author) || !row.expiresAt || row.expiresAt <= clock()) throw attachmentUnavailable();
  const bytes = await storage.read(row.id);
  if (!bytes || bytes.byteLength !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw attachmentUnavailable();
  if (!imageTypeOf(bytes)) throw new InvalidInputError('Only a PNG, JPEG, GIF or WebP image can be placed on a map', 'UNSUPPORTED_IMAGE');
  return async()=>{
    if (!await files.publishToThought(row.id, input.thoughtId, clock())) throw attachmentUnavailable();
    return view;
  };
}

/** Existing callers retain the same verified publication behavior. Composing callers prepare before task fences. */
export async function placeThoughtImage(files: FileRepository, storage: Pick<FileStorage, 'read'>, principal: Principal,
  input: { projectId: string; fileId: string; thoughtId: string }, clock: () => Date = () => new Date()): Promise<ThoughtFile> {
  return(await prepareThoughtImage(files,storage,principal,input,clock))();
}

/**
 * Staging, download and cleanup of stored files (#154). The upload holds no SQL transaction or lock while
 * bytes arrive: a short admission reserves the maximum size under the uploader's lock, the bytes stream into
 * private scratch, then a short generation-fenced finalization rechecks access and makes local bytes durable before the row is
 * ready. A ready row therefore always names durable bytes.
 */
/** A stored file ready to be sent (`open`): `status` 200 (all of it), 206 (bytes `start` to `end`) or 416 (no body). */
export interface OpenedFile {
  name: string;
  size: number;
  video: VideoContainer | null;
  status: 200 | 206 | 416;
  start: number;
  end: number;
  body: AsyncIterable<Uint8Array> | null;
}

export interface FileUseCaseOptions {
  /** The operator's cap for one video of a plain space (`FLUX_VIDEO_MAX_MIB`, C-61); `FILE_LIMITS.videoBytes` when unset. */
  videoBytes?: number;
  /** Decodes and re-encodes the picture a browser drew from a video (C-61); without it no poster is taken. */
  poster?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** The real decoder (#1343): every picture staged is decoded and written again first; without one, bytes are stored as they arrive. */
  pictures?: PictureCanonicalizer;
}

export function createFileUseCases(unit: FileUnitOfWork, storage: FileStorage, clock: () => Date = () => new Date(), options: FileUseCaseOptions = {}) {
  const videoCap = options.videoBytes ?? FILE_LIMITS.videoBytes;
  const pictures = options.pictures;
  /** The right to put a file in this place now: to write in the space, or in the direct message the person takes part in (#1438 point 10). */
  const writeTo = async (ports: FilePorts, principal: Principal, place: Place, placeId: string, lock = false): Promise<{ workspaceId: string }> => {
    if (place === 'project') return ports.access.requireProject(principal, 'write', placeId, ...(lock ? [{ lock: true as const }] : []));
    if (!ports.access.requireDm) throw new NotFoundError('Conversation', 'DM_NOT_FOUND');
    return ports.access.requireDm(principal, 'dm.write', placeId, ...(lock ? [{ lock: true as const }] : []));
  };
  /** The person's videos arriving now (C-61), by uploader. */
  const arriving = new Map<string, number>();
  /** Best effort: frees a reservation whose bytes never became ready. */
  const release = (projectId: string, uploader: ActorRef, fileId: string) => unit.run(async (ports) => {
    await ports.files.lockUploader(projectId, uploader);
    const row = await ports.files.findFile(fileId);
    if (row?.state === 'receiving') await ports.files.removeUnpublished(fileId);
  }).catch(() => { /* the reservation expires on its own */ });

  /** The caller's own ready, unsent video that a poster may be given (C-61), locked; anything else is the same unknown file. */
  async function posterTarget(ports: FilePorts, projectId: string, uploader: ActorRef, videoId: string): Promise<StoredFileRow> {
    const [video] = await ports.files.lockFiles([videoId]);
    if (!video || fileScopeOf(video) !== projectId || !same(video.uploader, uploader) || video.state !== 'ready' || !video.videoContainer
      || isPublished(video) || !video.expiresAt || video.expiresAt <= clock()) throw attachmentUnavailable();
    return video;
  }

  /** What a stored row says to a reader who may read it now (never the bytes). */
  async function readable(principal: Principal, fileId: string) {
    return unit.run(async (ports) => {
      const file = await ports.files.findFile(fileId);
      // A picture of an agent's answer in its private chat (#1217, C-59): no space's file; its owner's alone.
      if (!file) {
        const picture = await ports.runPictures?.find(fileId);
        if (!picture || principal.kind !== 'human' || principal.id !== picture.ownerUserId) throw unavailable();
        return { id: picture.id, name: picture.name, size: picture.size, sha256: picture.sha256, video: null as VideoContainer | null };
      }
      if (file.state !== 'ready' || file.size === null) throw unavailable();
      try {
        // A direct message's file is for its current people only (#1438 point 10); a space's for whoever may read the space.
        if (file.dmId !== null) {
          if (!ports.access.requireDm) throw unavailable();
          await ports.access.requireDm(principal, 'dm.read', file.dmId);
        } else await ports.access.requireProject(principal, 'read', file.projectId!);
      } catch (error) { if (error instanceof NotFoundError || error instanceof ForbiddenError) throw unavailable(); throw error; }
      if (!isPublished(file)) {
        const mine = principal.kind === 'human' && file.uploader.kind === 'human' && file.uploader.id === principal.id;
        if (!mine || !file.expiresAt || file.expiresAt <= clock()) throw unavailable();
      }
      return { id: file.id, name: file.name, size: file.size, sha256: file.sha256, video: file.videoContainer ?? null };
    });
  }

  /**
   * Stages one file for the signed-in person. The same uploadId with the same bytes and name returns the
   * original file; anything else under that uploadId conflicts, and one still arriving is UPLOAD_IN_PROGRESS.
   * A video (C-61) is a file named like one in a plain space: its first bytes must be a video container, and it may be up to the
   * operator's cap, with longer to arrive. A poster is a small file that belongs to one of the caller's staged videos.
   */
  async function stageBytes(principal: Principal, projectIdInput: string, query: { uploadId?: unknown; name?: unknown },
    bytes: AsyncIterable<Uint8Array>, declaredLength?: number, poster?: { videoId: string }, place: Place = 'project'): Promise<StagedFile> {
    // `projectId` is the id of the place the file goes to: a space's, or a direct message's (#1438 point 10).
    const projectId = id(projectIdInput, place === 'dm' ? 'dmId' : 'projectId').toLowerCase();
    const where = place === 'dm' ? { dmId: projectId } : { projectId };
    const uploadId = id(query.uploadId, 'uploadId').toLowerCase();
    const name = displayName(query.name);
    const uploader = uploaderOf(principal);
    const proposed = poster ? null : videoNameContainer(name);
    if (declaredLength !== undefined && declaredLength > (proposed ? videoCap : poster ? FILE_LIMITS.posterBytes : FILE_LIMITS.fileBytes))
      throw tooLarge(proposed ? videoCap : FILE_LIMITS.fileBytes, !!proposed);
    if (declaredLength === 0) throw new InvalidInputError('A file needs at least one byte', 'EMPTY_FILE');

    const admitted = await unit.run(async (ports) => {
      const project = await writeTo(ports, principal, place, projectId, true);
      await ports.files.lockUploader(projectId, uploader);
      const now = clock();
      const existing = await ports.files.findUpload(projectId, uploader, uploadId);
      if (existing?.state === 'ready' && (isPublished(existing) || (existing.expiresAt && existing.expiresAt > now))) {
        if (await ports.files.activeReplay(existing.id, now))
          throw new ConflictError('This upload is being verified', 'UPLOAD_IN_PROGRESS');
        const verification = await ports.files.reserve({ id: randomUUID(), workspaceId: project.workspaceId, ...where, uploader,
          uploadId: randomUUID(), name, reservedBytes: 0, replayOf: existing.id,
          expiresAt: new Date(now.getTime() + FILE_LIMITS.reservationMinutes * MINUTE) });
        return { replay: existing, verification, video: existing.videoContainer ?? null, reserveBytes: 0 };
      }
      if (existing && existing.expiresAt && existing.expiresAt > now)
        throw new ConflictError('This upload is still arriving', 'UPLOAD_IN_PROGRESS');
      // An abandoned reservation is replaced by a new row and id: its late finish cannot touch these bytes.
      if (existing) await ports.files.removeUnpublished(existing.id);
      // A video is one only in a plain space: a sealed object is one AES-GCM message that cannot be ranged, so an encrypted space keeps it an ordinary file (C-61).
      const video = proposed && !await ports.files.encrypted(project.workspaceId) ? proposed : null;
      const limit = video ? videoCap : poster ? FILE_LIMITS.posterBytes : FILE_LIMITS.fileBytes;
      if (declaredLength !== undefined && declaredLength > limit) throw tooLarge(limit, !!video);
      if (poster) {
        const target = await posterTarget(ports, projectId, uploader, poster.videoId);
        // A new poster replaces the one the video had.
        for (const old of await ports.files.postersOf(target.id)) await ports.files.removeUnpublished(old.id);
      }
      // A video reserves what its declared length says (a message may then carry its videos up to one cap together); anything else its limit.
      const reserveBytes = video ? Math.max(1, Math.min(declaredLength ?? limit, limit)) : limit;
      const quota = video ? await ports.files.stagedVideoBytes(projectId, uploader, now) + reserveBytes > videoCap
        : await ports.files.stagedBytes(projectId, uploader, now) + reserveBytes > FILE_LIMITS.stagedBytes;
      if (quota) throw new ConflictError(`Too many files are waiting to be sent in this ${place === 'dm' ? 'conversation' : 'space'}. Send or remove some first.`, 'UPLOAD_QUOTA_EXCEEDED');
      const arrival = (video ? FILE_LIMITS.videoReceiveSeconds * 1000 : 0) + FILE_LIMITS.reservationMinutes * MINUTE;
      const reserved = await ports.files.reserve({ id: randomUUID(), workspaceId: project.workspaceId, ...where, uploader, uploadId,
        name, reservedBytes: reserveBytes, expiresAt: new Date(now.getTime() + arrival), ...(video ? { videoContainer: video } : {}),
        ...(poster ? { posterOf: poster.videoId } : {}) });
      return { reserved, video, reserveBytes };
    });

    let received;
    // What the bytes say (#469) is read from the plaintext as it arrives, so it needs nothing of the stored object.
    const plaintext: Uint8Array[] = [];
    const head: VideoHead = { chunks: [], length: 0, container: null };
    try {
      const limits = { maxBytes: admitted.replay ? (admitted.video ? videoCap : FILE_LIMITS.fileBytes) : admitted.reserveBytes,
        deadline: Date.now() + (admitted.video ? FILE_LIMITS.videoReceiveSeconds : FILE_LIMITS.receiveSeconds) * 1000 };
      // A picture is decoded and written again before anything is stored or hashed, so a retry of the same upload finds the same bytes (#1343).
      // Never a video (C-61): its first bytes must be a video container, and a video is far larger than a picture may be held whole.
      const arriving = pictures && !admitted.video ? await canonicalUpload(bounded(bytes, limits), pictures) : bytes;
      received = admitted.replay ? await digestOnly(arriving, limits)
        : await storage.receive(admitted.video ? sniffed(arriving, head) : readsDetail(name) ? observed(arriving, plaintext) : arriving, limits, admitted.reserved!.id);
    } catch (error) {
      if (admitted.reserved ?? admitted.verification) await release(projectId, uploader, (admitted.reserved ?? admitted.verification)!.id);
      if (error instanceof FileTooLargeError) throw tooLarge(admitted.video ? videoCap : poster ? FILE_LIMITS.posterBytes : FILE_LIMITS.fileBytes, !!admitted.video);
      if (error instanceof FileReceiveTimeoutError) throw new InvalidInputError('The file did not arrive in time', 'UPLOAD_TIMEOUT');
      if (error instanceof NotAVideoError) throw new InvalidInputError('This is not a video Flux can play: an MP4, WebM or MOV file', 'NOT_A_VIDEO');
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
          await writeTo(ports, principal, place, projectId, true);
          await ports.files.lockUploader(projectId, uploader);
          const current = await ports.files.findUpload(projectId, uploader, uploadId);
          if (!current || current.id !== original.id || current.state !== 'ready'
            || (!isPublished(current) && (!current.expiresAt || current.expiresAt <= clock()))
            || !await storage.present(current.id, current.size!, current.keyVersion != null)) throw unavailable();
          if (original.size !== received.size || original.sha256 !== received.sha256 || original.name !== name)
            throw new ConflictError('This uploadId was used for another file', 'UPLOAD_CONFLICT');
          return staged({ ...current, expiresAt: current.expiresAt ?? new Date(current.readyAt!.getTime() + FILE_LIMITS.unpublishedDays * DAY) });
        });
      } finally { await release(projectId, uploader, admitted.verification!.id); }
    }

    const reservation = admitted.reserved!;
    const detail: FileDetail = admitted.video && head.container ? { ...fileDetailOf(`video.${head.container}`, Buffer.concat(head.chunks)), video: head.container }
      : plaintext.length ? fileDetailOf(name, Buffer.concat(plaintext)) : {};
    plaintext.length = 0; head.chunks.length = 0;
    try {
      return await unit.run(async (ports) => {
        await writeTo(ports, principal, place, projectId, true);
        await ports.files.lockUploader(projectId, uploader);
        const live = await ports.files.findFile(reservation.id);
        if (!live || live.state !== 'receiving' || !live.expiresAt || live.expiresAt <= clock())
          throw new ConflictError('The upload took too long; send the file again', 'UPLOAD_EXPIRED');
        // Only local rename/directory sync is inside this short generation fence. Network,
        // hash and file fsync finished in private scratch; cleanup cannot retire us mid-rename.
        await received.commit(reservation.id);
        const now = clock();
        const ready = await ports.files.markReady(reservation.id, { size: received.size, sha256: received.sha256, readyAt: now,
          expiresAt: new Date(now.getTime() + FILE_LIMITS.unpublishedDays * DAY), detail, keyVersion: 'keyVersion' in received ? received.keyVersion ?? null : null });
        if (ready === 'key_changed') throw new ConflictError('The space\'s key changed while the file was being sent; send it again', 'UPLOAD_KEY_CHANGED');
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
  }

  return {
    /**
     * A video may take 20 minutes to arrive, and its reservation can be as small as its declared length, so the bytes allowance alone
     * would let one person hold any number of slow uploads open: at most {@link VIDEO_ARRIVALS} of a person's videos arrive at once
     * (C-61), in this API process. The page sends one file at a time.
     */
    async stage(principal: Principal, projectId: string, query: { uploadId?: unknown; name?: unknown }, bytes: AsyncIterable<Uint8Array>, declaredLength?: number, place: Place = 'project') {
      if (typeof query.name !== 'string' || !videoNameContainer(query.name)) return stageBytes(principal, projectId, query, bytes, declaredLength, undefined, place);
      const uploader = uploaderOf(principal);
      const key = `${uploader.kind}:${uploader.id}`;
      const count = arriving.get(key) ?? 0;
      if (count >= VIDEO_ARRIVALS) throw new RateLimitedError(30, `${VIDEO_ARRIVALS} of your videos are already arriving. Wait for one to finish.`, 'UPLOADS_BUSY');
      arriving.set(key, count + 1);
      try { return await stageBytes(principal, projectId, query, bytes, declaredLength, undefined, place); }
      finally { const left = (arriving.get(key) ?? 1) - 1; if (left > 0) arriving.set(key, left); else arriving.delete(key); }
    },

    /** What this instance accepts: the operator's video cap is the one number that varies (C-61). */
    limits: (): FileLimits => ({ fileBytes: FILE_LIMITS.fileBytes, videoBytes: videoCap, messageFiles: FILE_LIMITS.messageFiles, messageBytes: FILE_LIMITS.messageBytes }),

    /**
     * Gives the caller's staged video its poster (C-61): the picture the browser drew is decoded and re-encoded as a small WebP (never
     * kept as sent), and stored as a file of the same space that follows the video to its message. A second poster replaces the first.
     */
    async stagePoster(principal: Principal, projectIdInput: string, videoIdInput: string, bytes: AsyncIterable<Uint8Array>, declaredLength?: number, place: Place = 'project'): Promise<StagedFile> {
      const projectId = id(projectIdInput, place === 'dm' ? 'dmId' : 'projectId').toLowerCase();
      const videoId = id(videoIdInput, 'fileId').toLowerCase();
      const uploader = uploaderOf(principal);
      if (!options.poster) throw new NotFoundError('Poster', 'POSTER_UNAVAILABLE');
      if (declaredLength !== undefined && declaredLength > FILE_LIMITS.posterBytes) throw new PayloadTooLargeError('A poster is at most 512 KiB', 'POSTER_TOO_LARGE');
      // The right to write here and to this video are checked before a picture is decoded: decoding is the work to keep from strangers.
      await unit.run(async (ports) => {
        await writeTo(ports, principal, place, projectId);
        await posterTarget(ports, projectId, uploader, videoId);
      });
      let raw: Buffer;
      try { raw = await collect(bytes, FILE_LIMITS.posterBytes); }
      catch (error) {
        if (error instanceof FileTooLargeError) throw new PayloadTooLargeError('A poster is at most 512 KiB', 'POSTER_TOO_LARGE');
        if (error instanceof FileReceiveTimeoutError) throw new InvalidInputError('The picture did not arrive in time', 'UPLOAD_TIMEOUT');
        throw error;
      }
      if (!raw.length) throw new InvalidInputError('A poster needs at least one byte', 'EMPTY_FILE');
      const picture = await options.poster(raw);
      return stageBytes(principal, projectId, { uploadId: randomUUID(), name: 'poster.webp' }, Readable.from([Buffer.from(picture)]), picture.byteLength, { videoId }, place);
    },

    /**
     * A file's bytes, after current access: a published file to anyone who can read its project now, an
     * unpublished one only to its uploader. Missing or corrupt bytes are unavailable, never served. At most the ordinary file limit:
     * a video is served by `open`.
     */
    async download(principal: Principal, fileIdInput: string): Promise<{ name: string; size: number; bytes: Uint8Array }> {
      const row = await readable(principal, id(fileIdInput, 'fileId').toLowerCase());
      const bytes = await storage.read(row.id);
      if (!bytes || bytes.byteLength !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw unavailable();
      return { name: row.name, size: row.size, bytes };
    },

    /**
     * A file as a stream, whole or one byte range of it (C-61), after the same current access check as `download`, made on every call
     * (every range of a playing video included). A file of the ordinary size (up to 5 MiB, a small video too) is read whole and its SHA-256
     * verified on every read, as every file always was (a sealed one has its tag verified), and a range is cut from those bytes. A video
     * over that size is read from disk a chunk at a time with its size checked (its digest, computed as it arrived, is verified in the
     * export bundle; #1411), so no request holds it in memory. `head` checks and returns no body; `video` insists the file is one a browser may
     * play (else it is not found); a range past the end gives status 416.
     */
    async open(principal: Principal, fileIdInput: string, request: { range?: string; video?: boolean; head?: boolean } = {}): Promise<OpenedFile> {
      const row = await readable(principal, id(fileIdInput, 'fileId').toLowerCase());
      if (request.video && !row.video) throw new NotFoundError('Video', 'FILE_NO_VIDEO');
      const range = parseRange(request.range, row.size);
      const base = { name: row.name, size: row.size, video: row.video };
      if (range.kind === 'unsatisfiable') return { ...base, status: 416, start: 0, end: 0, body: null };
      const partial = range.kind === 'partial';
      const start = partial ? range.start : 0;
      const end = partial ? range.end : row.size - 1;
      const opened = { ...base, status: partial ? 206 as const : 200 as const, start, end };
      const large = row.size > FILE_LIMITS.fileBytes;
      if (request.head) {
        if (!await storage.has(row.id, row.size, large ? undefined : row.sha256 ?? undefined)) throw unavailable();
        return { ...opened, body: null };
      }
      const stream = large ? await storage.stream(row.id, { size: row.size, start, end }) : null;
      if (stream) return { ...opened, body: stream };
      const bytes = await storage.read(row.id);
      if (!bytes || bytes.byteLength !== row.size || createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw unavailable();
      return { ...opened, body: Readable.from([Buffer.from(bytes.subarray(start, end + 1))]) };
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
        const uploaders = [...new Map(candidates.map((row) => [`${fileScopeOf(row)}:${row.uploader.kind}:${row.uploader.id}`, row])).entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, row]) => row);
        for (const row of uploaders) await ports.files.lockUploader(fileScopeOf(row), row.uploader);
        const gone: StoredFileRow[] = [];
        for (const row of await ports.files.lockFiles(candidates.map((candidate) => candidate.id))) {
          if (isPublished(row) || !row.expiresAt || row.expiresAt > now) continue;
          if (await ports.files.removeUnpublished(row.id)) gone.push(row);
        }
        return gone;
      });
      // Retired objects stay in a durable queue until unlink and directory fsync both succeed.
      // A crash or I/O failure cannot strand an object that cleanup can no longer discover.
      // A deleted space queues all its files at once (#874): the queue is drained in batches within one sweep, not one batch every ten minutes (#908).
      for (let batch = 0; batch < GARBAGE_BATCHES_PER_SWEEP; batch += 1) {
        const garbage = await unit.run((ports) => ports.files.pendingGarbage(limit));
        const deleted: string[] = [];
        for (const id of garbage) {
          try { await storage.remove(id); deleted.push(id); } catch { /* retry the durable tombstone next sweep */ }
        }
        if (deleted.length) await unit.run((ports) => ports.files.forgetGarbage(deleted));
        // A failed object is first in the queue again: leave it for the next sweep. A batch that was not full ended the queue.
        if (deleted.length < garbage.length || garbage.length < limit) break;
      }
      await storage.sweepScratch(FILE_LIMITS.reservationMinutes * MINUTE);
      return removed.length;
    },
  };
}
