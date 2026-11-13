/** Human live collaboration at an existing project object (issues #59/#61). */
export const LIVE_SESSIONS_PATH = '/api/v1/live-sessions';
export const liveSessionPath = (id: string) => `${LIVE_SESSIONS_PATH}/${id}`;
export const LIVE_CAPABILITIES_PATH = `${LIVE_SESSIONS_PATH}/capabilities`;
/** The spaces you can open where a call is on with someone in it (F-041): the call glyph in the sidebar and the Spaces list. */
export const LIVE_SPACES_PATH = `${LIVE_SESSIONS_PATH}/spaces`;
export interface LiveSpacesResponse { projectIds: string[] }

/** The calls of a space's conversation, or of one task's discussion with `?task=<id>` (F-041 point 6): the conversation's call lines. */
export const projectCallsPath = (projectId: string) => `/api/v1/projects/${projectId}/calls`;

/**
 * One call as its line in the conversation (F-041): who started it and when, who has been in it, and while it is on who is in it now.
 * Identifiers and times only: never a recap of what was said, also in an encrypted space. It is an event, not a message.
 */
export interface LiveCallLine {
  id: string;
  context: LiveContextRef;
  startedBy: string;
  startedAt: string;
  /** Null while the call is on. */
  endedAt: string | null;
  /** Who has been in it, first join first (the starter among them once connected). */
  joinedBy: string[];
  /** While it is on: who is in it now, as the media server says; null when that cannot be read or once it ended. */
  inCall: string[] | null;
}
export interface LiveCallLinesResponse { items: LiveCallLine[] }
export const projectLiveSessionsPath = (projectId: string) => `/api/v1/projects/${projectId}/live-sessions`;
export const liveJoinPath = (id: string) => `${liveSessionPath(id)}/join`;
export const liveLeavePath = (id: string) => `${liveSessionPath(id)}/leave`;
export const livePresentPath = (id: string) => `${liveSessionPath(id)}/present`;
export const livePresentationsPath = (id: string) => `${liveSessionPath(id)}/presentations`;
export const liveInvitePath = (id: string) => `${liveSessionPath(id)}/invitations`;
export const LIVE_INVITATIONS_PATH = '/api/v1/live-invitations';
/** Every kind of place a call can belong to. */
export const LIVE_CONTEXT_TYPES = ['space', 'conversation', 'work', 'sketch', 'doc'] as const satisfies readonly LiveContextRef['type'][];
export const liveInvitationReplyPath = (id: string) => `${LIVE_INVITATIONS_PATH}/${id}/reply`;

/**
 * The anchor is an existing object; a live session does not duplicate its saved work. `space` is a call of the space itself, started from
 * its conversation ("Call in <space>", F-041); its id is the space's (project) id.
 */
export type LiveContextRef =
  | { type: 'space'; id: string }
  | { type: 'conversation'; id: string }
  | { type: 'work'; id: string }
  | { type: 'sketch'; id: string }
  | { type: 'doc'; id: string };

/** Identifiers only. Receivers load text through the normal authorized Flux API. */
export type LivePresentationRef =
  | { type: 'message'; id: string; version: number }
  | { type: 'material'; id: string; version: number }
  | { type: 'work'; id: string; version: number }
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

/** Committed references only; the object body is loaded through its own authorized API. */
export interface LivePresentation {
  id: string;
  generation: number;
  createdBy: string;
  ref: LivePresentationRef;
  createdAt: string;
}

export interface LivePresentationPage {
  items: LivePresentation[];
  /** ID of the last visible item, or null when there is no further visible item. */
  nextAfter: string | null;
}

/** The recipient is an opaque Flux user ID, not necessarily a UUID. */
export interface InviteLiveSessionCommand { recipientId: string }
export interface ReplyLiveInvitationCommand { choice: 'later' | 'text' }

export interface LiveSession {
  id: string;
  projectId: string;
  context: LiveContextRef;
  /** `rotating` and `ending` both deny admission while the old room is retired. */
  state: 'available' | 'rotating' | 'ending' | 'ended';
  generation: number;
  createdBy: string;
  createdAt: string;
  /** Who has been in the call, first join first (F-041): with `createdBy` alone, nobody else has joined it yet. */
  joinedBy: string[];
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
