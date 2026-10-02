import { DOC_LIMITS } from '@flux/contracts';

// Markdown files in and out of the wiki (#136, UI116-4). A downloaded page is its title as a
// level-1 heading followed by the Markdown text exactly as saved; importing that file gives the
// same title and text back. Nothing here talks to the server.

/** A page holds DOC_LIMITS.body characters; UTF-8 needs at most 4 bytes for each. */
export const IMPORT_MAX_BYTES = DOC_LIMITS.body * 4;

const MARKDOWN_NAME = /\.(md|markdown)$/i;
const number = new Intl.NumberFormat('en-GB');

export type ImportedPage = { ok: true; title: string; body: string } | { ok: false; error: string };

function sizeLabel(bytes: number) {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
}

/** The file name without its Markdown extension, as words: "bench-notes.md" → "Bench notes". */
function titleFromName(name: string) {
  const words = name.replace(MARKDOWN_NAME, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words[0]!.toLocaleUpperCase() + words.slice(1) : '';
}

/** A leading `# Title` line becomes the page title; otherwise the file name does. */
export function splitTitle(text: string, fileName: string): { title: string; body: string } {
  const lines = text.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  const heading = first >= 0 ? /^ {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[first]!) : null;
  if (heading) {
    const rest = lines.slice(first + 1);
    while (rest.length && rest[0]!.trim() === '') rest.shift();
    return { title: heading[1]!.trim(), body: rest.join('\n') };
  }
  return { title: titleFromName(fileName), body: text };
}

function clip(value: string, limit: number) {
  const chars = [...value];
  return chars.length > limit ? chars.slice(0, limit).join('').trimEnd() : value;
}

/**
 * Reads a chosen file as a new page, or says plainly why it cannot become one: only .md or
 * .markdown text in UTF-8, not empty, and within the page length the server accepts.
 */
export async function readMarkdownFile(file: File): Promise<ImportedPage> {
  const name = file.name || 'The file';
  const quoted = `“${name}”`;
  const textType = !file.type || file.type.startsWith('text/') || file.type === 'application/octet-stream';
  if (!MARKDOWN_NAME.test(file.name) || !textType) return { ok: false, error: `${quoted} is not a Markdown file. Choose a .md file.` };
  if (!file.size) return { ok: false, error: `${quoted} is empty. Choose a .md file with text in it.` };
  if (file.size > IMPORT_MAX_BYTES) {
    return { ok: false, error: `${quoted} is too large (${sizeLabel(file.size)}). A page holds up to ${number.format(DOC_LIMITS.body)} characters.` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
  } catch {
    return { ok: false, error: `${quoted} is not readable UTF-8 text, so it cannot become a page.` };
  }
  if (text.includes('\u0000')) return { ok: false, error: `${quoted} is not readable UTF-8 text, so it cannot become a page.` };
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const { title, body } = splitTitle(text, file.name);
  if (body.length > DOC_LIMITS.body) {
    return { ok: false, error: `${quoted} has ${number.format(body.length)} characters. A page holds up to ${number.format(DOC_LIMITS.body)}.` };
  }
  return { ok: true, title: clip(title, DOC_LIMITS.title) || 'Imported page', body };
}

/** The page as one Markdown file: `# Title`, a blank line, then the saved text. */
export function pageMarkdown(title: string, body: string) {
  const text = body.replace(/\s+$/, '');
  return text ? `# ${title}\n\n${text}\n` : `# ${title}\n`;
}

/** A file name from a title, keeping letters of every script: "Jak działa lampka" → "jak-działa-lampka.md". */
export function pageFileName(title: string, version?: number) {
  const slug = clip(title.toLocaleLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, ''), 80).replace(/-+$/, '');
  return `${slug || 'page'}${version ? `-v${version}` : ''}.md`;
}

/** Hands the browser a file to save, without a server round trip. */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
