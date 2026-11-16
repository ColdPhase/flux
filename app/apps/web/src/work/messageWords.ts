import { plainPreviewText } from '@flux/contracts';

/**
 * A message's words as plain text for the clipboard (Copy text, founder direction 2026-11-08): what a reader sees, with no markup. A
 * mention stays `@Name` and a task `#4`; a Wiki page `[[Title]]` is its title; a quoted block loses its `> ` marks and keeps its
 * attribution line ("Ada:"); bold, italic and code lose their marks and a code block is its code, a list keeps "- " and "1. " (#1247). Nothing is
 * added, and no cite mark's id is kept (C-62).
 */
export function plainWords(body: string): string {
  return plainPreviewText(body);
}
