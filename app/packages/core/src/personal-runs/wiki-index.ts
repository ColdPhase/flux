import { excerpt } from '../docs/service.js';
import type { WikiIndex } from './brief.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';

// The index of a space's Wiki that variant B of #1381 puts in the brief (C-62): each page's title and first line, the most recently edited first, capped by
// pages and by size. It is an evaluation switch (`FLUX_AI_BRIEF_WIKI_INDEX=on`, off by default), not a product setting: #1295's evaluation runs both variants.

/** At most 40 pages and 6,000 characters (about 1,500 tokens) of titles and lines; a title is cut at 80 characters and a line at 100. */
export const WIKI_INDEX_LIMITS = { pages: 40, characters: 6_000, title: 80, line: 100 } as const;

const cut = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value);

/** The first sentence of a page's first paragraph when it fits a line, else the start of it. */
function firstLine(lead: string): string {
  const plain = excerpt(lead, 400).replace(/\s+/g, ' ').trim();
  const sentence = /^(.{1,100}?[.!?])(?:\s|$)/u.exec(plain);
  return cut(sentence ? sentence[1]! : plain, WIKI_INDEX_LIMITS.line);
}

/** The pages as listed, newest first, until a limit is reached; `total` is how many pages the space has. */
export function wikiIndexOf(pages: readonly { title: string; lead: string }[], total: number): WikiIndex | null {
  const listed: { title: string; line: string }[] = [];
  let characters = 0;
  for (const page of pages.slice(0, WIKI_INDEX_LIMITS.pages)) {
    const title = cut(page.title.replace(/\s+/g, ' ').trim(), WIKI_INDEX_LIMITS.title);
    const line = firstLine(page.lead);
    // A line and its dash and break count with the title.
    characters += title.length + line.length + 4;
    if (characters > WIKI_INDEX_LIMITS.characters && listed.length) break;
    if (title) listed.push({ title, line });
  }
  return listed.length ? { pages: listed, more: Math.max(0, total - listed.length) } : null;
}

/**
 * The index for one run, or null: only when the switch is on, the run is in a space and holds the tool that reads a page, and the space has a page. The run
 * has read access to its space already (`readSources`, `runtimeContext`), and the index lists exactly what `flux_list_docs` lists there; a private chat, a
 * schedule and a direct message name no space and get none (their tools reach the Wiki as before).
 */
export async function readWikiIndex(ports: PersonalRunPorts, run: Pick<RunRecord, 'projectId'>, on: boolean, tools: readonly string[]): Promise<WikiIndex | null> {
  if (!on || run.projectId === null || !tools.includes('flux_get_doc') || !ports.runs.wikiPages) return null;
  const { pages, total } = await ports.runs.wikiPages(run.projectId, WIKI_INDEX_LIMITS.pages);
  return wikiIndexOf(pages, total);
}
