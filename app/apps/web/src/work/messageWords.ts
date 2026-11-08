/**
 * A message's words as plain text for the clipboard (Copy text, founder direction 2026-11-08): what a reader sees, with no markup. A
 * mention stays `@Name` and a task `#4`; a Wiki page `[[Title]]` is its title; a quoted block loses its `> ` marks and keeps its
 * attribution line ("Ada:"). Nothing is added.
 */
export function plainWords(body: string): string {
  return body.split('\n').map((line) => line.replace(/^>\s?/, '')).join('\n').replace(/\[\[([^\]\n]{1,120})\]\]/g, '$1').trim();
}
