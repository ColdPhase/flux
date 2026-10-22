// "Needs you" (#342, F-026 S1/S11): the one queue of what asks something of the signed-in person.
// It is computed for the person from current access rows, never stored; only what the person did
// with an item (done, not now, declined) is stored, per person.
import type { AssistantRequestIdentity } from './push.js';

export const NEEDS_YOU_PATH = '/api/v1/needs-you';
export const needsYouItemPath = (key: string) => `${NEEDS_YOU_PATH}/${encodeURIComponent(key)}`;

/**
 * What kind of need an item is. `question` is a notification asking the person to respond, including an
 * assistant join request linked to its saved request-cycle identity. Agent questions with ready-made answers
 * remain outside this queue.
 */
export const NEEDS_YOU_KINDS = ['decision', 'question', 'blocked', 'mention'] as const;
export type NeedsYouKind = typeof NEEDS_YOU_KINDS[number];

/** A task a "when it is done" snooze can wait for. */
export interface NeedsYouTaskRef {
  id: string;
  number: number;
  title: string;
}

/**
 * Who may still accept a proposed decision. Acceptance is one person's act (O-009 DA-2): the first
 * person with write access who accepts decides, so the others are "waiting" only until then.
 */
export interface NeedsYouAccepter {
  id: string;
  name: string;
  you: boolean;
}

export interface NeedsYouDecision {
  id: string;
  version: number;
  proposedBy: { kind: 'human' | 'agent'; id: string; name: string };
  /** What it is based on: the titles of its sources, in order. */
  basedOn: string[];
  /** Work it affects. */
  affects: NeedsYouTaskRef[];
  /** People who can accept it now, you first; at most 6. */
  accepters: NeedsYouAccepter[];
  /** Whether you can accept it (you hold write access to the project). */
  canAccept: boolean;
  /** It would replace this current rule when accepted. */
  supersedes: string | null;
}

export interface NeedsYouBlocked {
  workId: string;
  number: number;
  version: number;
  /** Why it is blocked, in the owner's words; null when none was recorded. */
  blocker: string | null;
  since: string;
  /** What it waits for: the first unfinished prerequisite, when it has any. */
  waitingFor: NeedsYouTaskRef | null;
  /** Set when this item is for the person a blocked task waits for (#550): who is waiting, "Ada is waiting for you". */
  waitedBy?: string | null;
  /** The person a blocked task waits for, so an Undo of Unblock can put them back. */
  waitingForUserId?: string | null;
}

export interface NeedsYouItem {
  /** `decision:<id>`, `blocked:<id>`, `note:<notification id>` or `assistant:<run id>`. Stable while the need lasts. */
  key: string;
  kind: NeedsYouKind;
  title: string;
  /** The reason or message, one or two lines. */
  detail: string;
  project: { id: string; name: string } | null;
  /** Who it comes from: an agent or a person; null for a blocked task of yours. */
  from: { kind: 'human' | 'agent'; id: string; name: string } | null;
  at: string;
  /** Where it opens in full (a same-origin path). */
  url: string;
  decision: NeedsYouDecision | null;
  blocked: NeedsYouBlocked | null;
  /** Why a notification-based item reached you (`mention`, `question` or `invitation`); null for the others. */
  reason: 'mention' | 'question' | 'invitation' | null;
  /** Immutable request-cycle identity, only when the notification links a saved assistant join-question snapshot. */
  assistantRequestIdentity?: AssistantRequestIdentity | null;
  /** The task "Not now: when #N is done" waits for; null when the item has none. */
  snoozeTask: NeedsYouTaskRef | null;
  /**
   * Your assistant's undecided waiting changes of one request (F-027 AST-5.6), only for their owner: its
   * button is the object's own verb (*Close*, *Remove*), *Apply* only for a mix.
   */
  assistantChanges?: NeedsYouAssistantChanges | null;
  assistantNote?: string;
  assistantDraft?: boolean;
}

export interface NeedsYouAssistantChanges {
  runId: string;
  suggestion?: boolean;
  verb: string;
  summary: string;
  changes: { id: string; version: number; phrase: string; objectTitle: string; line: string | null; preview?: string }[];
}

export interface NeedsYouResponse {
  /** Most urgent first: decisions, questions, blocked tasks, then mentions; newest first within a kind. */
  items: NeedsYouItem[];
  /** How many items need you now; the sidebar and Home show this number. */
  count: number;
  /** How many are put off for later at the moment. */
  later: number;
  /** How many you marked done or declined in the last 24 hours ("4 done today"). */
  doneToday: number;
}

/**
 * `POST /api/v1/needs-you/:key`: what you do with one item. `done` and `decline` remove it for
 * you (a decision stays proposed for everyone else); `snooze` brings it back at `until` or
 * when the task `untilWorkId` is finished.
 */
export type ResolveNeedsYouCommand =
  | { action: 'done' }
  | { action: 'decline' }
  | { action: 'snooze'; until: string }
  | { action: 'snooze'; untilWorkId: string };

export interface NeedsYouResolved {
  key: string;
  state: 'done' | 'declined' | 'snoozed';
  until: string | null;
  untilWorkId: string | null;
}

/** Longest snooze by time, so nothing is put off for years. */
export const MAX_SNOOZE_DAYS = 60;
