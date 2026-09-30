import {
  INBOX_PATH,
  INBOX_READ_ALL_PATH,
  NOTIFICATION_ADDRESS_PATH,
  NOTIFICATION_ADDRESS_RESEND_PATH,
  NOTIFICATION_ADDRESS_VERIFY_PATH,
  NOTIFICATION_MUTES_PATH,
  NOTIFICATION_PREFERENCES_PATH,
  NOTIFICATION_UNSUBSCRIBE_PATH,
  type InboxItem,
  type InboxResponse,
  type NotificationPreferences,
  type SetMuteCommand,
  type UnsubscribeResponse,
  type UpdateNotificationPreferencesCommand,
} from '@flux/contracts';
import { request } from '../api/client';

/** The inbox and notification settings (#41, #116). */
export const getInbox = (signal?: AbortSignal, limit = 100) => request<InboxResponse>(`${INBOX_PATH}?limit=${limit}`, { signal });
export const getInboxItem = (id: string, signal?: AbortSignal) => request<InboxItem>(`${INBOX_PATH}/${encodeURIComponent(id)}`, { signal });
export const markInboxRead = (id: string) => request<{ id: string; readAt: string }>(`${INBOX_PATH}/${encodeURIComponent(id)}/read`, { method: 'POST' });
export const markAllInboxRead = () => request<{ updated: number }>(INBOX_READ_ALL_PATH, { method: 'POST' });

export const getPreferences = (signal?: AbortSignal) => request<NotificationPreferences>(NOTIFICATION_PREFERENCES_PATH, { signal });
export const updatePreferences = (change: UpdateNotificationPreferencesCommand) =>
  request<NotificationPreferences>(NOTIFICATION_PREFERENCES_PATH, { method: 'PATCH', body: change });
export const setMute = (command: SetMuteCommand) => request<NotificationPreferences>(NOTIFICATION_MUTES_PATH, { method: 'PUT', body: command });
export const addAddress = (email: string) => request<NotificationPreferences>(NOTIFICATION_ADDRESS_PATH, { method: 'POST', body: { email } });
export const removeAddress = () => request<NotificationPreferences>(NOTIFICATION_ADDRESS_PATH, { method: 'DELETE' });
export const resendVerification = () => request<NotificationPreferences>(NOTIFICATION_ADDRESS_RESEND_PATH, { method: 'POST' });
export const verifyAddress = (token: string) => request<NotificationPreferences>(NOTIFICATION_ADDRESS_VERIFY_PATH, { method: 'POST', body: { token } });
export const unsubscribe = (token: string) => request<UnsubscribeResponse>(`${NOTIFICATION_UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`, { method: 'POST' });

/** Tells the rail's quiet dot that inbox state changed (an item was read). */
export const INBOX_CHANGED = 'flux:inbox-changed';
export const announceInboxChange = () => window.dispatchEvent(new Event(INBOX_CHANGED));
