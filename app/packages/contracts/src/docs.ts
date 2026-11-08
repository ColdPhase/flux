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
/** Adds or updates the section for a result or decision ("Add to docs"). */
export const docSectionsPath = (docId: string) => `${docPath(docId)}/sections`;

export const DOC_LIMITS = { title: 200, body: 100_000, reason: 500, mentions: 200, fileName: 200 } as const;

/**
 * Why a person's save is the version it is, when the change itself does not say. The server checks the cause against the
 * page and writes the sentence History shows ("Restored version 3"); a person never writes a version's reason. Without a
 * cause the server describes the change ("Edited the text", "Renamed to “…”").
 * - `import`: a new page made from a file (create only): "Imported from notes.md".
 * - `restore`: version `version` put back as the next version: "Restored version 3".
 * - `keep_mine`: the saver kept their own text over the version `version` that someone else saved: "In place of Ada’s version 4".
 * - `page_left`: the page was left with unsaved text, saved over the head `version`: "Saved as the page was left, in place of version 4".
 */
export type DocChangeCause =
  | { kind: 'import'; fileName: string }
  | { kind: 'restore'; version: number }
  | { kind: 'keep_mine'; version: number }
  | { kind: 'page_left'; version: number };

/** Object types a doc text can refer to with `[label](flux:<type>/<id>)`. */
export const DOC_REF_TYPES = ['doc', 'work', 'decision', 'result', 'message', 'thought', 'sketch'] as const;
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
   * results and decisions added to it, and backlinks (other docs and work objects linking here).
   */
  links: ObjectLink[];
}

/** A result or decision whose section "Add to docs" writes. */
export interface DocSectionSource {
  type: 'result' | 'decision';
  id: string;
}

export interface CreateDocCommand {
  title: string;
  body?: string;
  /** Only `import`. */
  cause?: DocChangeCause;
  /** Starts the doc with the section for this result or decision and links it as the source. */
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
