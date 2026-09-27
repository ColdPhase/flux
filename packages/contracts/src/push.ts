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

/** Payload encrypted to the subscription and read by the service worker's push handler. */
export interface PushPayload {
  notificationId: string;
  title: string;
  body: string;
  /** Same-origin path to open, re-authorized by the app when opened. */
  url: string;
}

export interface InboxItem {
  id: string;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface InboxResponse {
  items: InboxItem[];
  unread: number;
}
