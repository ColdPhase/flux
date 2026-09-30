import {
  LIVE_INVITATIONS_PATH, LIVE_SESSIONS_PATH, liveInvitationReplyPath, liveInvitePath, liveJoinPath, liveLeavePath,
  livePresentPath, livePresentationsPath, liveSessionPath,
  type LiveContextRef, type LiveJoinGrant, type LivePresentationPage, type LivePresentationRef, type LiveSession,
} from '@flux/contracts';
import { request } from '../api/client';

/**
 * The live-session API of #61 (issue #62 interface). Every call is authorized again on the
 * server; nothing here decides who may see a session. Media tokens are room grants only.
 */
export type LiveCapability = 'configured' | 'unavailable';

export interface LiveInvitationRow {
  id: string;
  sessionId: string;
  projectId: string;
  inviterId: string;
  recipientId: string;
  response: 'pending' | 'later' | 'text';
  createdAt: string;
  respondedAt: string | null;
}

export interface LiveInvitationReply {
  invitation: LiveInvitationRow;
  next: { kind: 'stay' } | { kind: 'open_project_conversation'; projectId: string; context: LiveContextRef };
}

export const liveCapability = (signal?: AbortSignal) =>
  request<{ status: LiveCapability }>(`${LIVE_SESSIONS_PATH}/capabilities`, { signal }).then((body) => body.status);

export const startSession = (context: LiveContextRef, clientSessionId: string) =>
  request<LiveSession>(LIVE_SESSIONS_PATH, { method: 'POST', body: { context, clientSessionId } });

export const getSession = (id: string, signal?: AbortSignal) => request<LiveSession>(liveSessionPath(id), { signal });

export const joinSession = (id: string) => request<LiveJoinGrant>(liveJoinPath(id), { method: 'POST' });

export const leaveSession = (id: string) => request<void>(liveLeavePath(id), { method: 'POST' });

export const presentInSession = (id: string, ref: LivePresentationRef, clientEventId: string) =>
  request<void>(livePresentPath(id), { method: 'POST', body: { ref, clientEventId } });

export const listPresentations = (id: string, after: string | null, signal?: AbortSignal) =>
  request<LivePresentationPage>(`${livePresentationsPath(id)}?limit=50${after ? `&after=${after}` : ''}`, { signal });

export const discoverSessions = (projectId: string, signal?: AbortSignal) =>
  request<{ items: LiveSession[]; nextBefore: string | null }>(`/api/v1/projects/${projectId}/live-sessions?limit=20`, { signal });

export const inviteToSession = (id: string, recipientId: string) =>
  request<LiveInvitationRow>(liveInvitePath(id), { method: 'POST', body: { recipientId } });

export const replyToInvitation = (id: string, choice: 'later' | 'text') =>
  request<LiveInvitationReply>(liveInvitationReplyPath(id), { method: 'POST', body: { choice } });

export const pendingInvitations = (signal?: AbortSignal) =>
  request<{ items: LiveInvitationRow[]; nextCursor: string | null }>(`${LIVE_INVITATIONS_PATH}?limit=50`, { signal });
