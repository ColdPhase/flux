import { eq } from 'drizzle-orm';
import { CITE_MARK_SOURCE, type CiteKind } from '@flux/contracts';
import { fluxMarks, insideAddress, type CitedObject } from '@flux/core';
import { personalRunRows, schema, type Database } from '@flux/db';

// An agent copies a cite mark (`[task:ID]`, C-62) from its tool results after what it states. In its answer Flux turns the mark into a numbered
// source; written into a change (a decision's reasons, a task, a page, a thought, a line in a task's thread) it would show every reader an id
// (v0.2.1 real-model gate, rows 28 and 37). So the words a change writes name what a mark cites the way a person writes it in that space: a task
// of the space is `#12` and a Wiki page of it `[[Title]]`, which every message, decision and preview renders; a decision of the space is its
// title in quotes. A message, an object of another space (its readers may not read that one) and a mark that points at nothing leave only the
// words around them, and a mark right after the same `#12` or `[[Title]]` is not said twice. One rule for every change tool, before the call is
// prepared, stored or applied, so a change that waits for its owner's OK keeps the readable words too. A mark written inside a web address
// names nothing there: nothing from Flux may go into a web address (C-30, #1138), and the run's private-address check, which reads the words
// as they are written (after this), finds only the text the run read, not a title this rewrite would put in.

const MARK = new RegExp(String.raw`([ \t]?)${CITE_MARK_SOURCE}`, 'gu');
/** How far back a mark looks for the same reference already written: one sentence. */
const SAID_WITHIN = 160;
/** Whether a mark at `at` is written inside a web address: the word it ends (back to the last space) holds `://` or a `www.` host. */
function inAddress(text: string, at: number): boolean {
  let start = at;
  while (start > 0 && at - start < 4096 && !/\s/.test(text[start - 1]!)) start--;
  const word = text.slice(start, at);
  return word.includes('://') || /(?:^|[^a-z0-9-])www\./i.test(word);
}

function strings(value: unknown, depth = 0, found: string[] = []): string[] {
  if (depth > 12) return found;
  if (typeof value === 'string') { if (value.includes('[')) found.push(value); }
  else if (Array.isArray(value)) for (const item of value) strings(item, depth + 1, found);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) strings(item, depth + 1, found);
  return found;
}

function rewrite<T>(value: T, words: (text: string) => string, depth = 0): T {
  if (depth > 12) return value;
  if (typeof value === 'string') return (value.includes('[') ? words(value) : value) as T;
  if (Array.isArray(value)) return value.map((item) => rewrite(item, words, depth + 1)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, words, depth + 1)])) as T;
  return value;
}

/** How the object is named in its own space, or null when only the words around the mark stay. */
function named(object: CitedObject | undefined, projectId: string): string | null {
  if (!object || object.projectId !== projectId) return null;
  if (object.kind === 'task') return object.number ? `#${object.number}` : null;
  if (object.kind === 'doc') return /^[^\]\n]{1,120}$/.test(object.title) ? `[[${object.title}]]` : `“${object.title}”`;
  if (object.kind === 'decision') return `“${object.title}”`;
  return null;
}

/** The change's arguments with every cite mark in their words made readable for the people of `projectId` (see above). */
export async function readableMarks<T>(db: Database, projectId: unknown, args: T): Promise<T> {
  const marks = fluxMarks(strings(args).join('\n'));
  if (!marks.length) return args;
  const objects = new Map<string, CitedObject>();
  if (typeof projectId === 'string') {
    const [place] = await db.select({ workspaceId: schema.projects.workspaceId }).from(schema.projects).where(eq(schema.projects.id, projectId));
    if (place) {
      const requests = [...new Map(marks.map((mark) => [`${mark.kind}:${mark.id}`, { kind: mark.kind as CiteKind, id: mark.id }])).values()];
      for (const object of await personalRunRows(db).cites({ workspaceId: place.workspaceId, projectId }, requests)) objects.set(`${object.kind}:${object.id}`, object);
    }
  }
  const words = (text: string) => {
    // An address written without a scheme (`print.example/?q=[decision:ID]`) is one too: C-30's own spans, read once per text (delta review N-P3-2).
    let withinAddress: ((at: number) => boolean) | null = null;
    return text.replace(MARK, (_whole, lead: string, kind: string, id: string, _section: string | undefined, at: number) => {
      if (!lead && (inAddress(text, at) || (withinAddress ??= insideAddress(text))(at))) return '';
      const name = typeof projectId === 'string' ? named(objects.get(`${kind}:${id.toLowerCase()}`), projectId) : null;
      if (!name) return '';
      const before = text.slice(Math.max(0, at - SAID_WITHIN), at);
      const said = name.startsWith('#') ? new RegExp(`${name}(?![0-9])`).test(before) : before.includes(name);
      return said ? '' : `${lead}${name}`;
    });
  };
  return rewrite(args, words);
}
