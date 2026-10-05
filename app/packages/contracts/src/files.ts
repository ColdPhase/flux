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

/** A system preview; the stored authored message body remains unchanged. */
export function messagePreview(body: string, count = 0): string {
  return body || (count === 1 ? '1 attached file' : count > 1 ? `${count} attached files` : '');
}

/** Images a map thought may show (#252): checked by their bytes' signature, never by name or a declared type. SVG is never one. */
export type ThoughtImageType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
export const THOUGHT_IMAGE_TYPES: readonly ThoughtImageType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** The image type these bytes start with, or null for anything else (including SVG, which can carry script). */
export function imageTypeOf(bytes: Uint8Array): ThoughtImageType | null {
  const starts = (...signature: number[]) => signature.every((value, index) => bytes[index] === value);
  if (bytes.length >= 8 && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (bytes.length >= 3 && starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (bytes.length >= 6 && (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  if (bytes.length >= 12 && starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
  return null;
}
