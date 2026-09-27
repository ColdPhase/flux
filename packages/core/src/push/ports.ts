import type { NotificationSourceRef, NotificationSourceType, PushPayload } from '@flux/contracts';

/**
 * Ports of the notification and Web Push use cases (issues #41, #46). Core defines what it
 * needs; the server and worker implement these with Drizzle, pg-boss, the access policy and
 * web-push, and pass them in. Nothing in `packages/core/src/push` imports those libraries.
 */

export type { NotificationSourceRef, NotificationSourceType };

/** Names the source object; the workspace is taken from the object itself, not from the caller. */
export interface SourceLookup {
  type: NotificationSourceType;
  id: string;
}

/** The access policy's answer for `<source.type>.read` by a person, read from current rows. */
export interface SourceReadDecision {
  visible: boolean;
  allowed: boolean;
  /** The workspace the source lives in, or null when it is not visible. */
  workspaceId: string | null;
}

/** Adapter over the core access policy (`authorize`). */
export interface SourceReadAuthorizer {
  canRead(userId: string, source: SourceLookup): Promise<SourceReadDecision>;
}

export interface NotificationRecord {
  id: string;
  userId: string;
  source: NotificationSourceRef;
  title: string;
  body: string;
  url: string | null;
  createdAt: Date;
  readAt: Date | null;
}

export type NewNotification = Omit<NotificationRecord, 'createdAt' | 'readAt'>;

export interface NotificationRepository {
  insert(notification: NewNotification): Promise<void>;
  /** The recipient's own row by id, without any access decision. */
  findForRecipient(userId: string, id: string): Promise<NotificationRecord | null>;
  /**
   * Newest first, only rows whose source the recipient may currently read, filtered with the
   * access policy's list conditions before the limit and in the unread count.
   */
  listReadable(userId: string, limit: number): Promise<{ items: NotificationRecord[]; unread: number }>;
  /** Sets read_at once; returns the stored time, or null when the row is not the recipient's. */
  markRead(userId: string, id: string): Promise<Date | null>;
}

export interface PushSubscriptionRecord {
  id: string;
  userId: string;
  /** The auth session that subscribed. Ending it deletes the subscription. */
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: Date | null;
  deviceLabel: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureStatus: number | null;
}

export interface PushSubscriptionValues {
  userId: string;
  sessionId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: Date | null;
  deviceLabel: string | null;
  userAgent: string | null;
}

export interface PushSubscriptionRepository {
  listForUser(userId: string): Promise<PushSubscriptionRecord[]>;
  countForUser(userId: string): Promise<number>;
  endpointExists(endpoint: string): Promise<boolean>;
  /** Insert, or move the endpoint's row to these values (new user/session); `created` tells which. */
  upsertByEndpoint(id: string, values: PushSubscriptionValues): Promise<{ record: PushSubscriptionRecord; created: boolean }>;
  deleteForUser(userId: string, id: string): Promise<boolean>;
  /** Subscriptions of the user whose session is still active. */
  deliverableIdsForUser(userId: string): Promise<string[]>;
}

/** One job per (notification, subscription). */
export interface PushSendJob {
  notificationId: string;
  subscriptionId: string;
  /** The recipient at enqueue time; the worker rechecks ownership, session and source access. */
  userId: string;
}

export interface JobQueue {
  /** Enqueues in the unit of work's transaction; returns the job id (null when deduplicated). */
  enqueuePushSend(job: PushSendJob): Promise<string | null>;
}

export interface NotificationPorts {
  authorizer: SourceReadAuthorizer;
  notifications: NotificationRepository;
  subscriptions: PushSubscriptionRepository;
  queue: JobQueue;
}

/** Runs `work` in one transaction: the inbox row and its push jobs commit together or not at all. */
export interface NotificationUnitOfWork {
  run<T>(work: (ports: NotificationPorts) => Promise<T>): Promise<T>;
}

/** What the worker needs about one job, read from current rows. */
export interface PushDeliveryTarget {
  subscription: PushSubscriptionRecord;
  notification: NotificationRecord;
  /** The subscribing session exists and has not expired. */
  sessionActive: boolean;
}

export interface PushDeliveryRepository {
  /** The subscription and notification of the job, both still owned by `job.userId`, or null. */
  findTarget(job: PushSendJob): Promise<PushDeliveryTarget | null>;
  deleteSubscription(id: string): Promise<void>;
  recordSuccess(id: string): Promise<void>;
  recordFailure(id: string, status: number | null): Promise<void>;
}

export type PushSendResult =
  | { kind: 'accepted'; status: number }
  | { kind: 'http-error'; status: number }
  /** Refused before any request, e.g. the endpoint resolves to a private address. */
  | { kind: 'refused'; reason: string }
  | { kind: 'network'; message: string };

/** Encrypts and signs the payload and POSTs it to the push service (web-push adapter). */
export interface PushSender {
  send(subscription: PushSubscriptionRecord, payload: PushPayload): Promise<PushSendResult>;
}
