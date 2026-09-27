import { AUTH_BASE_PATH } from '@flux/contracts';
import { disablePushNotifications } from './push.js';

/**
 * Signs this device out. The push subscription is removed first, while the session can still
 * authorize the request, and the browser subscription is dropped, so a shared or handed-over
 * device stops receiving notifications. The server also deletes every subscription of a
 * session when the session ends, so this remains safe if the first step fails.
 */
export async function signOutDevice(): Promise<void> {
  await disablePushNotifications().catch(() => undefined);
  const response = await fetch(`${AUTH_BASE_PATH}/sign-out`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!response.ok) throw new Error(`Sign-out failed (${response.status})`);
}
