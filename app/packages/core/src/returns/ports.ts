import type { ActorRef } from '../work/ports.js';
import type { ReturnPlace } from '@flux/contracts';
import type { Principal } from '../principal.js';

/**
 * Ports of the return view (issue #106, foundation 8.8). Core states what it needs; the server
 * implements them with the access policy (`authorizeEvent`, `evaluateProject`, `visibleFilter`)
 * and the `@flux/db` rows, and passes them in. Nothing in `packages/core/src/returns` imports
 * those adapters.
 */

/** One of the reader's own `event_audience` rows joined to its event. Identifiers only. */
export interface AudienceEvent {
  id: string;
  /** Internal log position; never sent to clients. */
  seq: number;
  kind: string;
  workspaceId: string | null;
  objectId: string;
  /** `<kind>:<id>` of the principal that made the change. */
  actorId: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface StoredReturnPoint {
  seq: number;
  savedAt: Date;
  previousSeq: number | null;
  previousSavedAt: Date | null;
}

/** A place resolved for a principal who can currently read it. */
export interface ResolvedPlace {
  key: string;
  type: ReturnPlace['type'];
  projectId: string | null;
  conversationId: string | null;
}

/** Adapter over the core access policy. It never reveals objects the principal cannot see. */
export interface ReturnAccess {
  /** The project of a project or conversation the principal can read now; NotFoundError otherwise. */
  requirePlace(principal: Principal, place: Exclude<ReturnPlace, { type: 'home' }>): Promise<{ projectId: string; conversationId: string | null }>;
  /** The final check: may the principal receive this event now (the stream's `authorizeEvent`). */
  canReceive(principal: Principal, event: AudienceEvent): Promise<boolean>;
  /** Projects of the workspace that pass the policy's list filter (`visibleFilter`) for the principal now. */
  visibleProjects(principal: Principal, workspaceId: string): Promise<Set<string>>;
  /** Whether the principal may change the project (accept a proposed decision). */
  canWrite(principal: Principal, projectId: string): Promise<boolean>;
}

export interface ReturnWork {
  id: string; projectId: string; title: string; status: string; blocker: string | null;
  ownerKey: string | null; createdByKey: string; createdAt: Date;
  /** `YYYY-MM-DD` or null (#488). */
  dueOn: string | null;
}
export interface ReturnDecision {
  id: string; projectId: string; title: string; rationale: string; status: string;
  proposedByKey: string; supersedesId: string | null; supersededById: string | null;
}
export interface ReturnMessage {
  attachmentCount?: number;
  id: string; projectId: string; conversationId: string; author: ActorRef; body: string; sequence: number; createdAt: Date;
  /** The client or assistant that posted for its author ("Ada · via Claude Code"): the summary names it, as the message does. */
  via?: string | null;
  /** `via` names an agent whose answer its author showed everyone, not a local client: the summary says "Ada's Assistant" (#1424). */
  viaAgent?: boolean;
}
export interface ReturnConversation { id: string; projectId: string; createdBy: ActorRef; opening: string }
export interface ReturnMaterial { id: string; projectId: string; title: string; version: number }
export interface ReturnSketch { id: string; workspaceId: string; projectId: string | null; title: string }
/** A project doc (#112) as it reads now: its current version and that version's reason. */
export interface ReturnDoc { id: string; projectId: string; title: string; version: number; reason: string }

/**
 * The rows a summary can say something about (#1178): of these kinds, in a workspace, and by someone else, or by a rule (`automation`) on the
 * reader's behalf. Read so in SQL, a person's own changes (often most of their rows) are not read only to be left out.
 */
export interface AudienceKinds { kinds: string[]; automation: string }

/** A place whose rows `audienceAfter` keeps: a space, or a conversation. */
export type AudiencePlace = { projectId: string } | { conversationId: string };

/** Rows only; the repository makes no access decisions. `recipient` is the stream's audience key. */
export interface ReturnRepository {
  points(userId: string, keys: string[]): Promise<Map<string, StoredReturnPoint>>;
  /** Moves the point forward to `seq` (never back); the point it replaced becomes the previous one. */
  advance(userId: string, place: ResolvedPlace, seq: number): Promise<StoredReturnPoint>;
  /** Moves the point back to the previous one; a point without one is removed (the place is unviewed again). */
  restore(userId: string, key: string): Promise<StoredReturnPoint | null>;
  /**
   * The recipient's audience rows after `afterSeq` (and before `beforeSeq`, when given), newest first. With `place`, only the rows about
   * that space (its own events and its sketches') or that conversation (its messages), so a space's summary does not read every other
   * space's rows to find its own (#1178).
   */
  audienceAfter(recipient: string, afterSeq: number, limit: number, beforeSeq?: number | null, place?: AudiencePlace | null, of?: AudienceKinds | null): Promise<AudienceEvent[]>;
  /**
   * The position after which the recipient's newest `budget` audience rows after `afterSeq` lie (`afterSeq` when there are fewer): the
   * bound of one summary's reading, whatever its filters keep (#1191).
   */
  audienceFloor(recipient: string, afterSeq: number, budget: number): Promise<number>;
  /** The recipient's own audience position of an event, or null when it is not theirs. */
  audienceSeq(recipient: string, eventId: string): Promise<number | null>;
  /** The recipient's last audience row. */
  lastEvent(recipient: string): Promise<{ id: string; seq: number } | null>;
  projects(ids: string[]): Promise<Map<string, { id: string; name: string }>>;
  work(ids: string[]): Promise<Map<string, ReturnWork>>;
  decisions(ids: string[]): Promise<Map<string, ReturnDecision>>;
  messages(ids: string[]): Promise<Map<string, ReturnMessage>>;
  conversations(ids: string[]): Promise<Map<string, ReturnConversation>>;
  /** The time of the user's latest message per conversation (participation and replies). */
  lastPosts(userId: string, conversationIds: string[]): Promise<Map<string, Date>>;
  materials(ids: string[]): Promise<Map<string, ReturnMaterial>>;
  sketches(ids: string[]): Promise<Map<string, ReturnSketch>>;
  docs(ids: string[]): Promise<Map<string, ReturnDoc>>;
  /** Display names keyed by `<kind>:<id>`. */
  names(keys: string[]): Promise<Map<string, string>>;
}

export interface ReturnPorts {
  access: ReturnAccess;
  returns: ReturnRepository;
}
