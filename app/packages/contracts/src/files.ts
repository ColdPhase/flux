/**
 * Stored files (#154): bytes a person stages privately, then attaches to exactly one message. Contract:
 * docs/development/task-discussions/2026-10-01-contribution-effects-and-files.md ("Real bytes and
 * attachment-only contribution" and its recorded corrections).
 *
 * Staging is `POST projectFilesPath(projectId)?uploadId=<uuid>&name=<display name>` with the raw bytes as
 * `application/octet-stream`. Downloads are `GET filePath(id)`: always an attachment, `nosniff`, private and
 * not stored; current access is checked on every download. A staged, unpublished file is its uploader's only.
 */
export const projectFilesPath = (projectId: string) => `/api/v1/projects/${projectId}/files`;
export const filePath = (fileId: string) => `/api/v1/files/${fileId}`;

export const FILE_LIMITS = {
  /** One file: 1 byte to 5 MiB. Empty files are refused. */
  fileBytes: 5 * 1024 * 1024,
  /** One message: at most 10 files and 20 MiB together. */
  messageFiles: 10,
  messageBytes: 20 * 1024 * 1024,
  /** Display name: 1–200 characters, no control or path characters, never "." or "..". */
  nameChars: 200,
  /** Live staged bytes per uploader and project: uploads in progress plus ready unpublished files. */
  stagedBytes: 100 * 1024 * 1024,
  /** The bytes of one upload must arrive within this time. */
  receiveSeconds: 30,
  /** An upload that never finished frees its reservation after this. */
  reservationMinutes: 15,
  /** A ready file that was never attached is removed this long after it became ready. */
  unpublishedDays: 7,
} as const;

/** A file staged by the signed-in person, ready to attach. */
export interface StagedFile {
  id: string;
  projectId: string;
  /** The client's upload UUID; the same upload again returns this file. */
  uploadId: string;
  name: string;
  size: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256: string;
  readyAt: string;
  /** When it is removed if it is not attached to a message by then. */
  expiresAt: string;
}

/** A file attached to a message: readable name and size. The bytes download from `filePath(id)`. */
export interface MessageFile {
  id: string;
  name: string;
  size: number;
}
