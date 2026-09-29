import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { ServiceUnavailableError, type LiveMedia } from '@flux/core';

const ROOM_ID = /^[A-Za-z0-9_-]{16,128}$/;
const GRANT_TTL_SECONDS = 90;
const MAX_USER_ID_BYTES = 90;

function participantIdentity(userId: string): string {
  if (!userId || Buffer.byteLength(userId, 'utf8') > MAX_USER_ID_BYTES ||
    Array.from(userId).some((char) => {
      const code = char.codePointAt(0)!;
      return code < 32 || code === 127;
    }))
    throw new Error('Invalid Flux user ID');
  return `u_${Buffer.from(userId, 'utf8').toString('base64url')}`;
}

function userIdFromIdentity(identity: string): string | null {
  if (!/^u_[A-Za-z0-9_-]{1,126}$/.test(identity)) return null;
  try {
    const userId = Buffer.from(identity.slice(2), 'base64url').toString('utf8');
    return participantIdentity(userId) === identity ? userId : null;
  } catch {
    // Other LiveKit clients must not make the whole presence query fail.
    return null;
  }
}

/** A connected SFU participant and the admission id its grant carries as metadata. */
export interface ParticipantAdmission {
  userId: string;
  /** Null for a participant without a well-formed Flux admission id. */
  admissionId: string | null;
}

export interface LiveMediaAdapter extends LiveMedia {
  participants(roomId: string): Promise<{ userId: string; joinedAt: string }[]>;
  /** Every Flux participant the SFU still holds in the room, whatever its connection state. */
  participantAdmissions(roomId: string): Promise<ParticipantAdmission[]>;
  removeParticipant(roomId: string, userId: string): Promise<void>;
  /**
   * Drops every publish/subscribe/data permission, then disconnects the participant. The
   * permission drop comes first so a token the SFU refreshes meanwhile carries none (#128).
   * Absence of the person or room counts as done.
   */
  revokeParticipant(roomId: string, userId: string): Promise<void>;
  deleteRoom(roomId: string): Promise<void>;
}

export interface LiveMediaConfig {
  /** Private SFU origin, reachable only by the API: room service calls and proxied signaling. */
  apiUrl: string;
  /** Private signaling origin (the API origin with a ws/wss scheme). */
  signalUrl: string;
  /** What browsers receive: the Flux signaling gate at `<public origin>/media`. */
  mediaUrl: string;
  apiKey: string;
  apiSecret: string;
}

export const MEDIA_GATE_PATH = '/media';
export const ADMISSION_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * No LiveKit defaults: the operator must name an owned SFU and supply its signing key.
 * Browsers never receive the SFU address. They signal through the Flux gate (#128).
 */
export function liveMediaConfig(env: NodeJS.ProcessEnv, publicOrigin: string): LiveMediaConfig {
  const apiUrl = env.FLUX_LIVEKIT_API_URL;
  const apiKey = env.FLUX_LIVEKIT_API_KEY;
  const apiSecret = env.FLUX_LIVEKIT_API_SECRET;
  if (env.FLUX_LIVEKIT_WS_URL)
    throw new Error('FLUX_LIVEKIT_WS_URL is no longer used: browsers signal through <FLUX_PUBLIC_ORIGIN>/media, and the SFU signal port must stay private (docs/development/live-sessions.md)');
  if (!apiUrl || !apiKey || !apiSecret)
    throw new Error('Live media requires FLUX_LIVEKIT_API_URL, FLUX_LIVEKIT_API_KEY and FLUX_LIVEKIT_API_SECRET');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(apiKey) || !/^[A-Za-z0-9_-]{32,128}$/.test(apiSecret))
    throw new Error('Invalid LiveKit API key or signing secret');

  const api = new URL(apiUrl);
  if (api.username || api.password || api.search || api.hash)
    throw new Error('LiveKit URLs must not contain credentials, query parameters or fragments');
  // `livekit` is the Compose service on the internal signal network (compose.live.yaml),
  // reachable only by the API. Loopback plain HTTP is for local development only.
  const insecureLocal = env.NODE_ENV !== 'production' && env.FLUX_LIVEKIT_ALLOW_INSECURE_LOCAL === 'true';
  const privateService = api.protocol === 'http:' && api.hostname === 'livekit';
  const loopback = api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname);
  if (api.protocol !== 'https:' && !privateService && !(insecureLocal && loopback))
    throw new Error('LiveKit API URL must use HTTPS, or http://livekit on the private Compose signal network');
  if (api.pathname !== '/')
    throw new Error('LiveKit URLs must be origins without paths');
  const origin = new URL(publicOrigin);
  return {
    apiUrl: api.origin,
    signalUrl: `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}`,
    mediaUrl: `${origin.protocol === 'https:' ? 'wss:' : 'ws:'}//${origin.host}${MEDIA_GATE_PATH}`,
    apiKey,
    apiSecret,
  };
}

/** Infrastructure adapter only. Flux core decides admission before calling grant(). */
export function createLiveMedia(config: LiveMediaConfig): LiveMediaAdapter {
  // Calls also run beneath admission and recovery locks; bound an unavailable
  // SFU instead of holding those locks for the SDK's default retry window.
  const rooms = new RoomServiceClient(config.apiUrl, config.apiKey, config.apiSecret,
    { requestTimeout: 5, failover: false });
  const room = (roomId: string) => {
    if (!ROOM_ID.test(roomId)) throw new Error('Invalid opaque LiveKit room ID');
    return roomId;
  };
  return {
    async ensureRoom(roomId) {
      // The SFU config has room.auto_create=false. An old grant cannot create a room.
      // LiveKit returns the existing room on a repeated createRoom call.
      await rooms.createRoom({ name: room(roomId), emptyTimeout: 420, departureTimeout: 180, maxParticipants: 16 });
    },
    async requireRoom(roomId) {
      const name = room(roomId);
      let existing;
      try { existing = await rooms.listRooms([name]); }
      catch { throw new ServiceUnavailableError('Live media is unavailable', 'LIVE_MEDIA_UNAVAILABLE'); }
      if (!existing.some((candidate) => candidate.name === name))
        throw new ServiceUnavailableError('This live room has ended; start a new session', 'LIVE_ROOM_GONE');
    },
    async grant(roomId, userId, admissionId) {
      if (!ADMISSION_ID.test(admissionId)) throw new Error('Invalid live admission ID');
      const issuedAt = Date.now();
      const token = new AccessToken(config.apiKey, config.apiSecret, {
        identity: participantIdentity(userId),
        // Opaque; SFU-refreshed tokens keep it, so the gate recognises them too.
        metadata: admissionId,
        ttl: GRANT_TTL_SECONDS,
      });
      token.addGrant({
        room: room(roomId),
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: false,
        canUpdateOwnMetadata: false,
        roomAdmin: false,
        roomCreate: false,
        roomList: false,
        roomRecord: false,
        ingressAdmin: false,
      });
      return { token: await token.toJwt(), expiresAt: new Date(issuedAt + GRANT_TTL_SECONDS * 1000) };
    },
    async participants(roomId) {
      const connected = await rooms.listParticipants(room(roomId));
      return connected.flatMap((participant) => {
        // JOINED (1) and ACTIVE (2) have completed admission; JOINING and
        // DISCONNECTED must not appear as people already in the room.
        if (participant.state !== 1 && participant.state !== 2) return [];
        const userId = userIdFromIdentity(participant.identity);
        if (!userId) return [];
        return [{ userId, joinedAt: new Date(Number(participant.joinedAt) * 1000).toISOString() }];
      });
    },
    async participantAdmissions(roomId) {
      return (await rooms.listParticipants(room(roomId))).flatMap((participant) => {
        const userId = userIdFromIdentity(participant.identity);
        if (!userId) return [];
        return [{ userId, admissionId: ADMISSION_ID.test(participant.metadata) ? participant.metadata : null }];
      });
    },
    async revokeParticipant(roomId, userId) {
      const name = room(roomId);
      const identity = participantIdentity(userId);
      const absent = async () => {
        try { return !(await rooms.listParticipants(name)).some((participant) => participant.identity === identity); }
        catch {
          const existing = await rooms.listRooms([name]);
          return !existing.some((candidate) => candidate.name === name);
        }
      };
      try {
        // Permissions are replaced as a whole; unset fields are false as well.
        await rooms.updateParticipant(name, identity, { permission: {
          canPublish: false, canSubscribe: false, canPublishData: false, canUpdateMetadata: false,
        } });
      } catch (error) {
        if (await absent()) return;
        throw error;
      }
      try { await rooms.removeParticipant(name, identity); }
      catch (error) {
        if (await absent()) return;
        throw error;
      }
    },
    async occupancy(roomId) {
      const name = room(roomId);
      try { return (await rooms.listParticipants(name)).length; }
      catch (error) {
        // A disappeared room is empty, while an unavailable SFU remains unknown.
        const existing = await rooms.listRooms([name]);
        if (!existing.some((candidate) => candidate.name === name)) return 0;
        throw error;
      }
    },
    async removeParticipant(roomId, userId) {
      const name = room(roomId);
      const identity = participantIdentity(userId);
      try { await rooms.removeParticipant(name, identity); }
      catch (error) {
        // A repeated leave is complete when the person or room is confirmed
        // absent. An unavailable SFU is still an error, not proof of absence.
        try {
          const connected = await rooms.listParticipants(name);
          if (!connected.some((participant) => participant.identity === identity)) return;
        } catch {
          const existing = await rooms.listRooms([name]);
          if (!existing.some((candidate) => candidate.name === name)) return;
        }
        throw error;
      }
    },
    async deleteRoom(roomId) {
      const name = room(roomId);
      // A retry may find an already expired/deleted room. Confirm absence even if
      // DeleteRoom reports an error; never turn an uncertain response into success.
      let failure: unknown;
      try { await rooms.deleteRoom(name); } catch (error) { failure = error; }
      const remaining = await rooms.listRooms([name]);
      if (remaining.some((candidate) => candidate.name === name))
        throw failure ?? new Error('LiveKit still lists a retired room');
    },
  };
}

export function createLiveMediaFromEnv(env: NodeJS.ProcessEnv, publicOrigin: string):
  { media: LiveMediaAdapter; mediaUrl: string; config: LiveMediaConfig } | null {
  if (!env.FLUX_LIVEKIT_API_URL && !env.FLUX_LIVEKIT_WS_URL && !env.FLUX_LIVEKIT_API_KEY && !env.FLUX_LIVEKIT_API_SECRET)
    return null;
  const config = liveMediaConfig(env, publicOrigin);
  return { media: createLiveMedia(config), mediaUrl: config.mediaUrl, config };
}
