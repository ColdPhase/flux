import { randomUUID } from 'node:crypto';
import { InvalidInputError, NotFoundError } from '../access/errors.js';
import { isSafeAppPath } from './config.js';
import type {
  NotificationRecord,
  NotificationRepository,
  NotificationSourceRef,
  NotificationUnitOfWork,
  SourceLookup,
  SourceReadAuthorizer,
  SourceReadDecision,
} from './ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_TYPES = new Set(['workspace', 'project', 'draft']);

export interface NotificationInput {
  userId: string;
  /** Required: the object the notification is about. The recipient must be able to read it now. */
  source: SourceLookup;
  title: string;
  body?: string;
  url?: string | null;
}

/** True only when the policy lets the recipient read this exact source in its stored workspace. */
export function readsSource(decision: SourceReadDecision, source: NotificationSourceRef) {
  return decision.visible && decision.allowed && decision.workspaceId === source.workspaceId;
}

export class NotificationNotFoundError extends NotFoundError {
  constructor() {
    super('Notification', 'NOTIFICATION_NOT_FOUND');
  }
}

/**
 * Stores an inbox notification about `source` and, in the same transaction, queues one push
 * job per subscription of the recipient whose session is still active. The recipient must be
 * allowed to read the source (`<type>.read`) at this moment; otherwise nothing is stored and
 * the source is reported as not found, so the call never reveals it. The inbox row exists even
 * when push is unavailable or denied.
 */
export async function createNotification(uow: NotificationUnitOfWork, input: NotificationInput) {
  const title = input.title.trim();
  if (!title || title.length > 200) throw new InvalidInputError('Notification title must be 1–200 characters');
  const body = (input.body ?? '').trim();
  if (body.length > 1000) throw new InvalidInputError('Notification body must be at most 1000 characters');
  const url = input.url ?? null;
  if (url !== null && !isSafeAppPath(url)) throw new InvalidInputError('Notification url must be a same-origin path');
  if (!input.source || !SOURCE_TYPES.has(input.source.type) || !UUID.test(input.source.id)) {
    throw new InvalidInputError('Notification source must name a workspace, project or draft', 'NOTIFICATION_SOURCE_REQUIRED');
  }
  const id = randomUUID();
  return uow.run(async ({ authorizer, notifications, subscriptions, queue }) => {
    const decision = await authorizer.canRead(input.userId, input.source);
    if (!decision.visible || !decision.allowed || !decision.workspaceId) throw new NotFoundError('Notification source', 'SOURCE_NOT_FOUND');
    const source: NotificationSourceRef = { workspaceId: decision.workspaceId, type: input.source.type, id: input.source.id };
    await notifications.insert({ id, userId: input.userId, source, title, body, url });
    const jobIds: string[] = [];
    for (const subscriptionId of await subscriptions.deliverableIdsForUser(input.userId)) {
      const jobId = await queue.enqueuePushSend({ notificationId: id, subscriptionId, userId: input.userId });
      if (jobId) jobIds.push(jobId);
    }
    return { id, jobIds };
  });
}

export interface InboxPorts {
  notifications: NotificationRepository;
  authorizer: SourceReadAuthorizer;
}

/** The recipient's inbox: only notifications whose source they can read now. */
export async function listInbox(ports: Pick<InboxPorts, 'notifications'>, userId: string, limit = 50) {
  return ports.notifications.listReadable(userId, Math.min(Math.max(Math.trunc(limit), 1), 100));
}

/**
 * One notification by id. Someone else's notification, and one whose source the recipient can
 * no longer read, answer the same 404 as an id that never existed.
 */
export async function getInboxItem(ports: InboxPorts, userId: string, id: string): Promise<NotificationRecord> {
  if (!UUID.test(id)) throw new NotificationNotFoundError();
  const row = await ports.notifications.findForRecipient(userId, id);
  if (!row) throw new NotificationNotFoundError();
  if (!readsSource(await ports.authorizer.canRead(userId, row.source), row.source)) throw new NotificationNotFoundError();
  return row;
}

export async function markInboxItemRead(ports: InboxPorts, userId: string, id: string) {
  await getInboxItem(ports, userId, id);
  const readAt = await ports.notifications.markRead(userId, id);
  if (!readAt) throw new NotificationNotFoundError();
  return { id, readAt };
}
