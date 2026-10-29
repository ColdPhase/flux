/**
 * What a file is, from its name alone (#348): the page icon's pictogram and mono label, and the word
 * in "type · size". Only a display hint: a photo is shown as one only after its bytes are checked.
 */
export type FileKind = 'pdf' | 'table' | 'sheet' | 'document' | 'markdown' | 'code' | 'archive' | 'audio' | 'video' | 'image' | 'other';

const BY_EXTENSION: Record<string, FileKind> = {
  pdf: 'pdf', csv: 'table', tsv: 'table', xlsx: 'sheet', xls: 'sheet', ods: 'sheet', numbers: 'sheet',
  docx: 'document', doc: 'document', odt: 'document', rtf: 'document', txt: 'document', pages: 'document',
  md: 'markdown', markdown: 'markdown',
  py: 'code', ts: 'code', tsx: 'code', js: 'code', jsx: 'code', json: 'code', go: 'code', rs: 'code', rb: 'code', java: 'code',
  kt: 'code', swift: 'code', c: 'code', h: 'code', cpp: 'code', cs: 'code', php: 'code', sh: 'code', sql: 'code', yaml: 'code',
  yml: 'code', toml: 'code', html: 'code', css: 'code', xml: 'code', ino: 'code',
  zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', '7z': 'archive', rar: 'archive',
  m4a: 'audio', mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', aac: 'audio', flac: 'audio', weba: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video', m4v: 'video',
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', heic: 'image', avif: 'image', svg: 'image', bmp: 'image', tif: 'image', tiff: 'image',
};

const WORD: Record<FileKind, string> = {
  pdf: 'PDF', table: 'Table', sheet: 'Sheet', document: 'Document', markdown: 'Markdown', code: 'Code',
  archive: 'Archive', audio: 'Audio', video: 'Video', image: 'Image', other: 'File',
};

/** Images the viewer may show: their bytes are checked with `imageTypeOf`, never trusted by name. SVG is never one. */
const PHOTO = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

export const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
};
export const fileKind = (name: string): FileKind => BY_EXTENSION[extensionOf(name)] ?? 'other';
export const fileWord = (kind: FileKind) => WORD[kind];
/** The mono label under the fold: the extension for most kinds, FILE when there is none to show. */
export function fileLabel(name: string): string {
  const ext = extensionOf(name);
  const kind = fileKind(name);
  if (kind === 'other' || !ext || ext.length > 4) return 'FILE';
  return ext === 'jpeg' ? 'JPG' : ext.toUpperCase();
}
/** Named like a photo (a hint only; the bytes decide). */
export const looksLikePhoto = (name: string) => PHOTO.has(extensionOf(name));

/** A playing time as the voice note shows it: 0:42, or 1:05:09 from an hour on. */
export function playTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const rest = String(seconds % 60).padStart(2, '0');
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${rest}` : `${Math.floor(seconds / 60)}:${rest}`;
}

/** The "detail" of "type · detail · size" (#469): pages, data rows or playing time, as the server read them from the bytes; empty when it did not. */
export function detailLine(detail: { pages?: number; rows?: number; durationMs?: number } | undefined): string {
  if (!detail) return '';
  if (detail.pages !== undefined) return `${detail.pages} ${detail.pages === 1 ? 'page' : 'pages'}`;
  if (detail.rows !== undefined) return `${detail.rows} ${detail.rows === 1 ? 'row' : 'rows'}`;
  if (detail.durationMs !== undefined) return playTime(detail.durationMs);
  return '';
}
