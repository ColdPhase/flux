import type { LiveAdmissionStore, RevokedAdmission } from './admissions.js';
import { participantIdentity, type LiveMediaAdapter } from './media.js';

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
 * Every SFU participant has its own admission's identity (`u_<user>.<admission>`), so removal
 * addresses exactly the revoked admission: no participant snapshot is read, and a newer
 * admission of the same person, even one that joined the same room meanwhile, has a
 * different identity and stays connected. Other people are never touched.
 */
export function admissionRevocation({ store, media, sockets, log }: AdmissionRevocationOptions): AdmissionRevocation {
  const failed = (message: string, details: Record<string, unknown>, error: unknown) =>
    log(message, { ...details, error: (error as Error)?.message ?? String(error) });

  const removeFromRooms = async (revoked: readonly RevokedAdmission[]) => {
    await eachBounded(revoked, async (admission) => {
      try { await media.revokeParticipant(admission.roomId, participantIdentity(admission.userId, admission.id)); }
      catch (error) {
        // The gate already refuses every reconnect; the reconciliation pass retries removal.
        failed('Revoked live admission is still pending removal from the SFU', { roomId: admission.roomId }, error);
      }
    });
  };

  /**
   * Every participant of a Flux room without a standing admission is unadmitted: a revoked or
   * expired one, one whose metadata does not match its identity, and one connected before
   * #128 with the per-person identity and no admission (still possible right after an API
   * cutover while the SFU keeps running). Each is retired by its exact identity, permissions
   * first. A participant with a standing admission is never touched.
   */
  const reconcileRoom = async (roomId: string) => {
    let connected;
    try { connected = await media.participantAdmissions(roomId); }
    catch (error) { failed('Live admission reconciliation could not list a room', { roomId }, error); return; }
    if (!connected.length) return;
    const standing = await store.standing(connected.flatMap((participant) => participant.admissionId ?? []));
    for (const participant of connected) {
      if (participant.admissionId && standing.has(participant.admissionId)) continue;
      try { await media.revokeParticipant(roomId, participant.identity); }
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
