/** Pending settings belong to one mounted application/account lifetime in this tab. */
export interface NotificationSession { readonly ownerId: string; readonly nonce: number }
let generation = 0;
let active: NotificationSession | null = null;
let pauseRevision = 0;
let confirmedPause: string | null = null;

export function beginNotificationSession(ownerId: string): NotificationSession {
  active = { ownerId, nonce: ++generation };
  pauseRevision = 0;
  confirmedPause = null;
  return active;
}

export function retireNotificationSession(session: NotificationSession) {
  if (active === session) active = null;
}

export function captureNotificationSession(ownerId: string): NotificationSession | null {
  return active?.ownerId === ownerId ? active : null;
}

export function isCurrentNotificationSession(session: NotificationSession | null): session is NotificationSession {
  return session !== null && active === session;
}

/** Confirmations outlive Settings navigation, but never their application/account lifetime. */
export function recordNotificationPause(session: NotificationSession, until: string | null) {
  if (!isCurrentNotificationSession(session)) return;
  pauseRevision += 1;
  confirmedPause = until;
}

export function notificationPauseRevision(session: NotificationSession | null): number {
  return isCurrentNotificationSession(session) ? pauseRevision : 0;
}

/** Undefined means no newer confirmation; null is an explicitly confirmed Resume. */
export function confirmedNotificationPauseSince(session: NotificationSession | null, revision: number): string | null | undefined {
  return isCurrentNotificationSession(session) && pauseRevision > revision ? confirmedPause : undefined;
}
