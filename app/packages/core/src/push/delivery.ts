import { GENERIC_PUSH_TITLE, type PushPayload } from '@flux/contracts';
import { pushEndpointViolation } from './config.js';
import { readsSource, summarySourcesReadable } from './notifications.js';
import type { NotificationRecord, ProviderDeliveryAdmission, PushDeliveryRepository, PushSender, PushSendJob, SourceReadAuthorizer, SourceReadDecision } from './ports.js';

export type DeliveryOutcome =
  | { outcome: 'sent'; status: number; preview: PushPayload['preview'] }
  | { outcome: 'removed'; status: number | null; reason: string }
  | { outcome: 'rejected'; status: number | null; reason: string }
  | { outcome: 'skipped'; reason: string }
  /** The recipient's quiet hours cover now (#116): send again at `until`. */
  | { outcome: 'deferred'; until: Date };

/** Thrown for 429, 5xx and network failures so the queue retries with bounded backoff. */
export class RetryableDeliveryError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/**
 * Lock-screen privacy rule: the notification's text leaves the server only when the recipient
 * can read its source right now. Otherwise the device gets a fixed title and an opaque id, and
 * the service worker asks the server (which rechecks) for details when the person taps it.
 */
export function buildPushPayload(notification: NotificationRecord, decision: SourceReadDecision): PushPayload {
  if (readsSource(decision, notification.source)) {
    return { preview: 'full', notificationId: notification.id, title: notification.title, body: notification.body, url: notification.url ?? '/' };
  }
  return { preview: 'generic', notificationId: notification.id, title: GENERIC_PUSH_TITLE };
}

export interface DeliveryPorts {
  /** False when the operator has not configured VAPID keys: jobs complete as skipped. */
  available: boolean;
  targets: PushDeliveryRepository;
  authorizer: SourceReadAuthorizer;
  sender: PushSender;
  /** Last admission after async checks; starts the concrete sender while retaining current task lifecycle. */
  admitSend(notificationId: string, send: () => Promise<PushSendResult>): Promise<ProviderDeliveryAdmission<PushSendResult>>;
  /**
   * The recipient's current notification preferences (#116): false when push is now off for the
   * notification's reason or its place is muted. Absent for callers without preferences.
   */
  stillWanted?: (userId: string, notification: NotificationRecord) => Promise<boolean>;
  /** When the recipient's current quiet hours end, if they cover now; null otherwise. */
  quietUntil?: (userId: string) => Promise<Date | null>;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/**
 * Sends one notification to one subscription. Right before sending it rechecks, from current
 * rows, that the subscription and the notification still belong to the recipient, that the
 * subscribing session is still active and that the recipient may still see the source. A
 * device that moved to another account, a signed-out or revoked session and a recipient who
 * lost access receive nothing.
 */
export async function deliverPushJob(ports: DeliveryPorts, job: PushSendJob): Promise<DeliveryOutcome> {
  if (!ports.available) return { outcome: 'skipped', reason: 'push unavailable' };
  const target = await ports.targets.findTarget(job);
  if (!target) return { outcome: 'skipped', reason: 'recipient, subscription or notification no longer matches' };
  const { subscription, notification } = target;

  if (!target.sessionActive) {
    await ports.targets.deleteSubscription(subscription.id);
    return { outcome: 'removed', status: null, reason: 'the subscribing session has ended' };
  }
  if (subscription.expirationTime && subscription.expirationTime.getTime() <= Date.now()) {
    await ports.targets.deleteSubscription(subscription.id);
    return { outcome: 'removed', status: null, reason: 'subscription expired' };
  }
  const decision = await ports.authorizer.canRead(job.userId, notification.source);
  if (!decision.visible) return { outcome: 'skipped', reason: 'recipient can no longer see the notification source' };
  if (ports.stillWanted && !await ports.stillWanted(job.userId, notification)) return { outcome: 'skipped', reason: 'push turned off or place muted' };
  if (notification.deliveryKind === 'morning_summary' && (!ports.stillWanted || !await summarySourcesReadable(ports.authorizer, job.userId, notification))) return { outcome: 'skipped', reason: 'summary preferences or source access unavailable' };
  const until = await ports.quietUntil?.(job.userId);
  if (until) return { outcome: 'deferred', until };
  const violation = pushEndpointViolation(subscription.endpoint);
  if (violation) {
    await ports.targets.recordFailure(subscription.id, null);
    return { outcome: 'rejected', status: null, reason: violation };
  }

  const payload = buildPushPayload(notification, decision);
  const admission = await ports.admitSend(notification.id, () => ports.sender.send(subscription, payload));
  if (admission.status === 'suppressed') return { outcome: 'skipped', reason: 'task creation was undone before delivery' };
  if (admission.status === 'unknown') return { outcome: 'skipped', reason: 'delivery outcome unknown after provider admission' };
  const result = admission.response;
  switch (result.kind) {
    case 'accepted':
      await ports.targets.recordSuccess(subscription.id);
      return { outcome: 'sent', status: result.status, preview: payload.preview };
    case 'refused':
      await ports.targets.recordFailure(subscription.id, null);
      return { outcome: 'rejected', status: null, reason: result.reason };
    case 'network':
      await ports.targets.recordFailure(subscription.id, null);
      throw new RetryableDeliveryError(`Push delivery failed: ${result.message}`, null);
    case 'http-error': {
      const { status } = result;
      if (status === 404 || status === 410) {
        // The push service says this subscription is gone for good.
        await ports.targets.deleteSubscription(subscription.id);
        return { outcome: 'removed', status, reason: 'push service reports the subscription is gone' };
      }
      await ports.targets.recordFailure(subscription.id, status);
      if (status === 429 || status >= 500) throw new RetryableDeliveryError(`Push service answered ${status}`, status);
      // 400/401/403/413: retrying cannot help. 403 usually means the VAPID key changed since
      // this browser subscribed; the client re-subscribes with the current key on next start.
      ports.log?.('Push rejected by push service', { status, subscriptionId: subscription.id });
      return { outcome: 'rejected', status, reason: `push service answered ${status}` };
    }
  }
}
