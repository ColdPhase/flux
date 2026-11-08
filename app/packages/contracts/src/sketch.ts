// Wire types for sketches: thoughts on a map and the links between them (issue #69).
// Every route requires a live session and follows the access contract in access.ts: an
// invisible sketch answers 404, a visible one the caller may not change answers 403.
// Changes accept `Idempotency-Key`; versioned changes need `If-Match` (see below).

import type { Page, PageQuery, PrincipalRef } from './access.js';
import type { AgentProjectOwner } from './conversation.js';

export const SKETCHES_PATH = '/api/v1/sketches';

export const workspaceSketchesPath = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}/sketches`;
export const sketchPath = (sketchId: string) => `${SKETCHES_PATH}/${sketchId}`;
export const sketchThoughtsPath = (sketchId: string) => `${sketchPath(sketchId)}/thoughts`;
export const sketchThoughtPath = (sketchId: string, thoughtId: string) => `${sketchThoughtsPath(sketchId)}/${thoughtId}`;
/** PATCH: move several thoughts in one all-or-nothing change. */
export const sketchPositionsPath = (sketchId: string) => `${sketchPath(sketchId)}/positions`;
export const sketchLinksPath = (sketchId: string) => `${sketchPath(sketchId)}/links`;
export const sketchLinkPath = (sketchId: string, linkId: string) => `${sketchLinksPath(sketchId)}/${linkId}`;

/**
 * `project`: readable by everyone who can read the project, changeable by its contributors.
 * `private`: only the person who created it, and one for each person in a company: "My map" (#947). Workspace owners
 * and admins do not see it, and agents never do.
 */
export type SketchScope = 'project' | 'private';
/** The title a new map starts with until someone names it. */
export const UNTITLED_SKETCH = 'Untitled map';
export type ThoughtShape = 'card' | 'pill' | 'circle';
export const THOUGHT_SHAPES: readonly ThoughtShape[] = ['card', 'pill', 'circle'];

/** Plane coordinates are integers in [-100000, 100000]; sizes in [80, 800] × [40, 800]. */
export const SKETCH_LIMITS = {
  title: 200,
  text: 1000,
  label: 80,
  coordinate: 100_000,
  minWidth: 80,
  maxWidth: 800,
  minHeight: 40,
  maxHeight: 800,
  /** Thoughts per positions request. */
  moves: 200,
  /** Non-empty lines one paste may turn into draft thoughts (#252); a longer paste is refused whole. */
  pasteLines: 50,
} as const;
export const DEFAULT_THOUGHT_SIZE = { width: 184, height: 72 } as const;

export interface PersonRef {
  kind: 'human' | 'agent';
  id: string;
  name: string;
  /** Agents in the project list only (#339 AC-2); see `NamedPrincipal.projectOwner`. */
  projectOwner?: AgentProjectOwner;
}

export interface Sketch {
  id: string;
  workspaceId: string;
  scope: SketchScope;
  projectId: string | null;
  title: string;
  createdBy: PersonRef;
  /** What the caller may do now. */
  access: 'read' | 'write';
  /** Changes with the title; thoughts and links carry their own versions. */
  version: number;
  createdAt: string;
  updatedAt: string;
  /** How many thoughts the sketch has; given in sketch lists (#508). */
  thoughtCount?: number;
}

/**
 * An existing object shown on the map. Only `draft` exists today; tasks and threads follow.
 * `title` is null when the reader cannot open the object now (or it no longer exists), so a
 * placement never reveals content its reader could not read directly.
 */
export interface Placement {
  type: 'draft';
  id: string;
  title: string | null;
}

/** The message a thought was started from: its author and time as they were then. */
export interface ThoughtSource {
  author: PrincipalRef & { name: string };
  sentAt: string;
  /** Present only while the thought and its source message remain in the same project. */
  projectMessageId?: string | null;
}

export interface Thought {
  id: string;
  sketchId: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shape: ThoughtShape;
  placement: Placement | null;
  source: ThoughtSource | null;
  /**
   * #252: the image of a project sketch's thought, a stored file of the project published to it.
   * Absent when the thought has none. The bytes download from `filePath(file.id)`; the text is its caption.
   */
  file?: ThoughtFile;
  createdBy: PersonRef;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** A stored file shown as a thought's image (#252): its display name and size. */
export interface ThoughtFile {
  id: string;
  name: string;
  size: number;
}

/** Undirected; `fromId`/`toId` record how it was drawn. One link per pair of thoughts. */
export interface ThoughtLink {
  id: string;
  sketchId: string;
  fromId: string;
  toId: string;
  label: string | null;
  createdAt: string;
}

export interface SketchDetail extends Sketch {
  thoughts: Thought[];
  links: ThoughtLink[];
}

export interface SketchListQuery extends PageQuery {
  projectId?: string;
  /** Only private sketches: the person's own sketchbook (#189). */
  scope?: 'private';
  /** Leave out sketches nobody put anything on: no thought and still {@link UNTITLED_SKETCH} (#508). */
  hideEmpty?: boolean;
}
export type SketchPage = Page<Sketch>;

export interface CreateSketchCommand {
  title: string;
  scope: SketchScope;
  /** Required for `project` sketches; absent otherwise. */
  projectId?: string;
}

/** Needs `If-Match` with the sketch version. */
export interface UpdateSketchCommand {
  title: string;
  expectedVersion?: number;
}

export interface CreateThoughtCommand {
  /** Optional client-chosen UUID, e.g. to restore a removed thought on undo. */
  id?: string;
  text: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
  shape?: ThoughtShape;
  /** Place an existing object the caller can read, from the sketch's workspace. */
  placement?: { type: 'draft'; id: string };
  /** Create the thought already linked to another one (the "+" beside a thought). */
  linkFrom?: { thoughtId: string; label?: string | null; linkId?: string };
  /** Project sketches only: the project message this thought quotes (e.g. when Undo restores it). */
  sourceProjectMessageId?: string;
  /**
   * Project sketches only (#252): the caller's own staged image of the sketch's project (PNG, JPEG, GIF or
   * WebP) becomes this thought's image and readable by the project, in the same transaction. Re-creating
   * the same thought id with its own image (undo) is accepted; any other published file is refused.
   */
  fileId?: string;
}

export interface CreatedThought {
  thought: Thought;
  link: ThoughtLink | null;
}

/** Needs `If-Match` with the thought version. At least one field. */
export interface UpdateThoughtCommand {
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  shape?: ThoughtShape;
  expectedVersion?: number;
  /** #228: resize uses the same server-issued transient lease as movement. */
  leaseId?: string;
}

/**
 * Moves several thoughts at once. Each move names the version it was made against; if any is
 * stale nothing moves and the answer is 409 {@link PositionsConflict}. Moves of different
 * thoughts never conflict with each other, so concurrent editors merge naturally.
 */
export interface MoveThoughtsCommand {
  moves: { id: string; x: number; y: number; expectedVersion: number }[];
  /** #228: server-issued drag lease, checked in the same native CAS transaction. */
  leaseId?: string;
}
export interface MovedThoughts {
  thoughts: Thought[];
}
export interface PositionsConflict {
  error: string;
  code: 'VERSION_CONFLICT';
  conflicts: { id: string; currentVersion: number; current: Thought }[];
}

export interface CreateLinkCommand {
  /** Optional client-chosen UUID, e.g. to restore a removed link on undo. */
  id?: string;
  fromId: string;
  toId: string;
  label?: string | null;
}

/** Changes only an existing connection's label; an empty or blank label clears it. */
export interface UpdateLinkLabelCommand {
  label: string | null;
  /** The label last read by the caller. Required; a changed label answers 409. */
  expectedLabel: string | null;
}

/** Nothing changed. Show the current label before offering another save. */
export interface LinkLabelConflict {
  error: string;
  code: 'LABEL_CONFLICT';
  currentLabel: string | null;
  current: ThoughtLink;
}

export type { PrincipalRef };
