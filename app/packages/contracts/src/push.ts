import type { NotificationReason } from './notifications.js';

/** Web Push and in-app inbox wire contract (issue #41). */
export const PUSH_PUBLIC_KEY_PATH = '/api/v1/push/public-key';
export const PUSH_SUBSCRIPTIONS_PATH = '/api/v1/push/subscriptions';
export const INBOX_PATH = '/api/v1/inbox';

/** `unavailable` means the operator has not configured VAPID keys; use the inbox instead. */
export type PushPublicKeyResponse =
  | { status: 'available'; publicKey: string }
  | { status: 'unavailable'; code: 'PUSH_UNAVAILABLE'; error: string };

/** The browser's PushSubscription.toJSON() plus an optional device label chosen by the user. */
export interface PushSubscriptionRequest {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
  deviceLabel?: string | null;
}

/** Endpoint URLs and keys are sensitive; responses never echo the keys. */
export interface PushSubscriptionSummary {
  id: string;
  endpointOrigin: string;
  deviceLabel: string | null;
  userAgent: string | null;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastFailureStatus: number | null;
}

/** Shown on the device when the sender cannot prove the recipient may read the source. */
export const GENERIC_PUSH_TITLE = 'New activity in Flux';

/**
 * Payload encrypted to the subscription and read by the service worker's push handler.
 * `full` carries the text only when the recipient could read the source at send time;
 * otherwise it is `generic` (fixed title and opaque id). On click the service worker asks
 * `GET /api/v1/inbox/:id`, which rechecks access, before opening anything.
 */
export type PushPayload =
  | {
    preview: 'full';
    notificationId: string;
    title: string;
    body: string;
    /** Same-origin path to open, re-authorized by the app when opened. */
    url: string;
  }
  | { preview: 'generic'; notificationId: string; title: string };

export type NotificationSourceType = 'workspace' | 'project' | 'draft' | 'dm';

/** The object a notification is about. Its `<type>.read` decides who may see the notification. */
export interface NotificationSourceRef {
  workspaceId: string;
  type: NotificationSourceType;
  id: string;
}

export interface InboxItem {
  id: string;
  source: NotificationSourceRef;
  /** Why it reached you (#116); null for notifications created directly (#41). */
  reason: NotificationReason | null;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface InboxResponse {
  items: InboxItem[];
  /** The client shows at most a quiet dot for this, never a count (#44 no guilt). */
  unread: number;
}
