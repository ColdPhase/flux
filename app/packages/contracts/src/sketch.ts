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
/** GET: the exact audience and content of copying a DM sketch into a project. POST: make the copy (#96). */
export const sketchPromotionPath = (sketchId: string) => `${sketchPath(sketchId)}/promotion`;

/**
 * `project`: readable by everyone who can read the project, changeable by its contributors.
 * `private`: only the person who created it. Workspace owners and admins do not see it, and
 * agents never do.
 * `dm` (#96): bound to one direct message (`dmId`). Its audience is exactly the DM's current
 * participants; leaving the DM or the workspace ends access on the next request. Owners, admins
 * and agents outside the DM get 404. A 1:1 DM whose other person left is read-only (403 on
 * changes) until that person reopens it.
 */
export type SketchScope = 'project' | 'private' | 'dm';
export type ThoughtShape = 'card' | 'pill' | 'circle';
export const THOUGHT_SHAPES: readonly ThoughtShape[] = ['card', 'pill', 'circle'];

/** Plane coordinates are integers in [-100000, 100000]; sizes in [80, 800] × [40, 800]. */
export const SKETCH_LIMITS = {
  /** Messages per "Start sketch from these messages". */
  fromMessages: 50,
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
  /** The direct message a `dm` sketch belongs to; null otherwise. */
  dmId: string | null;
  title: string;
  createdBy: PersonRef;
  /**
   * A project sketch copied from a DM sketch (#96): who copied it and when. The copy is
   * independent; it never names the DM and nothing in the DM syncs into it later.
   */
  origin: { kind: 'dm_copy'; copiedBy: PersonRef; copiedAt: string } | null;
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

/**
 * The message a thought was started from (#96): its author and time as they were then.
 * `dmMessageId` names the message in the sketch's own DM; a copy in a project has only the
 * author and time (null id), because the DM is not part of the project.
 */
export interface ThoughtSource {
  author: { id: string; name: string };
  sentAt: string;
  dmMessageId: string | null;
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

/** A project copy of a DM sketch, listed on the DM sketch only when the caller can open it. */
export interface SketchCopy {
  sketchId: string;
  projectId: string;
  projectName: string;
  copiedAt: string;
}

export interface SketchDetail extends Sketch {
  thoughts: Thought[];
  links: ThoughtLink[];
  /** `dm` sketches: the project copies the caller can open. Empty otherwise. */
  copies: SketchCopy[];
}

export interface SketchListQuery extends PageQuery {
  projectId?: string;
  /** Only the sketches of this direct message (#96). */
  dmId?: string;
}
export type SketchPage = Page<Sketch>;

export interface CreateSketchCommand {
  title: string;
  scope: SketchScope;
  /** Required for `project` sketches; absent otherwise. */
  projectId?: string;
  /** Required for `dm` sketches; absent otherwise. The caller must be a participant. */
  dmId?: string;
  /**
   * `dm` sketches only: "Start sketch from these messages". Each message of the DM becomes one
   * thought with its author and time as its source, in conversation order (up to 50).
   */
  fromMessageIds?: string[];
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
  /**
   * DM sketches (#96): the message of this sketch's DM the thought quotes, e.g. when undo restores
   * a removed thought. The server takes its author and time from the message itself.
   */
  sourceMessageId?: string;
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

/** Where a promotion copies the sketch: a new restricted project, or an existing project the caller can change. */
export type PromotionTarget = { kind: 'new'; name: string } | { kind: 'existing'; projectId: string };

/** One person (or agent) who could open the copy, and why. */
export interface PromotionPerson {
  kind: 'human' | 'agent';
  id: string;
  name: string;
  /** `participant`: in the DM and given access; `manager`: a workspace owner or admin; `project`: already in the project. */
  reason: 'participant' | 'manager' | 'project';
}

/**
 * `GET /api/v1/sketches/:id/promotion?target=new|projectId=…` (#96): exactly who could open the
 * copy and exactly what goes in, computed by the access policy from current rows. Nothing is
 * shared until `POST` with the same `token`; if anything changed meanwhile it answers
 * `409 PROMOTION_CHANGED` with the new preview.
 */
export interface SketchPromotionPreview {
  sketchId: string;
  /** null when the caller has nowhere to copy it (no project they can change and no right to create one). */
  target: { kind: 'new' } | { kind: 'existing'; projectId: string; projectName: string } | null;
  /** Workspace owners and admins may create a project; others copy into a project they can change. */
  canCreateProject: boolean;
  /** Projects of the workspace the caller can change, by name. */
  projects: { id: string; name: string }[];
  /** Everyone who could open the copy, people first. */
  audience: PromotionPerson[];
  /** DM participants who would not see the copy (an existing project they are not in). */
  leftOut: { id: string; name: string }[];
  /** What goes in: the thoughts with their links, and how many of them came from messages. */
  content: { thoughts: number; links: number; fromMessages: number };
  /** What stays in the DM: its other messages, and everything written there later. */
  staysInDm: { messages: number };
  /** Opaque; names this exact target, audience and content. */
  token: string;
}

export interface PromoteSketchCommand {
  target: PromotionTarget;
  /** The `token` of the preview the person saw. */
  token: string;
  /**
   * A new project only (#188): `grant` (the default, #96) gives the DM's other participants access
   * as contributors; `none` gives nobody but the workspace's owners and admins access. Send the same
   * value as the preview's `participants` query, since the token names the readers.
   */
  participants?: PromotionParticipants;
}

/** Whether a new project from a DM sketch is granted to the DM's other participants (#188). */
export type PromotionParticipants = 'grant' | 'none';

export interface PromotedSketch {
  sketch: Sketch;
  project: { id: string; name: string };
}

export type { PrincipalRef };
