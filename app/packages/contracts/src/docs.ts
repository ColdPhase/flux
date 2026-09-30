import type { VersionPrecondition } from './access.js';
import type { NamedPrincipal, ObjectLink } from './work.js';

/**
 * Project docs and wiki (issue #112, foundation 8.7). A doc is a #36 project material of kind
 * `doc`: its versions are the same immutable material snapshots, so a message citing
 * `{ materialId: docId, version }` keeps citing exactly that text. Each version records its
 * author, time, draft/published state and the reason for the change. The text is a small
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
/** Docs of every project in the workspace that the caller can currently read. */
export const workspaceDocsPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/docs`;

export type DocState = 'draft' | 'published';
export const DOC_LIMITS = { title: 200, body: 100_000, reason: 500, mentions: 200 } as const;

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
  state: DocState;
  /** Why this version was made; generated ("Edited the text", "Published") when none was given. */
  reason: string;
  author: NamedPrincipal;
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
  state: DocState;
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
  /** Defaults to `draft`. */
  state?: DocState;
  reason?: string;
  /** Starts the doc with the section for this result or decision and links it as the source. */
  from?: DocSectionSource;
}

export interface UpdateDocCommand extends VersionPrecondition {
  title?: string;
  body?: string;
  state?: DocState;
  reason?: string;
}

/** Needs `If-Match` with the version the caller saw, like any edit. */
export interface AddDocSectionCommand extends VersionPrecondition {
  from: DocSectionSource;
}

export interface DocPreviewCommand {
  body: string;
}

export interface DocPreview {
  html: string;
  mentions: DocMention[];
}
