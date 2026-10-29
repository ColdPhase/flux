import type { NotificationReason } from './notifications.js';

/** Web Push and in-app inbox wire contract (issue #41). */
import type { LockedWorkspaceRef } from './encryption.js';

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

/** Immutable public identity recorded for one assistant join-request opening cycle. */
export interface AssistantRequestIdentity {
  joinRequestId: string;
  openingVersion: number;
  assistantId: string;
  assistantName: string;
  ownerId: string;
  ownerName: string;
}

export interface InboxItem {
  id: string;
  source: NotificationSourceRef;
  /**
   * Why it reached you (#116); null for notifications created directly (#41). `security` (F-030, #655) is an Inbox-only
   * notice about an encrypted space's keys (a new unlock password, keys changed outside Flux); never pushed or e-mailed.
   */
  reason: NotificationReason | 'security' | null;
  title: string;
  body: string;
  url: string | null;
  createdAt: string;
  readAt: string | null;
  /** Null for ordinary notifications and legacy assistant questions without trusted provenance. */
  assistantRequestIdentity?: AssistantRequestIdentity | null;
}

export interface InboxResponse {
  /**
   * F-030: the caller's encrypted workspaces that are locked on this server; their items are left out, and the page
   * draws one "Waiting to be unlocked" row for each. Absent when none is locked.
   */
  lockedWorkspaces?: LockedWorkspaceRef[];
  items: InboxItem[];
  /** The sidebar shows this number next to Inbox (F-026 §4). */
  unread: number;
}
