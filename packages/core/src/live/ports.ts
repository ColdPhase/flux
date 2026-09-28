import type { LiveContextRef, LivePresentationPage, LivePresentationRef, LiveSession } from '@flux/contracts';
import type { Principal } from '../principal.js';

/** Media rooms are opaque and generation-scoped; an old token never joins a replacement room. */
export interface LiveSessionRecord extends Omit<LiveSession, 'participants'> {
  roomId: string;
}

export interface LiveAccess {
  /** Resolves the current anchor, checks its read policy, and rejects a private sketch. */
  resolveContext(principal: Principal, ref: LiveContextRef): Promise<{ projectId: string }>;
  /** Checks the current project membership/grants on every discovery, join and present. */
  requireProject(principal: Principal, projectId: string): Promise<void>;
  /** Checks object existence, version and audience against the session project. */
  requirePresentation(principal: Principal, projectId: string, ref: LivePresentationRef): Promise<void>;
}

export interface LiveRepository {
  /** Idempotent on (creator, clientSessionId); a changed context must conflict. */
  createOrGet(principal: Principal, projectId: string, context: LiveContextRef, clientSessionId: string, ensureRoom: (roomId: string) => Promise<void>): Promise<LiveSessionRecord>;
  find(sessionId: string): Promise<LiveSessionRecord | null>;
  /** Holds current project, anchor and session read locks through the response. */
  withRead<T>(principal: Principal, sessionId: string, read: (session: LiveSessionRecord) => Promise<T>): Promise<T>;
  /** Holds policy and session locks through room creation and JWT signing. */
  withAdmission<T>(principal: Principal, sessionId: string, issue: (session: LiveSessionRecord) => Promise<T>): Promise<T>;
  /** Idempotent on (session, creator, clientEventId); a changed ref must conflict. */
  present(sessionId: string, principal: Principal, ref: LivePresentationRef, clientEventId: string): Promise<void>;
  /** One transaction rechecks project, anchor, session generation and every returned source. */
  pagePresentations(principal: Principal, sessionId: string, after: string | null, limit: number): Promise<LivePresentationPage>;
}

export interface LiveMedia {
  /** Creates a fresh generation once. The SFU must run with auto_create=false. */
  ensureRoom(roomId: string): Promise<void>;
  /** Existing-session admission must never recreate a retired/missing room ID. */
  requireRoom(roomId: string): Promise<void>;
  /** The returned token grants one human identity, one room and no room administration. */
  grant(roomId: string, userId: string): Promise<{ token: string; expiresAt: Date }>;
  /** Actual connected identities, never identities merely issued a token. */
  participants(roomId: string): Promise<{ userId: string; joinedAt: string }[]>;
  /** Raw SFU occupancy, including identities/statuses hidden from user-visible presence. */
  occupancy(roomId: string): Promise<number>;
  /** Disconnects a participant; generation rollover still handles old tokens. */
  removeParticipant(roomId: string, userId: string): Promise<void>;
  /** Deletes a generation room so stale self-hosted tokens cannot rejoin it. */
  deleteRoom(roomId: string): Promise<void>;
}

export interface LivePorts {
  access: LiveAccess;
  sessions: LiveRepository;
  media: LiveMedia;
  mediaUrl: string;
}
