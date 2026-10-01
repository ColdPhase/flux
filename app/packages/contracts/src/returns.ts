/**
 * The return view, "Since you left" (issue #106, foundation 8.8, pillar F5).
 *
 * A return point is saved on the server per person and place: Home, a project or one of its
 * conversations. The summary lists what changed after it, built only from the reader's own
 * stream audience with a final access check, so it never mentions places or objects the reader
 * cannot currently see. It carries no streaks, rankings or unread pressure: one short list and
 * at most one next step with its reason.
 */
export const RETURN_SUMMARY_PATH = '/api/v1/return';
export const RETURN_POINTS_PATH = '/api/v1/return-points';
export const RETURN_POINTS_RESTORE_PATH = '/api/v1/return-points/restore';

export type ReturnPlace =
  | { type: 'home' }
  | { type: 'project'; id: string }
  | { type: 'conversation'; id: string };

/** Whose changes: everything in the place, or only what concerns the reader (#133). */
export type ReturnScope = 'all' | 'mine';
/** Where the summary starts: the saved return point, or a fixed period before now (#133). */
export type ReturnPeriod = 'last-visit' | '24h' | '7d';

/**
 * Query of `GET /api/v1/return`: `place=home`, or `place=project|conversation&id=<uuid>`.
 * Optional (#133): `scope` (default `all`), `from` (default `last-visit`), `until=<mark>` to keep
 * the snapshot the reader is looking at, and `digest=1` for the sourced conversation digest.
 */
export interface ReturnSummaryQuery {
  place: ReturnPlace['type'];
  id?: string;
  scope?: ReturnScope;
  from?: ReturnPeriod;
  until?: string;
  digest?: '1' | '0';
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

export type ReturnItemKind = 'decision' | 'result' | 'work' | 'question' | 'message' | 'material' | 'sketch' | 'doc';

/** Where an item came from; the client turns it into a link. */
export type ReturnSource =
  | { type: 'work' | 'decision' | 'result'; id: string; projectId: string }
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
}

export interface ReturnNextStep {
  /** e.g. "Answer Ari's question" or "Review the result Nia attached". */
  text: string;
  /** Why this is the next step, e.g. "Ari asked you in “Camera or sensor?” on Sep 27." */
  reason: string;
  item: string;
  source: ReturnSource;
}

/** One quoted message of the digest; it opens at the message. */
export interface ReturnQuote {
  messageId: string;
  author: string;
  /** The first line of the message, shortened. */
  excerpt: string;
  at: string;
}

/**
 * "Summarize" (#133): the latest statements per conversation and the results recorded in the
 * summary's period and scope. Deterministic and sourced: quotes of whole messages, no model.
 */
export interface ReturnDigest {
  conversations: {
    conversationId: string;
    projectId: string;
    opening: string;
    /** Oldest first, at most three per conversation. */
    quotes: ReturnQuote[];
    /** How many more messages of the period are not quoted. */
    more: number;
  }[];
  results: { id: string; projectId: string; title: string; finding: 'positive' | 'negative'; author: string; at: string }[];
  /** Messages in the period that the digest covers. */
  messages: number;
}

export interface ReturnSummary {
  place: ReturnPlace;
  point: ReturnPoint;
  scope: ReturnScope;
  period: ReturnPeriod;
  /** Where this summary starts: the return point's time, or the start of the chosen period; null from the beginning. */
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
  /** Present when `digest=1` was asked for. */
  digest?: ReturnDigest;
}
