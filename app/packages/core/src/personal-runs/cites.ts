import type { AssistantSourceRef, CiteKind } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { PersonalRunPorts, RunRecord } from './ports.js';
import type { KeptPrivateText } from './web-addresses.js';

// What an answer cites out of what its tools read (C-62, #1381). A run is given numbered sources (`[S3]`) for the few messages and open tasks of its place;
// everything else it learns it reads with a tool, and every tool result that returns such an object carries its mark ready, as `cite` (`citeMark`). The agent
// copies it right after the statement that uses it:
//   [doc:ID]  [doc:ID#2] (the page's second heading, as the page's Contents numbers them)  [task:ID]  [decision:ID]  [message:ID]
// When the answer is committed, on both engines, each mark is resolved to an object the run may cite and becomes the numbered `[n]` chip of any other
// source (one list, in the order the answer cites them); a mark that points at nothing the run may cite is taken out, as an invented `[8]` is.
// Only a mark one of the run's own tools returned counts (`resultCites`, kept with what the run read): a mark someone wrote in a message, a page or a
// request is words, and a mark of it in an answer is taken out like any other the run was not given.

export type { CiteKind };

/** One mark an answer holds: `key` is its normal form (`doc:ID#2`), the id in lower case. */
export interface FluxMark { key: string; kind: CiteKind; id: string; section: number | null }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** The text of one mark; group 1 is its kind, 2 its id and 3 its section. No nested or repeated quantifier: a mark is read in one step. */
const MARK_SOURCE = String.raw`\[(doc|task|decision|message):(${UUID})(?:#([1-9][0-9]{0,2}))?\]`;
/** The most different marks of one answer that are looked up; any further one is taken out. */
export const CITES_MAX = 20;

/** A mark's normal form, from the text of the mark with its brackets. */
export function markKey(kind: CiteKind, id: string, section: number | null): string {
  return `${kind}:${id.toLowerCase()}${section ? `#${section}` : ''}`;
}

/** The marks of a text, each once, in the order they stand. */
export function fluxMarks(text: string): FluxMark[] {
  if (!text.includes('[')) return [];
  const found = new Map<string, FluxMark>();
  for (const match of text.matchAll(new RegExp(MARK_SOURCE, 'gu'))) {
    const kind = match[1]!.toLowerCase() as CiteKind;
    const id = match[2]!.toLowerCase();
    const section = match[3] ? Number(match[3]) : null;
    const key = markKey(kind, id, section);
    if (!found.has(key)) found.set(key, { key, kind, id, section });
  }
  return [...found.values()];
}

/** The regular expression `parseOutput` replaces marks with, next to the `[S3]` ones; the leading space goes with the mark. */
export const CITE_MARK_PATTERN = new RegExp(String.raw`\s?${MARK_SOURCE}`, 'gu');

/** A `cite` field as a tool writes it: exactly one mark, without a section. */
const CITE_FIELD = new RegExp(String.raw`^\[(?:doc|task|decision|message):${UUID}\]$`, 'u');
/** How deep and how many values of one tool result are looked at for its marks: far beyond what a tool returns, a bound on a hostile one. */
const WALK = { depth: 12, values: 20_000 } as const;

/**
 * The marks a tool result returns to be cited (C-62): the value of each `cite` field of the objects in its JSON, as the server wrote it, each once. A
 * mark inside a string (a message's words, a page's text) is no field of an object and is never one of them, whatever it looks like.
 */
export function resultCites(result: { content?: unknown; structuredContent?: unknown }): string[] {
  const found = new Set<string>();
  let left: number = WALK.values;
  const walk = (value: unknown, depth: number) => {
    if (left-- <= 0 || depth > WALK.depth || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    for (const [key, item] of Object.entries(value)) {
      if (key === 'cite' && typeof item === 'string' && CITE_FIELD.test(item)) found.add(item);
      else walk(item, depth + 1);
    }
  };
  for (const part of Array.isArray(result?.content) ? result.content as unknown[] : []) {
    const text = (part as { type?: unknown; text?: unknown })?.type === 'text' ? (part as { text?: unknown }).text : undefined;
    if (typeof text !== 'string' || !/^\s*[{[]/.test(text)) continue;
    try { walk(JSON.parse(text), 0); } catch { /* a result that is not JSON returns no mark */ }
  }
  if (result?.structuredContent !== undefined) walk(result.structuredContent, 0);
  return [...found];
}

/**
 * The marks a run's tools returned, kept with the private Flux text it read (`personal_run_private_texts`, C-30): one kept text that starts with a control
 * character, which no kept Flux text holds (they are folded without them, `comparableText`), then the marks.
 */
const CITES_KEPT = '\u0002';
export const keptCites = (marks: readonly string[]): KeptPrivateText => ({ body: `${CITES_KEPT}${marks.join(' ')}`, addresses: [] });

/** What the repository found of one cited object, in the run's workspace. */
export interface CitedObject {
  kind: CiteKind;
  id: string;
  projectId: string;
  /** A page's, task's or decision's title; a message has none. */
  title: string;
  /** A message's conversation. */
  conversationId?: string;
  /** A task's version. */
  revision?: number;
  /** A page's current version and, when a section was asked for, its headings in order. */
  version?: number;
  headings?: string[];
}

/** What the repository is asked about: the objects the marks name, and for a page the sections, so its headings are read only then. */
export interface CiteRequest { kind: CiteKind; id: string; section?: number }

/**
 * The objects an answer's marks point at, as source refs by mark key, of the marks the run's own tools returned (`resultCites`). A run in a space cites that space only (its answer is shown to everyone who
 * reads it, C-12, C-37); a private chat or a schedule, whose answer only its owner reads, cites any space its owner reads with AI on; a run in a
 * direct message cites nothing (its tools reach no space, C-37). A page's section is kept only when the page has that heading.
 */
export async function resolveCites(ports: PersonalRunPorts, run: RunRecord, marks: readonly FluxMark[]): Promise<Map<string, AssistantSourceRef>> {
  const resolved = new Map<string, AssistantSourceRef>();
  if (!marks.length || run.dmId !== null || !ports.runs.cites || !ports.runs.keptCites) return resolved;
  // Only what the run's own tools returned (a mark written in a message is words), and a page's section only of a page they returned.
  const returned = new Set((await ports.runs.keptCites(run.id)).flatMap((body) => fluxMarks(body)).map((mark) => mark.key));
  const wanted = marks.filter((mark) => returned.has(markKey(mark.kind, mark.id, null))).slice(0, CITES_MAX);
  if (!wanted.length) return resolved;
  const requests = new Map<string, CiteRequest>();
  for (const mark of wanted) {
    const known = requests.get(`${mark.kind}:${mark.id}`);
    // A page cited by section and without one is read once, with its headings.
    requests.set(`${mark.kind}:${mark.id}`, { kind: mark.kind, id: mark.id, ...(mark.section || known?.section ? { section: mark.section ?? known!.section! } : {}) });
  }
  const objects = await ports.runs.cites({ workspaceId: run.workspaceId, projectId: run.projectId }, [...requests.values()]);
  const owner: Principal = { kind: 'human', id: run.ownerUserId };
  const reach = new Map<string, boolean>();
  const may = async (projectId: string) => {
    if (run.projectId !== null) return projectId === run.projectId;
    if (!reach.has(projectId)) reach.set(projectId, await ports.access.canUseProject(owner, 'read', projectId) && (await ports.access.spaceAi(projectId)).state === 'allowed');
    return reach.get(projectId)!;
  };
  const byObject = new Map(objects.map((object) => [`${object.kind}:${object.id}`, object]));
  for (const mark of wanted) {
    const object = byObject.get(`${mark.kind}:${mark.id}`);
    if (!object || !(await may(object.projectId))) continue;
    switch (object.kind) {
      case 'doc': {
        const text = mark.section ? object.headings?.[mark.section - 1] : undefined;
        resolved.set(mark.key, { type: 'doc', id: object.id, projectId: object.projectId, title: object.title,
          ...(mark.section && text && object.version ? { section: { n: mark.section, text, version: object.version } } : {}) });
        break;
      }
      case 'decision': resolved.set(mark.key, { type: 'decision', id: object.id, projectId: object.projectId, title: object.title }); break;
      case 'task': resolved.set(mark.key, { type: 'work', id: object.id, revision: object.revision ?? 1, projectId: object.projectId, title: object.title }); break;
      case 'message': resolved.set(mark.key, { type: 'message', id: object.id, revision: 1, projectId: object.projectId,
        ...(object.conversationId ? { conversationId: object.conversationId } : {}) }); break;
    }
  }
  return resolved;
}

/**
 * The sources of a committed answer as its reader is shown them, checked again on every read (C-62): a source the run's tools found in another space
 * (only a private chat's or a schedule's answer, which its owner alone reads, has one) keeps its number but loses its title and section when the owner can no
 * longer read that space, so the chip says only what kind of thing it was and opens nothing they could not open. A source of the answer's own space is read
 * by whoever reads the answer there.
 */
export async function sourcesShown(ports: PersonalRunPorts, run: Pick<RunRecord, 'projectId' | 'ownerUserId' | 'answerSources'>): Promise<AssistantSourceRef[]> {
  const elsewhere = new Set(run.answerSources.flatMap((source) => ('projectId' in source && source.projectId && source.projectId !== run.projectId ? [source.projectId] : [])));
  if (!elsewhere.size) return run.answerSources.map((source) => ({ ...source }));
  const owner: Principal = { kind: 'human', id: run.ownerUserId };
  const gone = new Set<string>();
  for (const projectId of elsewhere) if (!await ports.access.canUseProject(owner, 'read', projectId)) gone.add(projectId);
  return run.answerSources.map((source): AssistantSourceRef => {
    if (!('projectId' in source) || !source.projectId || !gone.has(source.projectId)) return { ...source };
    switch (source.type) {
      case 'doc': case 'decision': return { type: source.type, id: source.id, projectId: source.projectId, title: '' };
      case 'work': return { type: 'work', id: source.id, revision: source.revision, projectId: source.projectId };
      case 'message': return { type: 'message', id: source.id, revision: source.revision, projectId: source.projectId };
      default: return { ...source };
    }
  });
}
