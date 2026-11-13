/** The text of a file as it was read: a PDF has one segment for each page, any other file one. */
export interface TextSegment { text: string; page?: number }

/** One search row's text (`file:<id>:<part>`): parts are numbered from 1, and a PDF's part says the page where it begins. */
export interface TextPart { part: number; page: number | null; text: string }

const isSpace = (code: number) => code === 32 || code === 10 || code === 9 || code === 13 || code === 0xa0 || code === 0x2028 || code === 0x2029;
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** Where to cut a text of more than `limit` characters: after the last line break or space of its last quarter, else at the limit (never inside a surrogate pair). */
function cutAt(text: string, limit: number): number {
  const floor = Math.floor(limit * 0.75);
  const line = text.lastIndexOf('\n', limit - 1);
  if (line >= floor) return line + 1;
  const space = text.lastIndexOf(' ', limit - 1);
  if (space >= floor) return space + 1;
  return isHighSurrogate(text.charCodeAt(limit - 1)) ? limit - 1 : limit;
}

/**
 * Cuts the text of a file into the parts that become search rows (C-63): up to `partChars` characters each, at a line break or a space, and a PDF's
 * pages kept apart (a part never crosses a page, so the page of a hit is the page of its match; a page of more than a part is several). Parts joined are the text kept: no character is added or lost except NUL (which a text column
 * cannot hold), a line break between two pages, and the text over `maxChars`, which stops at that many (`truncated`). Every loop is linear in the text.
 */
export function splitIntoParts(segments: readonly TextSegment[], limits: { partChars: number; maxChars: number }): { parts: TextPart[]; chars: number; truncated: boolean } {
  const parts: TextPart[] = [];
  // One character below the limit stays free for the line break that ends a page.
  const limit = limits.partChars - 1;
  let current = '';
  let currentPage: number | null = null;
  let kept = 0;
  let truncated = false;
  const emit = (text: string, page: number | null) => { if (text) parts.push({ part: parts.length + 1, page, text }); };
  for (const segment of segments) {
    let text = segment.text.includes('\u0000') ? segment.text.replaceAll('\u0000', '') : segment.text;
    if (!text) continue;
    const page = segment.page ?? null;
    if (current && !isSpace(current.charCodeAt(current.length - 1))) { current += '\n'; kept += 1; }
    const room = limits.maxChars - kept;
    if (room <= 0) { truncated = true; break; }
    if (text.length > room) { text = text.slice(0, isHighSurrogate(text.charCodeAt(room - 1)) ? room - 1 : room); truncated = true; }
    // A part never crosses a page: the page a hit names is the page of its match.
    if (current && (page !== null || current.length + text.length > limit)) { emit(current, currentPage); current = ''; }
    if (!current) currentPage = page;
    const length = text.length;
    while (text.length > limit) {
      const at = cutAt(text, limit);
      emit(text.slice(0, at), currentPage);
      text = text.slice(at);
      currentPage = page;
    }
    current += text;
    kept += length;
    if (truncated) break;
  }
  emit(current, currentPage);
  return { parts, chars: parts.reduce((sum, part) => sum + part.text.length, 0), truncated };
}
