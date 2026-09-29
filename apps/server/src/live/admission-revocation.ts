import type { LiveAdmissionStore, RevokedAdmission } from './admissions.js';
import type { LiveMediaAdapter } from './media.js';

/** PostgreSQL channel the `auth_sessions` deletion trigger notifies (payload: auth session id). */
export const LIVE_ADMISSIONS_CHANNEL = 'flux_live_admissions';
/** Available rooms the reconciliation pass looks at per run. */
export const RECONCILE_ROOM_LIMIT = 200;
const CONCURRENCY = 5;

/** The signaling sockets this API instance proxies, by admission id. */
export interface MediaSocketRegistry {
  /** Closes every proxied socket of the admission; returns how many were open. */
  closeAdmission(admissionId: string): number;
  /** Admission ids with at least one open proxied socket. */
  openAdmissions(): string[];
}

export interface AdmissionRevocationOptions {
  store: Pick<LiveAdmissionStore, 'revokedForSession' | 'standing' | 'availableRooms'>;
  media: Pick<LiveMediaAdapter, 'participantAdmissions' | 'revokeParticipant'>;
  sockets: MediaSocketRegistry;
  log: (message: string, details: Record<string, unknown>) => void;
}

export interface AdmissionRevocation {
  /**
   * An auth session ended (sign-out, session revocation, password reset, expiry cleanup):
   * its admissions are already revoked in the database. Closes their proxied sockets, then
   * drops SFU permissions and removes each participant still carrying one of them.
   */
  sessionEnded(authSessionId: string): Promise<void>;
  /** Removes one participant admitted by an admission found revoked after its upgrade. */
  admissionRevoked(admission: RevokedAdmission): Promise<void>;
  /**
   * Reconciliation only (after a missed notification or an API restart): closes sockets whose
   * admission no longer stands, and removes participants of available rooms whose metadata is
   * not a standing admission.
   */
  reconcile(): Promise<void>;
  /** Same check for one room, e.g. after a `participant_joined` webhook. */
  reconcileRoom(roomId: string): Promise<void>;
}

async function eachBounded<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => { while (next < items.length) await run(items[next++]!); };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
}

/**
 * Removes only a participant whose metadata is the revoked admission. The SFU keeps one
 * participant per person per room, so if the person's other session has taken over that
 * identity, its (different) admission id leaves it connected. Other people are never touched.
 */
export function admissionRevocation({ store, media, sockets, log }: AdmissionRevocationOptions): AdmissionRevocation {
  const failed = (message: string, details: Record<string, unknown>, error: unknown) =>
    log(message, { ...details, error: (error as Error)?.message ?? String(error) });

  const removeFromRooms = async (revoked: readonly RevokedAdmission[]) => {
    const byRoom = new Map<string, Map<string, string>>();
    for (const admission of revoked) {
      const room = byRoom.get(admission.roomId) ?? new Map<string, string>();
      room.set(admission.id, admission.userId);
      byRoom.set(admission.roomId, room);
    }
    await eachBounded([...byRoom], async ([roomId, ids]) => {
      try {
        const connected = await media.participantAdmissions(roomId);
        for (const participant of connected) {
          if (!participant.admissionId || ids.get(participant.admissionId) !== participant.userId) continue;
          await media.revokeParticipant(roomId, participant.userId);
        }
      } catch (error) {
        // The gate already refuses every reconnect; the reconciliation pass retries removal.
        failed('Revoked live admission is still pending removal from the SFU', { roomId }, error);
      }
    });
  };

  const reconcileRoom = async (roomId: string) => {
    let connected;
    try { connected = await media.participantAdmissions(roomId); }
    catch (error) { failed('Live admission reconciliation could not list a room', { roomId }, error); return; }
    if (!connected.length) return;
    const standing = await store.standing(connected.flatMap((participant) => participant.admissionId ?? []));
    for (const participant of connected) {
      if (participant.admissionId && standing.has(participant.admissionId)) continue;
      try { await media.revokeParticipant(roomId, participant.userId); }
      catch (error) { failed('Live admission reconciliation could not remove a participant', { roomId }, error); }
    }
  };

  return {
    async sessionEnded(authSessionId) {
      const revoked = await store.revokedForSession(authSessionId);
      for (const admission of revoked) sockets.closeAdmission(admission.id);
      await removeFromRooms(revoked);
    },

    async admissionRevoked(admission) {
      sockets.closeAdmission(admission.id);
      await removeFromRooms([admission]);
    },

    async reconcile() {
      const open = sockets.openAdmissions();
      const standing = await store.standing(open);
      for (const id of open) if (!standing.has(id)) sockets.closeAdmission(id);
      await eachBounded(await store.availableRooms(RECONCILE_ROOM_LIMIT), reconcileRoom);
    },

    reconcileRoom,
  };
}
