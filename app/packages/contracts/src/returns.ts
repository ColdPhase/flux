/**
 * The return view, "Since you left" (issue #106, foundation 8.8, pillar F5).
 *
 * A return point is saved on the server per person and place: Home, a project or one of its
 * conversations. The summary lists what changed after it, built only from the reader's own
 * stream audience with a final access check, so it never mentions places or objects the reader
 * cannot currently see. It carries no streaks, rankings or unread pressure: one short list and
 * at most one next step with its reason.
 */
import type { LockedWorkspaceRef } from './encryption.js';

export const RETURN_SUMMARY_PATH = '/api/v1/return';
export const RETURN_POINTS_PATH = '/api/v1/return-points';
export const RETURN_POINTS_RESTORE_PATH = '/api/v1/return-points/restore';

export type ReturnPlace =
  | { type: 'home' }
  | { type: 'project'; id: string }
  | { type: 'conversation'; id: string };

/** Query of `GET /api/v1/return`: `place=home`, or `place=project|conversation&id=<uuid>`. It always starts at the saved return point. */
export interface ReturnSummaryQuery {
  place: ReturnPlace['type'];
  id?: string;
}

/** `PUT /api/v1/return-points`: saves the point after the person viewed the place. */
export interface SaveReturnPointCommand {
  place: ReturnPlace;
  /** The `mark` of the summary the person saw; `null` saves the start of their audience. */
  mark: string | null;
}

/** `POST /api/v1/return-points/restore`: moves the point back to where it was before the last save. */
export interface RestoreReturnPointCommand {
  place: ReturnPlace;
}

export interface ReturnPoint {
  place: ReturnPlace;
  /** When the point was saved; `null` when the person has never viewed this place. */
  savedAt: string | null;
  /** Whether the point can be moved back to the previous visit. */
  canRestore: boolean;
}

export type ReturnItemKind = 'decision' | 'work' | 'question' | 'message' | 'material' | 'sketch' | 'doc';

/** Where an item came from; the client turns it into a link. */
export type ReturnSource =
  | { type: 'work' | 'decision'; id: string; projectId: string }
  | { type: 'message'; projectId: string; conversationId: string; messageId: string }
  | { type: 'material'; projectId: string; materialId: string; version: number }
  | { type: 'sketch'; sketchId: string; projectId: string | null }
  /** A project doc (#112): `since` is the last version before these changes, so the client can show what changed. */
  | { type: 'doc'; projectId: string; docId: string; version: number; since: number | null };

export interface ReturnItem {
  /** Stable within one summary (the source object). */
  id: string;
  kind: ReturnItemKind;
  /** Human language, e.g. "Current rule changed: exclude items guests can't open". */
  text: string;
  /** A second line, e.g. "Previously: include archived items", or "No reason was recorded." */
  detail: string | null;
  needsYou: boolean;
  /** The latest change this item summarizes. */
  at: string;
  /** Who made the latest change, when known. */
  actor: string | null;
  source: ReturnSource;
  /** The project the item belongs to; `null` for a private sketch. */
  project: { id: string; name: string } | null;
  /** Work only: the task's due day (`YYYY-MM-DD`, #763 H11-5); absent for none. */
  dueOn?: string;
}

export interface ReturnNextStep {
  /** e.g. "Answer Ari's question" or "Review the decision Nia proposed". */
  text: string;
  /** Why this is the next step, e.g. "Ari asked you in “Camera or sensor?” on Sep 27." */
  reason: string;
  item: string;
  source: ReturnSource;
  /** A task's due day (`YYYY-MM-DD`, #763 H11-5), for the client to say in the reader's words; absent for none. */
  dueOn?: string;
}

export interface ReturnSummary {
  /**
   * F-030: the caller's encrypted workspaces that are locked on this server; their items are left out, and the page
   * draws one "Waiting to be unlocked" row for each. Absent when none is locked.
   */
  lockedWorkspaces?: LockedWorkspaceRef[];
  place: ReturnPlace;
  point: ReturnPoint;
  /** Where this summary starts: the return point's time; null from the beginning. */
  since: string | null;
  /** Opaque: pass it to `PUT /api/v1/return-points` once the person has seen this summary. */
  mark: string | null;
  /** Newest first, at most 40 items. */
  items: ReturnItem[];
  /** How many of `items` need you. Only visible items are ever counted. */
  needsYou: number;
  /** More visible changes happened than `items` shows. */
  more: boolean;
  nextStep: ReturnNextStep | null;
}
