import type { MessageFile } from '@flux/contracts';
import type { ActorRef, WorkAccess } from '../work/ports.js';

/** One stored file row (#154). Bytes are in the FileStorage under `id`. */
export interface StoredFileRow {
  id: string;
  workspaceId: string;
  projectId: string;
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
  position: number | null;
}

/** Rows only; the use cases decide. Every method runs in the caller's transaction. */
export interface FileRepository {
  /** Serializes one uploader's admission, finalization and cleanup in one project (quota and upload id). */
  lockUploader(projectId: string, uploader: ActorRef): Promise<void>;
  findUpload(projectId: string, uploader: ActorRef, uploadId: string): Promise<StoredFileRow | null>;
  /** Unexpired reservations plus unexpired ready unpublished files of this uploader in this project, in bytes. */
  stagedBytes(projectId: string, uploader: ActorRef, now: Date): Promise<number>;
  reserve(input: { id: string; workspaceId: string; projectId: string; uploader: ActorRef; uploadId: string; name: string;
    reservedBytes: number; expiresAt: Date }): Promise<StoredFileRow>;
  findFile(id: string): Promise<StoredFileRow | null>;
  /** Marks a still-receiving reservation ready; false when it is gone or no longer receiving. */
  markReady(id: string, input: { size: number; sha256: string; readyAt: Date; expiresAt: Date }): Promise<boolean>;
  /** Removes an unpublished row (a failed or abandoned upload). Published rows are never removed. */
  removeUnpublished(id: string): Promise<boolean>;
  /** Locks these rows FOR UPDATE in ascending id order and returns the ones that exist. */
  lockFiles(ids: readonly string[]): Promise<StoredFileRow[]>;
  /** Up to `limit` unpublished rows whose expiry has passed, oldest expiry first. Not locked. */
  expired(now: Date, limit: number): Promise<StoredFileRow[]>;
  /** The published files of these messages, each list in attachment order. */
  messageFiles(messageIds: readonly string[]): Promise<Map<string, MessageFile[]>>;
}

/** Bytes received into owned private scratch, measured and hashed, not yet durable under a final id. */
export interface ReceivedFile {
  size: number;
  /** Lowercase hex SHA-256. */
  sha256: string;
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
  receive(bytes: AsyncIterable<Uint8Array>, limits: { maxBytes: number; deadline: number }): Promise<ReceivedFile>;
  /** The object's bytes, or null when it is missing. */
  read(objectId: string): Promise<Uint8Array | null>;
  /** Whether the object exists with exactly this size. */
  has(objectId: string, size: number): Promise<boolean>;
  /** Removes the object durably; a missing object is not an error. */
  remove(objectId: string): Promise<void>;
  /** Removes scratch files older than this age (abandoned receives). */
  sweepScratch(olderThanMs: number): Promise<number>;
}

export interface FilePorts {
  access: Pick<WorkAccess, 'requireProject'>;
  files: FileRepository;
}
export interface FileUnitOfWork {
  run<T>(action: (ports: FilePorts) => Promise<T>): Promise<T>;
}
