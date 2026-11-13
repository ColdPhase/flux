import type { FileDetail, MessageFile, VideoContainer } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { ActorRef, WorkAccess } from '../work/ports.js';

/** One stored file row (#154). Bytes are in the FileStorage under `id`. */
export interface StoredFileRow {
  id: string;
  workspaceId: string;
  /** The space the file belongs to; null for a direct message's file (#1438 point 10), which names `dmId` instead: exactly one is set. */
  projectId: string | null;
  dmId: string | null;
  uploader: ActorRef;
  uploadId: string;
  name: string;
  state: 'receiving' | 'ready';
  reservedBytes: number;
  size: number | null;
  sha256: string | null;
  createdAt: Date;
  readyAt: Date | null;
  /** Null once published. */
  expiresAt: Date | null;
  messageId: string | null;
  /** The message of a direct message a file is attached to (#1438 point 10); `messageId` names a space's. */
  dmMessageId?: string | null;
  position: number | null;
  /** #252: the map thought this file is the image of. A file is published to a message or a thought, never both. */
  thoughtId: string | null;
  publishedAt: Date | null;
  /** #469: what the bytes said at upload; null (or absent) when the kind is not read or they did not say. */
  pageCount?: number | null;
  rowCount?: number | null;
  durationMs?: number | null;
  /** C-61: the container a video's bytes were recognised as (set when the reservation is made as a video, confirmed when it is ready); null for any other file. */
  videoContainer?: VideoContainer | null;
  /** C-61: the staged video this file is the poster of; such a file is no attachment of its own and follows its video to the message. */
  posterOf?: string | null;
  /** F-030: the key version an encrypted workspace's object is sealed under; null (or absent) for a plain object. */
  keyVersion?: number | null;
}

/** Rows only; the use cases decide. Every method runs in the caller's transaction. */
export interface FileRepository {
  /**
   * Serializes one uploader's admission, finalization and cleanup in one place (quota and upload id). `placeId` is a space's id or a direct
   * message's (#1438 point 10); they are UUIDs of different tables, so one id names exactly one.
   */
  lockUploader(placeId: string, uploader: ActorRef): Promise<void>;
  activeReplay(fileId: string, now: Date): Promise<boolean>;
  findUpload(placeId: string, uploader: ActorRef, uploadId: string): Promise<StoredFileRow | null>;
  /** Unexpired reservations plus unexpired ready unpublished files of this uploader in this place, in bytes; the videos of C-61 are counted apart. */
  stagedBytes(placeId: string, uploader: ActorRef, now: Date): Promise<number>;
  /** The same for this uploader's videos only. */
  stagedVideoBytes(placeId: string, uploader: ActorRef, now: Date): Promise<number>;
  reserve(input: { id: string; workspaceId: string; projectId?: string; dmId?: string; uploader: ActorRef; uploadId: string; name: string;
    reservedBytes: number; expiresAt: Date; replayOf?: string; videoContainer?: VideoContainer; posterOf?: string }): Promise<StoredFileRow>;
  /** Whether this workspace is encrypted (F-030): its files are sealed and never played (C-61). */
  encrypted(workspaceId: string): Promise<boolean>;
  /** The posters (C-61) of this staged video, any state. */
  postersOf(videoId: string): Promise<StoredFileRow[]>;
  findFile(id: string): Promise<StoredFileRow | null>;
  /** These rows, unlocked and in no particular order (outside any transaction: #1411's check of a message's file bytes before it opens). */
  findFiles(ids: readonly string[]): Promise<StoredFileRow[]>;
  /** Marks a still-receiving reservation ready; false when it is gone or no longer receiving. */
  /**
   * Under the workspace's key share lock (F-030 S2c): `key_changed` when the object's key version is no longer live (a
   * rotation finished while it was sent), so the upload is refused instead of storing bytes nobody can open.
   */
  markReady(id: string, input: { size: number; sha256: string; readyAt: Date; expiresAt: Date; detail?: FileDetail; keyVersion?: number | null }): Promise<boolean | 'key_changed'>;
  /** Removes an unpublished row (a failed or abandoned upload). Published rows are never removed. */
  removeUnpublished(id: string): Promise<boolean>;
  /** Locks these rows FOR UPDATE in ascending id order and returns the ones that exist. */
  lockFiles(ids: readonly string[]): Promise<StoredFileRow[]>;
  /** Up to `limit` unpublished rows whose expiry has passed, oldest expiry first. Not locked. */
  expired(now: Date, limit: number): Promise<StoredFileRow[]>;
  /** The published files of these messages, each list in attachment order. */
  /** Durable deletion queue: rows are retired atomically before any physical deletion. */
  pendingGarbage(limit: number): Promise<string[]>;
  forgetGarbage(ids: readonly string[]): Promise<void>;
  messageFiles(messageIds: readonly string[]): Promise<Map<string, MessageFile[]>>;
  /** #252: publishes a ready, unpublished file as the image of one map thought; false when it is not both. */
  publishToThought(id: string, thoughtId: string, publishedAt: Date): Promise<boolean>;
}

/** Bytes received into owned private scratch, measured and hashed, not yet durable under a final id. */
export interface ReceivedFile {
  size: number;
  /** Lowercase hex SHA-256. */
  sha256: string;
  /** The key version the stored object is sealed under (F-030 S2c); absent for a plain workspace. */
  keyVersion?: number | null;
  /** Makes the bytes durable as the immutable object `objectId` (fsync, atomic rename, directory fsync). */
  commit(objectId: string): Promise<void>;
  /** Removes the scratch bytes; safe after a failed commit. */
  discard(): Promise<void>;
}

export class FileTooLargeError extends Error {}
export class FileReceiveTimeoutError extends Error {}

/**
 * The files volume (#154). An adapter must make committed objects durable before `commit` resolves and
 * must never follow symlinks; one that cannot must not be used.
 */
export interface FileStorage {
  /** Streams into private scratch, refusing more than `maxBytes` (FileTooLargeError) or past `deadline` (FileReceiveTimeoutError). */
  receive(bytes: AsyncIterable<Uint8Array>, limits: { maxBytes: number; deadline: number },
    /**
     * F-030: the reservation id the bytes will be committed under. For an encrypted workspace's file the adapter seals
     * the bytes as they arrive (size and SHA-256 stay those of the plaintext), so plaintext never reaches the scratch.
     */
    objectId?: string): Promise<ReceivedFile>;
  /** The object's bytes, or null when it is missing. At most the ordinary file limit; a video is streamed (`stream`). */
  read(objectId: string): Promise<Uint8Array | null>;
  /**
   * C-61: bytes `start` to `end` (inclusive) of a plain object whose size is exactly `size`, as a stream that holds one chunk at a
   * time; null when it is missing, has another size, or is sealed (a sealed object is opened whole by `read`).
   */
  stream(objectId: string, range: { size: number; start: number; end: number }): Promise<AsyncIterable<Uint8Array> | null>;
  /** Whether immutable bytes exist with exactly this size and, when supplied, SHA-256 (a plain object is hashed as a stream, never held whole). */
  has(objectId: string, size: number, sha256?: string): Promise<boolean>;
  /**
   * #1411: whether the object is on disk as a regular file holding exactly `size` bytes of content (a sealed object's header and tag
   * on top), from the file system's metadata alone: no byte is read and no database is asked. This is the only check of the bytes a
   * message's transaction makes (`lockAttachments`): a digest is computed once, as the upload arrives, and verified where bytes are read.
   */
  present(objectId: string, size: number, sealed: boolean): Promise<boolean>;
  /** Removes the object durably; a missing object is not an error. */
  remove(objectId: string): Promise<void>;
  /** Removes scratch files older than this age (abandoned receives). */
  sweepScratch(olderThanMs: number): Promise<number>;
}

/** #1217 (C-59): a picture an agent attached to its answer in its private chat, the run's owner's alone. */
export interface RunPictureRepository {
  find(id: string): Promise<{ id: string; ownerUserId: string; name: string; size: number; sha256: string } | null>;
}

export interface FilePorts {
  access: Pick<WorkAccess, 'requireProject'> & {
    /**
     * #1438 point 10: throws NotFoundError unless the principal is a current participant of this direct message who may `read` or `write` it;
     * `lock` (inside a change) holds the conversation and the person's place in it until the unit of work ends. Absent where no direct
     * message's file is served.
     */
    requireDm?(principal: Principal, action: 'dm.read' | 'dm.write', dmId: string, options?: { lock?: boolean }): Promise<{ workspaceId: string }>;
  };
  files: FileRepository;
  /** Absent where no chat picture is served. */
  runPictures?: RunPictureRepository;
}
export interface FileUnitOfWork {
  run<T>(action: (ports: FilePorts) => Promise<T>): Promise<T>;
}
