import {
  INBOX_PATH,
  INBOX_READ_ALL_PATH,
  inboxItemPath,
  inboxItemReadPath,
  NOTIFICATION_ADDRESSES_PATH,
  NOTIFICATION_ADDRESS_VERIFY_PATH,
  notificationAddressPath,
  notificationAddressResendPath,
  NOTIFICATION_MUTES_PATH,
  notificationFollowPath,
  NOTIFICATION_FOLLOWS_PATH,
  NOTIFICATION_PREFERENCES_PATH,
  NOTIFICATION_UNSUBSCRIBE_PATH,
  type InboxItem,
  type InboxResponse,
  type MutedPlacesResponse,
  type NotificationPreferences,
  type SetFollowCommand,
  type SetMuteCommand,
  type ThreadFollow,
  type UnsubscribeResponse,
  type UpdateNotificationPreferencesCommand,
  type VerifiedNotificationAddress,
} from '@flux/contracts';
import { request } from '../api/client';
import { noteLockedWorkspaces } from '../encryption/api';

/** The inbox and notification settings (#41, #116). */
export const getInbox = (signal?: AbortSignal, limit = 100) => request<InboxResponse>(`${INBOX_PATH}?limit=${limit}`, { signal }).then(noteLockedWorkspaces);
export const getInboxItem = (id: string, signal?: AbortSignal) => request<InboxItem>(inboxItemPath(id), { signal });
export const markInboxRead = (id: string) => request<{ id: string; readAt: string }>(inboxItemReadPath(id), { method: 'POST' });
export const markAllInboxRead = () => request<{ updated: number }>(INBOX_READ_ALL_PATH, { method: 'POST' });

export const getPreferences = (signal?: AbortSignal) => request<NotificationPreferences>(NOTIFICATION_PREFERENCES_PATH, { signal });
export const updatePreferences = (change: UpdateNotificationPreferencesCommand) =>
  request<NotificationPreferences>(NOTIFICATION_PREFERENCES_PATH, { method: 'PATCH', body: change });
/** The ids of the muted places, for the sidebar's mark and the ⋯ menus (#1249); Settings reads the names with the preferences. */
export const getMutedPlaces = (signal?: AbortSignal) => request<MutedPlacesResponse>(NOTIFICATION_MUTES_PATH, { signal });
/** Whether the person follows a thread (its replies notify them), and the choice to follow or unfollow it (#1249). */
export const getFollow = (conversationId: string, signal?: AbortSignal) => request<ThreadFollow>(notificationFollowPath(conversationId), { signal });
export const setFollow = (command: SetFollowCommand) => request<ThreadFollow>(NOTIFICATION_FOLLOWS_PATH, { method: 'PUT', body: command });
export const setMute = (command: SetMuteCommand) => request<NotificationPreferences>(NOTIFICATION_MUTES_PATH, { method: 'PUT', body: command });
export const addAddress = (email: string) => request<NotificationPreferences>(NOTIFICATION_ADDRESSES_PATH, { method: 'POST', body: { email } });
export const setAddressEnabled = (id: string, enabled: boolean) => request<NotificationPreferences>(notificationAddressPath(id), { method: 'PATCH', body: { enabled } });
export const removeAddress = (id: string) => request<NotificationPreferences>(notificationAddressPath(id), { method: 'DELETE' });
export const resendVerification = (id: string) => request<NotificationPreferences>(notificationAddressResendPath(id), { method: 'POST' });
export const verifyAddress = (token: string) => request<VerifiedNotificationAddress>(NOTIFICATION_ADDRESS_VERIFY_PATH, { method: 'POST', body: { token } });
export const unsubscribe = (token: string) => request<UnsubscribeResponse>(`${NOTIFICATION_UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`, { method: 'POST' });

/** Tells the rail's quiet dot that inbox state changed (an item was read). */
export const INBOX_CHANGED = 'flux:inbox-changed';
export const announceInboxChange = () => window.dispatchEvent(new Event(INBOX_CHANGED));

/** A reply answered these Inbox items (#1170): the composer says so, the shell takes them out and offers Undo. */
export const INBOX_ANSWERED = 'flux:inbox-answered';
export const announceAnswered = (keys: readonly string[]) => window.dispatchEvent(new CustomEvent<readonly string[]>(INBOX_ANSWERED, { detail: keys }));

/** Removes accepted proposals from every mounted queue before their next read (Inbox to Home navigation). */
export interface AcceptedInboxItem { ownerId: string; key: string }
export const NEEDS_YOU_ACCEPTED = 'flux:needs-you-accepted';
export const announceAcceptedInboxItem = (ownerId: string, key: string) =>
  window.dispatchEvent(new CustomEvent<AcceptedInboxItem>(NEEDS_YOU_ACCEPTED, { detail: { ownerId, key } }));
