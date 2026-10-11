/** Pending settings belong to one mounted application/account lifetime in this tab. */
export interface NotificationSession { readonly ownerId: string; readonly nonce: number }
let generation = 0;
let active: NotificationSession | null = null;

export function beginNotificationSession(ownerId: string): NotificationSession {
  active = { ownerId, nonce: ++generation };
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
