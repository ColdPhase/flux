/** Human live collaboration at an existing project object (issues #59/#61). */
export const LIVE_SESSIONS_PATH = '/api/v1/live-sessions';
export const liveSessionPath = (id: string) => `${LIVE_SESSIONS_PATH}/${id}`;
export const liveJoinPath = (id: string) => `${liveSessionPath(id)}/join`;
export const liveLeavePath = (id: string) => `${liveSessionPath(id)}/leave`;
export const livePresentPath = (id: string) => `${liveSessionPath(id)}/present`;

/** The anchor is an existing object; a live session does not duplicate its saved work. */
export type LiveContextRef =
  | { type: 'conversation'; id: string }
  | { type: 'work'; id: string }
  | { type: 'sketch'; id: string };

/** Identifiers only. Receivers load text through the normal authorized Flux API. */
export type LivePresentationRef =
  | { type: 'message'; id: string; version: number }
  | { type: 'material'; id: string; version: number }
  | { type: 'work'; id: string; version: number }
  | { type: 'result'; id: string; version: number }
  | { type: 'sketch'; id: string; version: number; selectedThoughtIds?: string[] };

export interface StartLiveSessionCommand {
  context: LiveContextRef;
  /** Caller-chosen UUID permits retry after a lost response. */
  clientSessionId: string;
}

export interface PresentLiveContextCommand {
  ref: LivePresentationRef;
  /** Caller-chosen UUID deduplicates a presentation retry. */
  clientEventId: string;
}

export interface LiveSession {
  id: string;
  projectId: string;
  context: LiveContextRef;
  /** `rotating` is a fail-closed media fence during access changes/recovery. */
  state: 'available' | 'rotating' | 'ended';
  generation: number;
  createdBy: string;
  createdAt: string;
  /** Connected people from the SFU, never from token issuance; null when it cannot be queried. */
  participants: { userId: string; joinedAt: string }[] | null;
}

export interface LiveJoinGrant {
  session: LiveSession;
  /** Operator-provided WSS endpoint. Never inferred from an untrusted request header. */
  mediaUrl: string;
  /** Short-lived room-scoped LiveKit token. This is not a Flux API token. */
  token: string;
  expiresAt: string;
}
