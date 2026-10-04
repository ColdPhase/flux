import type { DocMention, DocRefType, DocState, ObjectRef } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { ActorRef, Paged, PageWindow, WorkAccess, WorkRepository } from '../work/ports.js';
import type { DocLiveVersions } from '../editing/doc-ports.js';

/**
 * Ports of the project doc use cases (issue #112). Docs reuse the #36 material rows and their
 * immutable versions, the #101 typed links and the #101 access port. The server implements
 * them with the access policy (`evaluateProject`/`authorize`/`visibleFilter`), `@flux/db` rows,
 * `recordEvent` and a Markdown renderer; nothing in `packages/core/src/docs` imports them.
 */

export interface DocRecord {
  id: string;
  workspaceId: string;
  projectId: string;
  /** A person, or the agent that started the doc under a standing grant (#152). */
  createdBy: ActorRef;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface DocVersionRecord {
  docId: string;
  projectId: string;
  version: number;
  title: string;
  body: string;
  state: DocState;
  reason: string;
  /** The actual author of this version: a person, or an agent writing under a standing grant (#152). */
  author: ActorRef;
  /** Immutable contributing humans of an explicit shared snapshot; the saver remains author. */
  contributors?: ActorRef[];
  liveSnapshot?: { generation: string; fromSequence: number; toSequence: number };
  createdAt: Date;
}

/** A doc with its current version (and its project's name, for lists). */
export interface DocWithCurrent {
  doc: DocRecord;
  current: DocVersionRecord;
  projectName: string;
}

export type NewDocVersion = Pick<DocVersionRecord, 'title' | 'body' | 'state' | 'reason' | 'author'>;

/** Rows only; the repository makes no access decisions (the use cases ask {@link WorkAccess}). */
/** One command owns every addition until its caller transaction has actually settled. */
export interface DocTaskUseMemory {
  reserve(bytes: number): void;
  /** Synchronous parse ownership; release before awaiting SQL, retain parsed refs in the command base. */
  temporary(bytes: number): () => void;
}
export interface DocTaskUseFence { readonly ids: readonly string[]; mark(ids?: readonly string[]): Promise<void> }
export interface DocRepository {
  prepareTaskUse(scope: { workspaceId: string; projectId: string }, docId: string, refs: readonly ObjectRef[]): Promise<DocTaskUseFence>;
  /** Read-only target-set validation under an already retained complete graph/task fence. */
  assertTaskUse(docId: string, refs: readonly ObjectRef[], retained: DocTaskUseFence): Promise<void>;
  /** The project of a doc, whoever may read it; callers must authorize before using it. */
  locate(id: string): Promise<{ projectId: string } | null>;
  /** Docs of a project, the most recently changed first. */
  list(projectId: string, page: PageWindow): Promise<Paged<DocWithCurrent>>;
  /**
   * Docs of the workspace's projects that pass the policy's list filter (`visibleFilter`) for
   * `principal`, applied before the page and the total.
   */
  listVisible(principal: Principal, workspaceId: string, page: PageWindow): Promise<Paged<DocWithCurrent>>;
  find(id: string, options?: { lock?: boolean }): Promise<DocWithCurrent | null>;
  version(id: string, version: number): Promise<DocVersionRecord | null>;
  /** Versions, newest first. */
  versions(id: string, page: PageWindow): Promise<Paged<DocVersionRecord>>;
  insert(doc: { id: string; workspaceId: string; projectId: string; createdBy: ActorRef }, first: NewDocVersion): Promise<DocWithCurrent>;
  /** Adds the next immutable version and makes it current; the caller holds the row lock. */
  append(id: string, next: NewDocVersion): Promise<DocWithCurrent>;
  /** Replaces the doc's `mentions` links with links to `targets`; other roles are kept. */
  replaceMentions(scope: { workspaceId: string; projectId: string }, docId: string, targets: ObjectRef[], by: ActorRef, retained?: DocTaskUseFence): Promise<void>;
}

/** A `flux:<type>/<id>` reference found in a Markdown text. */
export interface DocReference {
  type: DocRefType;
  id: string;
}

/**
 * Parses and renders the Markdown subset. `render` must escape raw HTML, allow only safe link
 * schemes, turn resolved `flux:` references into app links and missing ones into plain text,
 * and sanitize the result.
 */
export interface DocRenderer {
  /** Optional task preparation bound returns at most maxUnique distinct references. */
  references(markdown: string, maxUnique?: number): DocReference[];
  render(markdown: string, mentions: Map<string, DocMention>): string;
}

export type DocEventKind = 'project.doc_created.v1' | 'project.doc_updated.v1';

/** Records a versioned project event in the unit of work (identifiers only, never content). */
export interface DocEventLog {
  record(principal: Principal, workspaceId: string, kind: DocEventKind, projectId: string, data: Record<string, unknown>): Promise<void>;
}

export interface DocPorts {
  access: WorkAccess;
  docs: DocRepository;
  live: DocLiveVersions;
  /** The #101 rows: typed links, titles, names, and the results and decisions added to docs. */
  work: WorkRepository;
  events: DocEventLog;
  renderer: DocRenderer;
  taskUseMemory?: DocTaskUseMemory;
}

/** Runs `work` in one transaction; on an open transaction (an idempotency scope) it nests. */
export interface DocUnitOfWork {
  run<T>(work: (ports: DocPorts) => Promise<T>): Promise<T>;
}
