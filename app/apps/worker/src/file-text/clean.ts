/**
 * Text as it is kept for search (C-63): the same lines, without what a search or a snippet cannot use. Runs in the sandboxed child, over text a
 * stranger wrote, so every step is linear in its length (no pattern can backtrack across a long run, and each line is handled alone).
 */
export function cleanText(text: string): string {
  const normalised = text.replace(/\p{Cc}|[\u200b\ufeff\u00ad]/gu, (char) => (char === '\n' || char === '\t' || char === '\r' ? char : char === '\f' ? '\n' : '')).replace(/\r\n?|\u2028|\u2029/g, '\n');
  // NFKC folds ligatures (the "fi" and "fl" glyphs) and compatibility forms, which PDF text is full of; a failure of the table leaves the text as it was.
  let folded = normalised;
  try { folded = normalised.normalize('NFKC'); } catch { /* keep */ }
  const lines: string[] = [];
  let blank = 0;
  for (const raw of folded.split('\n')) {
    const line = raw.replace(/[ \t\u00a0]+/g, ' ').trim();
    if (!line) { blank += 1; if (blank > 1 || !lines.length) continue; } else blank = 0;
    lines.push(line);
  }
  return lines.join('\n').trim();
}
