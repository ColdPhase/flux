/**
 * The files whose text Flux reads for search (C-63): PDF, DOCX, and text (plain, log, Markdown, CSV, TSV). The same list is in the database
 * (`file_text_extractable`, migration 0072); a test compares them. A name is the only thing it goes by here; the worker checks the bytes too.
 */
export const FILE_TEXT_EXTENSIONS = ['pdf', 'docx', 'md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv'] as const;
export type FileTextFormat = 'pdf' | 'docx' | 'text';

export function fileTextFormat(name: string): FileTextFormat | null {
  const dot = name.lastIndexOf('.');
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!(FILE_TEXT_EXTENSIONS as readonly string[]).includes(extension)) return null;
  return extension === 'pdf' ? 'pdf' : extension === 'docx' ? 'docx' : 'text';
}

/**
 * The pictures OCR reads (C-70, #1575), by name as the database's `file_ocr_picture` (migration 0104); the worker checks the bytes too
 * (`cleanPicture`, C-59). A GIF is read by its first frame.
 */
export const FILE_OCR_PICTURE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'] as const;
export function isOcrPicture(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return dot >= 0 && (FILE_OCR_PICTURE_EXTENSIONS as readonly string[]).includes(name.slice(dot + 1).toLowerCase());
}
