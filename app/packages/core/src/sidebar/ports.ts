import type { Principal } from '../principal.js';

/**
 * Ports of the sidebar's own state (#1250): the order of a person's Spaces list and "Mark all as read". Core states what it needs; the
 * server implements it with the access policy and the `@flux/db` rows (`apps/server/src/sidebar/adapters.ts`).
 */

export interface SidebarAccess {
  /** The workspaces the person belongs to. */
  workspaceIds(principal: Principal): Promise<string[]>;
  /** The same, without the encrypted ones that wait to be unlocked: nothing of them is read. */
  readableWorkspaceIds(principal: Principal): Promise<string[]>;
  /** The spaces of the workspace the person is in (their sidebar's spaces). */
  memberProjects(principal: Principal, workspaceId: string): Promise<Set<string>>;
  /** The workspace the person's own events are recorded in: the company, or the first workspace they belong to. */
  eventWorkspace(principal: Principal): Promise<string | null>;
}

export interface UnreadChat { agentId: string; before: string | null; now: string }

export interface SidebarRepository {
  order(userId: string): Promise<string[]>;
  /** The Everyone spaces among those of these workspaces: they are always first and never stored. */
  everyone(workspaceIds: string[]): Promise<Set<string>>;
  /** Writes the whole order, one writer at a time per person. */
  replaceOrder(userId: string, projectIds: string[]): Promise<void>;
  /** The newest of the person's own audience rows: the position everything is read up to. */
  lastEvent(recipient: string): Promise<{ id: string; seq: number } | null>;
  audienceSeq(recipient: string, eventId: string): Promise<number | null>;
  /** The saved return points of these places (`project:<id>`), by key. */
  points(userId: string, keys: string[]): Promise<Map<string, { seq: number }>>;
  /** Moves a space's point forward to `seq`; the point it replaced becomes the previous one. */
  advance(userId: string, projectId: string, seq: number): Promise<void>;
  /** Puts a space's point back, only while it still stands at `seq`. True when it was put back. */
  restore(userId: string, projectId: string, seq: number): Promise<boolean>;
  /** Marks the chats of the person's agents that have something unread as read now; what was read before is returned for Undo. */
  readChats(ownerUserId: string): Promise<UnreadChat[]>;
  /** Puts a chat's read time back, only while it is still the one `readChats` set. */
  restoreChat(ownerUserId: string, chat: UnreadChat): Promise<boolean>;
}

export interface SidebarPorts {
  access: SidebarAccess;
  repository: SidebarRepository;
  events: { record(principal: Principal, workspaceId: string, kind: string, objectId: string, data: Record<string, unknown>): Promise<void> };
}

export interface SidebarUnitOfWork {
  /** One transaction per use case. */
  run<T>(work: (ports: SidebarPorts) => Promise<T>): Promise<T>;
}
