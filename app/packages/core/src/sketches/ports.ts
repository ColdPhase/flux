import type { PageQuery, PersonRef, SketchScope, ThoughtFile, ThoughtShape } from '@flux/contracts';
import type { Principal } from '../principal.js';
import type { SketchLiveJournal } from '../editing/map-journal.js';

/**
 * Ports of the sketch use cases (issues #69, #46). Core states what it needs; the server
 * implements them with the access policy (`policySketchAccess`), Drizzle repositories and
 * `recordEvent`, and passes them in. Nothing in `packages/core/src/sketches` imports those.
 */

export type SketchAction = 'sketch.read' | 'sketch.write';

export interface SketchRecord {
  id: string;
  workspaceId: string;
  scope: SketchScope;
  projectId: string | null;
  title: string;
  createdBy: PersonRef;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /** How many thoughts it has; set by sketch lists (#508). */
  thoughtCount?: number;
}

/** The project message a thought was started from. */
export interface ThoughtSourceRecord {
  authorId: string;
  authorKind: 'human' | 'agent';
  authorName: string;
  sentAt: Date;
  projectMessageId: string;
}

export interface ThoughtRecord {
  id: string;
  sketchId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: ThoughtShape;
  placement: { type: 'draft'; id: string } | null;
  source: ThoughtSourceRecord | null;
  createdBy: PersonRef;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A project message whose source can be retained on a thought in that same project. */
export interface ProjectMessageView {
  id: string;
  projectId: string;
  authorId: string;
  authorKind: 'human' | 'agent';
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface LinkRecord {
  id: string;
  sketchId: string;
  fromId: string;
  toId: string;
  label: string | null;
  createdAt: Date;
}

/** Where a new sketch goes; the access port decides whether the caller may put it there. */
export type SketchTarget =
  | { scope: 'project'; workspaceId: string; projectId: string }
  | { scope: 'private'; workspaceId: string };

/** The access policy's answer about an object placed on a map, for one reader, from current rows. */
export interface PlacementView {
  /** The reader may read the object now. */
  readable: boolean;
  /** The object's workspace when readable, else null. */
  workspaceId: string | null;
  title: string | null;
}

/** Adapter over the core access policy (`evaluateSketch`, `evaluateProject`, `evaluateDraft`). */
export interface SketchAccess {
  /**
   * Throws NotFoundError when the sketch is invisible to the principal and ForbiddenError when
   * the action is not allowed. `lock` (inside a change) locks the sketch and the rows the
   * decision depends on until the unit of work commits. Returns what the principal may do.
   */
  requireSketch(principal: Principal, action: SketchAction, sketchId: string, options?: { lock?: boolean }): Promise<'read' | 'write'>;
  /** What the principal may do with a sketch now, or null when it is invisible. */
  accessOf(principal: Principal, sketchId: string): Promise<'read' | 'write' | null>;
  /** Throws NotFoundError unless the principal is active in the workspace. */
  requireWorkspace(principal: Principal, workspaceId: string): Promise<void>;
  /**
   * Throws the policy's 404/403, or RuleViolationError for a project of another workspace.
   */
  requireCreate(principal: Principal, target: SketchTarget): Promise<void>;
  /** Access to the underlying object of a placement. Never throws for invisible objects. */
  placement(principal: Principal, ref: { type: 'draft'; id: string }): Promise<PlacementView>;
}

export interface NewSketch {
  id: string;
  workspaceId: string;
  scope: SketchScope;
  projectId: string | null;
  title: string;
  createdBy: Principal;
}

export interface NewThought {
  id: string;
  workspaceId: string;
  sketchId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: ThoughtShape;
  placement: { type: 'draft'; id: string } | null;
  source?: ThoughtSourceRecord | null;
  createdBy: Principal;
}

export interface NewLink {
  id: string;
  workspaceId: string;
  sketchId: string;
  fromId: string;
  toId: string;
  label: string | null;
  createdBy: Principal;
}

export type ThoughtChanges = Partial<Pick<ThoughtRecord, 'text' | 'x' | 'y' | 'width' | 'height' | 'shape'>>;

/** Rows only; the repository makes no access decisions (the use cases ask {@link SketchAccess}). */
/** `hideEmpty` leaves out sketches with no thought that still have the default title (#508). */
export interface SketchListFilter { projectId?: string; scope?: 'private'; hideEmpty?: boolean }

export interface SketchRepository {
  /** The sketches of `workspaceId` that pass the policy's list filter for `principal`, newest change first. */
  listVisible(principal: Principal, workspaceId: string, filter: SketchListFilter, page: Required<PageQuery>): Promise<{ items: SketchRecord[]; total: number }>;
  /** One sketch by id; call only after the access port allowed it. */
  findSketch(id: string): Promise<SketchRecord | null>;
  insertSketch(sketch: NewSketch): Promise<SketchRecord>;
  /** The id of the person's private map in this company, if they have one (#947: one for each person). */
  privateSketchOf(workspaceId: string, userId: string): Promise<string | null>;
  /** Sets the title and increments the version; the caller has checked the version. */
  renameSketch(id: string, title: string, editor: Principal): Promise<SketchRecord>;
  /** Bumps `updated_at` so lists sort by the latest change; `editor` is who changed the map, when someone did. */
  touchSketch(id: string, editor?: Principal): Promise<void>;
  thoughts(sketchId: string, page?: Required<PageQuery>): Promise<ThoughtRecord[]>;
  mapCounts(sketchId: string): Promise<{ thoughts: number; links: number }>;
  /** Project messages with these ids, constrained to the project's own conversation history. */
  projectMessages(projectId: string, ids: string[]): Promise<ProjectMessageView[]>;
  /** Rows of `sketchId` with these ids, locked for update (in id order). */
  lockThoughts(sketchId: string, ids: string[]): Promise<ThoughtRecord[]>;
  thoughtExists(id: string): Promise<boolean>;
  insertThought(thought: NewThought): Promise<ThoughtRecord>;
  /** Applies the changes and increments the version; the caller has checked the version. */
  updateThought(sketchId: string, id: string, changes: ThoughtChanges, editor: Principal): Promise<ThoughtRecord>;
  /** Deletes the thought and its links; never the placed object. */
  deleteThought(sketchId: string, id: string): Promise<void>;
  links(sketchId: string, page?: Required<PageQuery>): Promise<LinkRecord[]>;
  /** Bounded affected links, counted before row allocation; never load the whole graph for one removal. */
  relatedLinks(sketchId:string,filter:{thoughtId?:string;linkId?:string}):Promise<LinkRecord[]>;
  /** Read after the sketch's write lock; every connection mutation holds that lock. */
  findLink(sketchId: string, id: string): Promise<LinkRecord | null>;
  linkExists(id: string): Promise<boolean>;
  /** The link between two thoughts of the sketch, in either direction. */
  linkBetween(sketchId: string, a: string, b: string): Promise<LinkRecord | null>;
  insertLink(link: NewLink): Promise<LinkRecord>;
  /** Changes only the label; caller holds the sketch lock and checked the expected label. */
  updateLinkLabel(sketchId: string, id: string, label: string | null): Promise<LinkRecord>;
  /** Returns false when the sketch has no such link. */
  deleteLink(sketchId: string, id: string): Promise<boolean>;
}

/** Records a versioned event for the stream in the unit of work (identifiers only, never content). */
export interface SketchEventLog {
  record(principal: Principal, workspaceId: string, kind: 'sketch.created.v1' | 'sketch.changed.v1', sketchId: string, data: Record<string, unknown>): Promise<void>;
}

/**
 * Stored files as the images of project map thoughts (#252). The server implements it over the stored-files rows,
 * storage and use-case rules (docs/development/task-discussions.md, "Map thought images"), in the same transaction.
 */
export interface SketchFiles {
  /** The images of these thoughts of one project sketch, by thought id. */
  ofThoughts(projectId: string, thoughtIds: readonly string[]): Promise<Map<string, ThoughtFile>>;
  /**
   * Publishes the caller's own staged image of `projectId` as the image of `thoughtId`, or accepts a file already
   * published to that same thought (Undo). Call it after the sketch's write lock; it throws the stored-files errors.
   */
  place(principal: Principal, input: { projectId: string; fileId: string; thoughtId: string }): Promise<ThoughtFile>;
  /** Production preparation locks/verifies bytes before the shared task fence; the returned effect publishes afterward. */
  preparePlace?(principal:Principal,input:{projectId:string;fileId:string;thoughtId:string}):Promise<()=>Promise<ThoughtFile>>;
}

export interface SketchPorts {
  access: SketchAccess;
  files: SketchFiles;
  sketches: SketchRepository;
  events: SketchEventLog;
  live: SketchLiveJournal;
  /** Mandatory in production compositions; optional only in pure domain fixtures without persisted artifacts. */
  artifacts?:{prepare(sketch:SketchRecord,thoughtIds:readonly string[]):Promise<{
    thought(before:ThoughtRecord|null,after:ThoughtRecord):Promise<void>;
    file(fileId:string):Promise<void>;
  }|null>};
}

/**
 * Runs `work` in one transaction: the decision, the change and its event commit together or not
 * at all. Called on an open transaction (such as an idempotency scope) it nests in it.
 */
export interface SketchUnitOfWork {
  run<T>(work: (ports: SketchPorts) => Promise<T>): Promise<T>;
}
