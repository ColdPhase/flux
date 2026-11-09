import type { PersonalToolCall, PersonalToolResult, PersonalTurn } from './ports.js';

// Long research on the owner's API key (#1113, founder direction 2026-11-09, "no limits"): an agent may read as many pages as its
// question needs, so a page's whole text cannot ride along in every later request of the run. The first request after a page was read
// carries its text, which the model reads; once the model has written a short note on it, the text is left out of the requests after
// that and only the page's address and title stay, with the note in the model's own words. The Claude Code and Codex engines manage
// their own context and are not touched.

/** Flux's tool that reads a web page (#918). */
export const READ_WEB_TOOL = 'flux_read_web';

/**
 * The fewest characters the words of a step need to count as a note of the pages read before it. A step that only says "Reading the
 * next page." notes nothing, so the pages stay until a step does.
 */
export const PAGE_NOTE_MIN_CHARS = 40;

/** A page the run read: its address as the tool answered it, and its title. */
export interface PageRead { url: string; title: string | null }

/** The page a call of `flux_read_web` brought, read from its result; null for any other call, a refused read or anything that is not a page. */
export function pageRead(call: PersonalToolCall, result: PersonalToolResult): PageRead | null {
  if (call.name !== READ_WEB_TOOL || result.isError) return null;
  try {
    const page = JSON.parse(result.content) as { url?: unknown; title?: unknown; text?: unknown } | null;
    if (typeof page?.url !== 'string' || typeof page.text !== 'string') return null;
    return { url: page.url, title: typeof page.title === 'string' ? page.title.slice(0, 300) : null };
  } catch { return null; }
}

/** Whether the words of a step are a note of the pages read before it: enough words, not just a lead-in. */
export const notesPages = (words: string): boolean => words.trim().length >= PAGE_NOTE_MIN_CHARS;

/** What stands for a noted page's text in later requests: where it came from, and that it can be read again. */
export const notedPageResult = (callId: string, page: PageRead): PersonalToolResult => ({
  callId, isError: false,
  content: JSON.stringify({ url: page.url, title: page.title,
    note: 'The text of this page was left out of this request because you noted it in your words after it. Read the address again if you need more of it.' }),
});

/**
 * The turns with the text of every page in `pages` (results the model read and has not yet noted) replaced by `notedPageResult`.
 * Turns are replaced, never changed: a request already sent keeps what it carried. `pages` is emptied.
 */
export function notePages(done: PersonalTurn[], pages: Map<PersonalToolResult, PageRead>): void {
  for (const [index, turn] of done.entries()) {
    if (!turn.results.some((result) => pages.has(result))) continue;
    done[index] = { ...turn, results: turn.results.map((result) => { const page = pages.get(result); return page ? notedPageResult(result.callId, page) : result; }) };
  }
  pages.clear();
}
