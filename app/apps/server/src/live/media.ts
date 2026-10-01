import { AccessToken, RoomServiceClient } from 'livekit-server-sdk';
import { ServiceUnavailableError, type LiveMedia } from '@flux/core';

const ROOM_ID = /^[A-Za-z0-9_-]{16,128}$/;
const GRANT_TTL_SECONDS = 90;
const MAX_USER_ID_BYTES = 90;

export const ADMISSION_ID = /^[A-Za-z0-9_-]{22}$/;

/**
 * One SFU identity per media admission (#128): `u_<base64url(userId)>.<admissionId>`. Two
 * sessions of one person are two participants, so ending one session addresses exactly its
 * own participant and never a newer admission of the same person.
 */
export function participantIdentity(userId: string, admissionId: string): string {
  if (!userId || Buffer.byteLength(userId, 'utf8') > MAX_USER_ID_BYTES ||
    Array.from(userId).some((char) => {
      const code = char.codePointAt(0)!;
      return code < 32 || code === 127;
    }))
    throw new Error('Invalid Flux user ID');
  if (!ADMISSION_ID.test(admissionId)) throw new Error('Invalid live admission ID');
  return `u_${Buffer.from(userId, 'utf8').toString('base64url')}.${admissionId}`;
}

/** The person and admission of a Flux identity; null for any other LiveKit identity. */
export function parseIdentity(identity: string): { userId: string; admissionId: string } | null {
  const match = /^u_([A-Za-z0-9_-]{1,126})\.([A-Za-z0-9_-]{22})$/.exec(identity);
  if (!match) return null;
  try {
    const userId = Buffer.from(match[1]!, 'base64url').toString('utf8');
    return participantIdentity(userId, match[2]!) === identity ? { userId, admissionId: match[2]! } : null;
  } catch {
    // Other LiveKit clients must not make the whole presence query fail.
    return null;
  }
}

/** A Flux participant the SFU holds, and the admission its identity and metadata name. */
export interface ParticipantAdmission {
  /** Null for an identity that is not the current per-admission Flux form. */
  userId: string | null;
  /** Exact SFU identity; revocation addresses only this. */
  identity: string;
  /** Null unless identity and metadata name the same well-formed admission. */
  admissionId: string | null;
}

export interface LiveMediaAdapter extends LiveMedia {
  /** Connected people, one entry per person however many sessions they have in the room. */
  participants(roomId: string): Promise<{ userId: string; joinedAt: string }[]>;
  /**
   * Every participant the SFU holds in the room, whatever its identity form or connection
   * state: a pre-#128 per-person identity (`u_<user>`, no admission metadata) or any other
   * identity is listed with a null admission, so reconciliation retires it.
   */
  participantAdmissions(roomId: string): Promise<ParticipantAdmission[]>;
  /**
   * Drops every publish/subscribe/data permission of exactly `identity`, then disconnects it.
   * The permission drop comes first so a token the SFU refreshes meanwhile carries none (#128).
   * Absence of that identity or the room counts as done.
   */
  revokeParticipant(roomId: string, identity: string): Promise<void>;
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
      const issuedAt = Date.now();
      const token = new AccessToken(config.apiKey, config.apiSecret, {
        identity: participantIdentity(userId, admissionId),
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
      // One person with two tabs or devices is two participants but one person here.
      const people = new Map<string, number>();
      for (const participant of connected) {
        // JOINED (1) and ACTIVE (2) have completed admission; JOINING and
        // DISCONNECTED must not appear as people already in the room.
        if (participant.state !== 1 && participant.state !== 2) continue;
        const parsed = parseIdentity(participant.identity);
        if (!parsed) continue;
        const joinedAt = Number(participant.joinedAt) * 1000;
        people.set(parsed.userId, Math.min(people.get(parsed.userId) ?? joinedAt, joinedAt));
      }
      return [...people].map(([userId, joinedAt]) => ({ userId, joinedAt: new Date(joinedAt).toISOString() }));
    },
    async participantAdmissions(roomId) {
      return (await rooms.listParticipants(room(roomId))).map((participant) => {
        const parsed = parseIdentity(participant.identity);
        return { userId: parsed?.userId ?? null, identity: participant.identity,
          admissionId: parsed && participant.metadata === parsed.admissionId ? parsed.admissionId : null };
      });
    },
    async revokeParticipant(roomId, identity) {
      const name = room(roomId);
      // Any identity the SFU listed in a Flux room, including pre-#128 and foreign forms.
      if (typeof identity !== 'string' || !identity || identity.length > 256) throw new Error('Invalid participant identity');
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
    async removeAdmissions(roomId, userId, admissionIds) {
      const name = room(roomId);
      const identities = new Set(admissionIds.map((id) => participantIdentity(userId, id)));
      const present = (participants: { identity: string }[]) =>
        participants.map((participant) => participant.identity).filter((identity) => identities.has(identity));
      let targets: string[];
      try { targets = present(await rooms.listParticipants(name)); }
      catch (error) {
        // A repeated leave is complete when the room is confirmed absent. An
        // unavailable SFU is still an error, not proof of absence.
        const existing = await rooms.listRooms([name]);
        if (!existing.some((candidate) => candidate.name === name)) return;
        throw error;
      }
      let failure: unknown;
      for (const identity of targets) {
        try { await rooms.removeParticipant(name, identity); } catch (error) { failure = error; }
      }
      if (failure === undefined) return;
      try { if (!present(await rooms.listParticipants(name)).length) return; }
      catch {
        const existing = await rooms.listRooms([name]);
        if (!existing.some((candidate) => candidate.name === name)) return;
      }
      throw failure;
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
