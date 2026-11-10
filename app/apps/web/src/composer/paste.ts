// Pasting into the composer (Ctrl/⌘ V): a screenshot, a copied picture or copied files attach to the draft, as the
// paperclip and a drop do (#348). Text keeps its own paste. Pure, so the rule can be tested without a browser.

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const two = (value: number) => String(value).padStart(2, '0');

/** A name for a picture that came without one (a screenshot is "image.png" in every browser): "Pasted image 2026-11-10 21.30.png". */
export function pastedFileName(file: File, at = new Date()): string {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!generic || !file.type.startsWith('image/')) return file.name;
  const extension = EXTENSIONS[file.type] ?? file.name.split('.').pop() ?? 'png';
  return `Pasted image ${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}.${two(at.getMinutes())}.${extension}`;
}

/**
 * The files a paste should attach, or none when the paste is text. A clipboard with files and no text (a screenshot,
 * "Copy image" in a browser) attaches them. One with text as well pastes the text, unless that text only names the
 * copied files (a file manager puts their names beside them): a spreadsheet's cells come with a picture of the cells,
 * and the person wanted the text.
 */
export function pastedFiles(data: Pick<DataTransfer, 'files' | 'items' | 'getData'> | null, at = new Date()): File[] {
  if (!data) return [];
  const found: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) found.push(file);
  }
  if (!found.length) found.push(...Array.from(data.files ?? []));
  if (!found.length) return [];
  const text = (data.getData('text/plain') ?? '').trim();
  if (text) {
    const names = new Set(found.map((file) => file.name));
    const lines = text.split(/\r\n|\r|\n/).map((line) => line.trim().split(/[\\/]/).pop() ?? '').filter(Boolean);
    if (!lines.every((line) => names.has(line))) return [];
  }
  return found.map((file) => {
    const name = pastedFileName(file, at);
    return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
}
