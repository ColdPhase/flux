// Wire types for sketches: thoughts on a map and the links between them (issue #69).
// Every route requires a live session and follows the access contract in access.ts: an
// invisible sketch answers 404, a visible one the caller may not change answers 403.
// Changes accept `Idempotency-Key`; versioned changes need `If-Match` (see below).

import type { Page, PageQuery, PrincipalRef } from './access.js';

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
 * `private`: only the person who created it. Workspace owners and admins do not see it, and
 * agents never do. Sketches bound to a DM follow once conversations exist (#36).
 */
export type SketchScope = 'project' | 'private';
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
} as const;
export const DEFAULT_THOUGHT_SIZE = { width: 184, height: 72 } as const;

export interface PersonRef {
  kind: 'human' | 'agent';
  id: string;
  name: string;
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
  createdBy: PersonRef;
  version: number;
  createdAt: string;
  updatedAt: string;
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
}
export type SketchPage = Page<Sketch>;

export interface CreateSketchCommand {
  title: string;
  scope: SketchScope;
  /** Required for `project` sketches; absent for `private` ones. */
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
}

/**
 * Moves several thoughts at once. Each move names the version it was made against; if any is
 * stale nothing moves and the answer is 409 {@link PositionsConflict}. Moves of different
 * thoughts never conflict with each other, so concurrent editors merge naturally.
 */
export interface MoveThoughtsCommand {
  moves: { id: string; x: number; y: number; expectedVersion: number }[];
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

export type { PrincipalRef };
