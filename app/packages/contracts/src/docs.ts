import type { VersionPrecondition } from './access.js';
import type { NamedPrincipal, ObjectLink } from './work.js';

/**
 * Project docs and wiki (issue #112, foundation 8.7). A doc is a #36 project material of kind
 * `doc`: its versions are the same immutable material snapshots, so a message citing
 * `{ materialId: docId, version }` keeps citing exactly that text. Each version records its
 * author, time and the reason for the change, which the server writes (a person never types it). The text is a small
 * Markdown subset that the server renders and sanitizes; `flux:<type>/<id>` links refer to
 * objects of the same project and become typed `mentions` links with visible backlinks.
 * Everything is visible exactly to the people and agents with current project access.
 */
export const projectDocsPath = (projectId: string) => `/api/v1/projects/${projectId}/docs`;
export const projectDocPreviewPath = (projectId: string) => `/api/v1/projects/${projectId}/docs/preview`;
export const docPath = (docId: string) => `/api/v1/docs/${docId}`;
export const docVersionsPath = (docId: string) => `${docPath(docId)}/versions`;
export const docVersionPath = (docId: string, version: number) => `${docVersionsPath(docId)}/${version}`;
/** Adds or updates the section for a decision ("Add to docs"). */
export const docSectionsPath = (docId: string) => `${docPath(docId)}/sections`;

export const DOC_LIMITS = { title: 200, body: 100_000, reason: 500, mentions: 200, fileName: 200 } as const;

/** The most headings of a page that a section citation can name (C-62): a mark carries at most three digits. */
export const DOC_SECTIONS_MAX = 999;
/** A heading is shown to an agent in at most this many characters. */
const SECTION_WORDS = 80;

/** The line under a table's header row (`| --- | :-: |`, `--- | ---`). */
const TABLE_RULE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/;

/** A heading's words as the page shows them: links as their text, without the marks `* _ ~`, backticks and escapes, cut at `SECTION_WORDS`. */
function headingWords(raw: string): string {
  const words = raw.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~\\]/g, '').replace(/\s+/g, ' ').trim();
  return words.length > SECTION_WORDS ? `${words.slice(0, SECTION_WORDS - 1)}…` : words;
}

/**
 * The headings of levels 1 to 3 of a page's Markdown, in order, as the page's Contents numbers them (`section-1`, `section-2`, …; F-026 Wiki,
 * from the rendered page's `h1`–`h3`) and as an agent cites them (`[doc:ID#2]`, C-62): ATX headings (`## Install`), also inside a quote (`> ## …`)
 * or a list item (`- ## …`), and a paragraph underlined with `===` (level 1) or `---` (level 2), never inside fenced or indented code. Their
 * words without the closing hashes and the marks `* _ ~` and backticks. A heading with no words is not numbered, as in the page. Each line is
 * looked at once and cut at 400 characters first, so a page of 100,000 characters costs no more than its length.
 */
export function docHeadings(markdown: string): string[] {
  const found: string[] = [];
  let fence: string | null = null;
  /** The lines of the paragraph above, which an underline makes a heading. */
  let paragraph: string[] = [];
  /** Inside a quote, a list item or a table until a blank line: a line there continues it, and an underline under it is a rule, not a heading. */
  let inBlock = false;
  const add = (raw: string) => { const words = headingWords(raw); if (words) found.push(words); };
  for (const whole of markdown.split('\n')) {
    const line = whole.slice(0, 400);
    const edge = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (edge && edge[1]![0] === fence[0] && edge[1]!.length >= fence.length && !line.slice(edge[0].length).trim()) fence = null;
      continue;
    }
    if (edge) { fence = edge[1]!; paragraph = []; continue; }
    if (!line.trim()) { paragraph = []; inBlock = false; continue; }
    // An underline: the paragraph above is a heading (a `---` under no paragraph is a rule).
    const under = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (under && paragraph.length) {
      add(paragraph.join(' '));
      paragraph = [];
    } else if (/^ {4}|^\t/.test(line) && !paragraph.length) {
      // Indented code, unless it continues a paragraph.
      continue;
    } else {
      // A quote's or a list item's marks before the line's own start.
      const inner = line.replace(/^(?: {0,3}>[ \t]?)+/, '').replace(/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+/, '');
      const head = /^ {0,3}(#{1,3})(?:[ \t]+|$)/.exec(inner);
      if (head) {
        let words = inner.slice(head[0].length).trimEnd();
        let end = words.length;
        while (end > 0 && words[end - 1] === '#') end--;
        if (end < words.length && (end === 0 || words[end - 1] === ' ' || words[end - 1] === '\t')) words = words.slice(0, end).trimEnd();
        add(words);
        paragraph = [];
      } else if (/^ {0,3}(?:#{4,6}(?:[ \t]|$)|[-*_](?:[ \t]*[-*_]){2,}[ \t]*$)/.test(line)) {
        // A deeper heading or a rule (`- - -` too) ends the paragraph above.
        paragraph = [];
      } else if (inner !== line || TABLE_RULE.test(line)) {
        // A quote, a list item or a table: what follows until a blank line belongs to it.
        paragraph = [];
        inBlock = true;
      } else if (!inBlock) paragraph.push(line.trim());
    }
    if (found.length >= DOC_SECTIONS_MAX) return found.slice(0, DOC_SECTIONS_MAX);
  }
  return found;
}

/**
 * Why a person's save is the version it is, when the change itself does not say. The server checks the cause against the
 * page and writes the sentence History shows ("Restored version 3"); a person never writes a version's reason. Without a
 * cause the server describes the change ("Edited the text", "Renamed to “…”").
 * - `import`: a new page made from a file (create only): "Imported from notes.md" (the name as its last part, on one line, at most 60 characters).
 * - `restore`: version `version` put back as the next version: "Restored version 3", only when the saved title and text are that version's;
 *   otherwise the change is described.
 * - `keep_mine`: the saver kept their own text over a newer version: "In place of Ada’s version 4", naming the page's head that the save
 *   replaces and who wrote it, whichever `version` the request names; over their own version the change is described.
 * - `page_left`: the page was left with unsaved text, saved over the head: "Saved as the page was left, in place of version 4" (the head).
 * A `version` the page does not have is refused.
 */
export type DocChangeCause =
  | { kind: 'import'; fileName: string }
  | { kind: 'restore'; version: number }
  | { kind: 'keep_mine'; version: number }
  | { kind: 'page_left'; version: number };

/** Object types a doc text can refer to with `[label](flux:<type>/<id>)`. */
export const DOC_REF_TYPES = ['doc', 'work', 'decision', 'message', 'thought', 'sketch'] as const;
export type DocRefType = (typeof DOC_REF_TYPES)[number];
/** The link target a doc text uses for an object of its project. */
export const docRef = (type: DocRefType, id: string) => `flux:${type}/${id}`;

/** What a Markdown reference rendered to: the app path of the object, or missing. */
export interface DocMention {
  type: DocRefType;
  id: string;
  title: string;
  /** App path to open it; null when it does not exist in this project (shown as missing). */
  path: string | null;
}

export interface DocVersionSummary {
  docId: string;
  version: number;
  title: string;
  /** Why this version was made, in the server's words: "Edited the text", "Renamed to “…”", "Restored version 3". */
  reason: string;
  author: NamedPrincipal;
  /** Shared text contributors since the preceding saved binding; author is the deliberate saver. */
  contributors?: NamedPrincipal[];
  liveSnapshot?: { generation: string; fromSequence: number; toSequence: number };
  createdAt: string;
}

export interface DocVersion extends DocVersionSummary {
  projectId: string;
  /** The Markdown source of this version, never rewritten. */
  body: string;
  /** Server-rendered, sanitized HTML of `body`. */
  html: string;
  /** References in this version's text and where they lead now. */
  mentions: DocMention[];
}

export interface DocSummary {
  id: string;
  projectId: string;
  projectName: string;
  workspaceId: string;
  title: string;
  version: number;
  /** The last change: its author, time and reason. */
  updatedBy: NamedPrincipal;
  updatedAt: string;
  reason: string;
  /** The first words of the text, for the list. */
  excerpt: string;
}

export interface Doc extends DocVersion {
  id: string;
  workspaceId: string;
  audience: { kind: 'project'; projectId: string };
  createdBy: NamedPrincipal;
  /** When the doc was started; `createdAt` is the current version's time. */
  startedAt: string;
  /**
   * Links from and to this doc, oldest first: `mentions` from its current text, `source` for
   * decisions added to it, and backlinks (other docs and work objects linking here).
   */
  links: ObjectLink[];
}

/** A decision whose section "Add to docs" writes. */
export interface DocSectionSource {
  type: 'decision';
  id: string;
}

export interface CreateDocCommand {
  title: string;
  body?: string;
  /** Only `import`. */
  cause?: DocChangeCause;
  /** Starts the doc with the section for this decision and links it as the source. */
  from?: DocSectionSource;
}

export interface UpdateDocCommand extends VersionPrecondition {
  title?: string;
  body?: string;
  /** `restore`, `keep_mine` or `page_left`. */
  cause?: DocChangeCause;
}

/** Needs `If-Match` with the version the caller saw, like any edit. */
export interface AddDocSectionCommand extends VersionPrecondition {
  from: DocSectionSource;
  /**
   * A decision only (CW-9): the heading line of the page (`## Pickup`) whose section the card closes. Absent, or a heading
   * the page no longer has: the end of the page.
   */
  under?: string;
}

export interface DocPreviewCommand {
  body: string;
}

export interface DocPreview {
  html: string;
  mentions: DocMention[];
}

/** Saves exactly an acknowledged shared head; body is read from that head by the server. */
export interface SaveLiveDocCommand {
  generation: string;
  headSequence: number;
  headHash: string;
  title?: string;
  /** `restore`, `keep_mine` or `page_left`. */
  cause?: DocChangeCause;
}
