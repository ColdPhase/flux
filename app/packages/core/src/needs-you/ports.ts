import type { Principal } from '../principal.js';
import type { DecisionRecord, WorkRepository } from '../work/ports.js';
import type { NotificationRecord } from '../push/ports.js';

/**
 * Ports of the Inbox "Needs you" queue (#342). Core states what it needs; the server implements
 * them with the access policy and the `@flux/db` rows. Nothing in `packages/core/src/needs-you`
 * imports those adapters.
 */

export type StoredNeedsYouState = 'done' | 'declined' | 'snoozed';

export interface StoredNeedsYou {
  key: string;
  state: StoredNeedsYouState;
  until: Date | null;
  untilWorkId: string | null;
  updatedAt: Date;
}

export interface NeedsYouRepository {
  states(userId: string): Promise<StoredNeedsYou[]>;
  putState(userId: string, key: string, value: { state: StoredNeedsYouState; until: Date | null; untilWorkId: string | null }): Promise<void>;
  deleteStates(userId: string, keys: string[]): Promise<void>;
  /** Proposed decisions of exactly these (already readable) projects, newest first. */
  proposedDecisions(projectIds: string[], limit: number): Promise<DecisionRecord[]>;
  /** Sets or clears the read time of the person's own notification; false when it is not theirs. */
  setNotificationRead(userId: string, id: string, read: boolean): Promise<boolean>;
  /** The status of each task that exists, by id. */
  workStatuses(ids: string[]): Promise<Map<string, string>>;
}

/** Adapter over the core access policy. It never reveals what the principal cannot read. */
export interface NeedsYouAccess {
  /** The workspaces the principal belongs to. */
  workspaceIds(principal: Principal): Promise<string[]>;
  /** Projects of the workspace that pass the policy's list filter (`visibleFilter`) for the principal now. */
  visibleProjects(principal: Principal, workspaceId: string): Promise<Set<string>>;
  /** Whether the principal may accept a decision in the project (current write access, O-009 DA-2). */
  canAccept(principal: Principal, projectId: string): Promise<boolean>;
  /** Up to `limit` people who may accept a decision in the project now, with their names. */
  accepters(projectId: string, limit: number): Promise<{ id: string; name: string }[]>;
  projectNames(ids: string[]): Promise<Map<string, string>>;
}

export interface NeedsYouInbox {
  /** The recipient's notifications whose source they may still read, newest first. */
  listReadable(userId: string, limit: number): Promise<{ items: NotificationRecord[] }>;
}

export interface NeedsYouPorts {
  access: NeedsYouAccess;
  repository: NeedsYouRepository;
  inbox: NeedsYouInbox;
  work: Pick<WorkRepository, 'listAssignedVisible' | 'links' | 'titles' | 'names' | 'findWork' | 'findDecision' | 'taskPlans'>;
}
