import type { SearchText } from '@flux/contracts';

// A result's snippet is a slice of the body, so it can carry Markdown (headings, tables, emphasis, links).
// The row shows it as one plain line (#514). The matched parts are marked with private-use sentinels while the
// text is cleaned, so a highlight never splits a Markdown token and stays in place after the cleaning.

const OPEN = '\uE000';
const CLOSE = '\uE001';

function clean(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/<[^>]+>/g, '')
    // Block markers at the start of a line: headings, quotes, list bullets, numbered lists.
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm, '')
    // Table separator rows, then the cell pipes.
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|/gm, '').replace(/\|[ \t]*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ' · ')
    // Images and links keep their words; code, emphasis and strike-through markers go.
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?![\w])/g, '$1$2')
    .replace(/\\([\\`*_{}[\]()#+\-.!|~])/g, '$1');
}

/** The snippet as one line of plain text with its matches marked, or null when nothing readable is left. */
export function plainSnippet(parts: SearchText | null): SearchText | null {
  if (!parts?.length) return null;
  const marked = parts.map((part) => (part.match ? `${OPEN}${part.text.replace(/[\uE000\uE001]/g, '')}${CLOSE}` : part.text.replace(/[\uE000\uE001]/g, ''))).join('');
  const flat = clean(marked).replace(/\s+/g, ' ');
  const out: SearchText = [];
  let match = false;
  for (const piece of flat.split(/([\uE000\uE001])/)) {
    if (piece === OPEN) { match = true; continue; }
    if (piece === CLOSE) { match = false; continue; }
    if (!piece) continue;
    const last = out[out.length - 1];
    if (last && last.match === match) last.text += piece;
    else out.push({ text: piece, match });
  }
  // Trim the line's ends, keeping the marks.
  if (out[0]) out[0].text = out[0].text.replace(/^\s+/, '');
  const end = out[out.length - 1];
  if (end) end.text = end.text.replace(/\s+$/, '');
  const kept = out.filter((part) => part.text.length);
  return kept.length && kept.some((part) => part.text.trim()) ? kept : null;
}
