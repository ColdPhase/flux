import { plainMessageText } from '@flux/contracts';

/**
 * A message's words as plain text for the clipboard (Copy text, founder direction 2026-11-08): what a reader sees, with no markup. A
 * mention stays `@Name` and a task `#4`; a Wiki page `[[Title]]` is its title; a quoted block loses its `> ` marks and keeps its
 * attribution line ("Ada:"); bold, italic and code lose their marks and a code block is its code, a list keeps "- " and "1. " (#1247). Nothing is added.
 */
export function plainWords(body: string): string {
  return plainMessageText(body).replace(/\[\[([^\]\n]{1,120})\]\]/g, '$1').trim();
}
