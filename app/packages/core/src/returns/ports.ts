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
  ownerKey: string | null; createdByKey: string; parkedByDecisionId: string | null; createdAt: Date;
}
export interface ReturnDecision {
  id: string; projectId: string; title: string; rationale: string; status: string;
  proposedByKey: string; supersedesId: string | null; supersededById: string | null;
}
export interface ReturnResult {
  id: string; projectId: string; title: string; finding: 'positive' | 'negative'; evidence: string; createdByKey: string;
}
export interface ReturnMessage {
  id: string; projectId: string; conversationId: string; authorId: string; body: string; sequence: number; createdAt: Date;
}
export interface ReturnConversation { id: string; projectId: string; createdBy: string; opening: string }
export interface ReturnMaterial { id: string; projectId: string; title: string; version: number }
export interface ReturnSketch { id: string; workspaceId: string; projectId: string | null; title: string }
/** A project doc (#112) as it reads now: its current version and that version's reason. */
export interface ReturnDoc { id: string; projectId: string; title: string; version: number; reason: string }

/** Rows only; the repository makes no access decisions. `recipient` is the stream's audience key. */
export interface ReturnRepository {
  points(userId: string, keys: string[]): Promise<Map<string, StoredReturnPoint>>;
  /** Moves the point forward to `seq` (never back); the point it replaced becomes the previous one. */
  advance(userId: string, place: ResolvedPlace, seq: number): Promise<StoredReturnPoint>;
  /** Moves the point back to the previous one; a point without one is removed (the place is unviewed again). */
  restore(userId: string, key: string): Promise<StoredReturnPoint | null>;
  /** The recipient's audience rows after `afterSeq` (and before `beforeSeq`, when given), newest first. */
  audienceAfter(recipient: string, afterSeq: number, limit: number, beforeSeq?: number | null): Promise<AudienceEvent[]>;
  /** The recipient's own audience position of an event, or null when it is not theirs. */
  audienceSeq(recipient: string, eventId: string): Promise<number | null>;
  /** The recipient's last audience position at or before `at`, 0 when there is none. */
  audienceSeqAt(recipient: string, at: Date): Promise<number>;
  /** The recipient's last audience row. */
  lastEvent(recipient: string): Promise<{ id: string; seq: number } | null>;
  projects(ids: string[]): Promise<Map<string, { id: string; name: string }>>;
  work(ids: string[]): Promise<Map<string, ReturnWork>>;
  decisions(ids: string[]): Promise<Map<string, ReturnDecision>>;
  results(ids: string[]): Promise<Map<string, ReturnResult>>;
  /** Work items a result is linked to (any role), in the result's project. */
  resultWork(resultIds: string[]): Promise<Map<string, string[]>>;
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
