import { messagePreview } from '@flux/contracts';
import { randomUUID } from 'node:crypto';
import type { NotificationReason } from '@flux/contracts';
import type { JobRetryPolicy } from '../push/config.js';
import { readsSource } from '../push/notifications.js';
import type { SourceLookup } from '../push/ports.js';
import { isQuestion, mentions } from './addressing.js';
import type { GeneratorEvent, GeneratorPorts, GeneratorUnitOfWork, NotificationFacts } from './ports.js';
import { channelsOf, deliverableAt, emailKinds } from './preferences.js';

// Notifications from committed domain events (issue #116, foundation 8.9). The worker reads the
// event log after its cursor, in commit order, and for each event decides who it concerns and
// why. A person is notified only when the event was in their recorded audience, the policy lets
// them read its source now, and their preferences want it. Each (person, event) is stored once.

/** One job per notification email row; the payload is only the row id. */
export const NOTIFICATION_EMAIL_JOB = 'notification.email.v1';

/** Bounded retries for SMTP failures before the server accepted the message. */
export const NOTIFICATION_EMAIL_QUEUE: JobRetryPolicy = {
  retryLimit: 5,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 120,
  deleteAfterSeconds: 7 * 24 * 3600,
};

export const GENERATOR_BATCH = 100;
/** At most one email per person and place in this window; the inbox holds the rest. */
export const EMAIL_CALM_WINDOW_MS = 10 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null);

function excerpt(body: string, max = 140) {
  const line = body.trim().replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}
const quote = (text: string) => `“${text}”`;

export interface Candidate {
  userId: string;
  reason: NotificationReason;
  source: SourceLookup;
  title: string;
  body: string;
  url: string;
}

function humanId(actorId: string) {
  return actorId.startsWith('human:') ? actorId.slice('human:'.length) : null;
}

async function actorName(facts: NotificationFacts, actorId: string) {
  const human = humanId(actorId);
  if (!human) return 'An agent';
  return (await facts.names([human])).get(human) ?? 'Someone';
}

/**
 * Who an event concerns and why: people addressed in a message (mention, question), people in a
 * conversation that gets a reply, the other people of a direct message, the new owner of work,
 * the people whose work (or agent) a proposed decision or recorded result is about, and the
 * recipient of a live invitation. Only
 * people in the event's recorded audience are considered; the actor is never notified.
 */
export async function candidatesFor(event: GeneratorEvent, facts: NotificationFacts): Promise<Candidate[]> {
  const actor = humanId(event.actorId);
  const audience = new Set(await facts.audience(event.id));
  const reachable = (userId: string | null): userId is string => !!userId && userId !== actor && audience.has(userId);

  switch (event.kind) {
    case 'project.conversation_created.v1':
    case 'project.message_sent.v1': {
      const messageId = id(event.data.messageId);
      const message = messageId ? await facts.projectMessage(messageId) : null;
      if (!message || message.projectId !== event.objectId) return [];
      const authorId = message.author.kind === 'human' ? message.author.id : null;
      const people = [...audience].filter((userId) => userId !== authorId && reachable(userId));
      const names = await facts.names([...(authorId ? [authorId] : []), ...people]);
      const author = authorId ? names.get(authorId) ?? 'Someone' : `${message.authorName ?? 'Agent'} (agent)`;
      const involved = new Set([...(message.conversationCreatedBy.kind === 'human' ? [message.conversationCreatedBy.id] : []), ...message.earlierAuthors]);
      const url = `/projects/${message.projectId}/conversations/${message.conversationId}#message-${message.id}`;
      const result: Candidate[] = [];
      for (const userId of people) {
        const name = names.get(userId) ?? '';
        const addressed = mentions(message.body, name);
        const reason: NotificationReason | null = addressed ? (isQuestion(message.body) ? 'question' : 'mention') : involved.has(userId) ? 'reply' : null;
        if (!reason) continue;
        const title = reason === 'question' ? `${author} asked you in ${message.projectName}`
          : reason === 'mention' ? `${author} mentioned you in ${message.projectName}`
            : `${author} replied in ${quote(excerpt(message.opening, 60))}`;
        result.push({ userId, reason, source: { type: 'project', id: message.projectId }, title, body: excerpt(messagePreview(message.body, message.attachmentCount)), url });
      }
      return result;
    }
    case 'dm.message_sent.v1': {
      const messageId = id(event.data.messageId);
      const message = messageId ? await facts.dmMessage(event.objectId, messageId) : null;
      if (!message) return [];
      const people = message.participantIds.filter((userId) => userId !== message.authorId && reachable(userId));
      const names = await facts.names([message.authorId]);
      const author = names.get(message.authorId) ?? 'Someone';
      const title = message.kind === 'pair' ? `${author} sent you a message` : `${author} in ${message.title ? quote(message.title) : 'a group message'}`;
      return people.map((userId) => ({
        userId, reason: 'dm' as const, source: { type: 'dm' as const, id: message.dmId }, title, body: excerpt(message.body),
        url: `/dm/${message.dmId}#message-${message.id}`,
      }));
    }
    case 'project.work_created.v1':
    case 'project.work_updated.v1': {
      const assignee = typeof event.data.assignedTo === 'string' ? event.data.assignedTo : null;
      const workId = id(event.data.workId);
      if (!assignee || !workId || !reachable(assignee)) return [];
      const work = await facts.work(workId);
      // Assigned again to someone else since: that later event notifies them instead.
      if (!work || work.projectId !== event.objectId || work.ownerUserId !== assignee) return [];
      return [{
        userId: assignee, reason: 'assigned', source: { type: 'project', id: work.projectId },
        title: `${await actorName(facts, event.actorId)} assigned you ${quote(excerpt(work.title, 80))}`,
        body: `Work in ${work.projectName}`, url: `/projects/${work.projectId}/tasks?open=work:${work.id}`,
      }];
    }
    case 'project.decision_proposed.v1':
    case 'project.result_recorded.v1': {
      const decision = event.kind === 'project.decision_proposed.v1';
      const objectId = id(decision ? event.data.decisionId : event.data.resultId);
      const item = objectId ? await (decision ? facts.decision(objectId) : facts.result(objectId)) : null;
      if (!item || item.projectId !== event.objectId) return [];
      const by = await actorName(facts, event.actorId);
      const recipients = new Map<string, string>();
      for (const owner of item.workOwners) if (reachable(owner)) recipients.set(owner, 'It is about your work');
      if (item.by.kind === 'agent' && reachable(item.agentOwner)) recipients.set(item.agentOwner, 'Your agent produced it');
      const kind = decision ? 'decision' : 'result';
      return [...recipients].map(([userId, why]) => ({
        userId, reason: 'review' as const, source: { type: 'project' as const, id: item.projectId },
        title: `${decision ? 'Decision' : 'Result'} to review: ${excerpt(item.title, 90)}`,
        body: `${why} · ${by} ${decision ? 'proposed it' : 'recorded it'} in ${item.projectName}`,
        url: `/projects/${item.projectId}/tasks?open=${kind}:${item.id}`,
      }));
    }
    case 'project.live_invited.v1': {
      // One quiet signal per invitation: only its recipient, and only while it still asks
      // something of them (pending, session available). The inviter never hears of it.
      const invitationId = id(event.data.invitationId);
      const sessionId = id(event.data.sessionId);
      const recipientId = typeof event.data.recipientId === 'string' ? event.data.recipientId : null;
      if (!invitationId || !sessionId || !reachable(recipientId)) return [];
      const invitation = await facts.liveInvitation(invitationId);
      if (!invitation || invitation.projectId !== event.objectId || invitation.sessionId !== sessionId
        || invitation.recipientId !== recipientId || invitation.inviterId === recipientId) return [];
      const inviter = (await facts.names([invitation.inviterId])).get(invitation.inviterId) ?? 'Someone';
      return [{
        userId: recipientId, reason: 'invitation', source: { type: 'project', id: invitation.projectId },
        title: `${inviter} invited you to work together`,
        body: `On ${quote(excerpt(invitation.anchor.label, 80))} in ${invitation.projectName}`,
        url: `/projects/${invitation.projectId}/live/${invitation.sessionId}?invitation=${invitation.id}`,
      }];
    }
    default:
      return [];
  }
}

export interface GenerationOptions {
  /** False when SMTP is not configured: no email rows are queued. */
  emailAvailable: boolean;
  now?: () => Date;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

/** Stores one candidate's notification and queues its push and email, as their preferences say. */
async function deliver(ports: GeneratorPorts, event: GeneratorEvent, candidate: Candidate, options: GenerationOptions) {
  const preferences = await ports.preferences.get(candidate.userId);
  if (await ports.preferences.isMuted(candidate.userId, candidate.source)) return false;
  const channels = channelsOf(preferences)[candidate.reason];
  if (!channels.inApp && !channels.push && !channels.email) return false;
  // Access now, not only at event time: someone removed since then gets nothing.
  const decision = await ports.authorizer.canRead(candidate.userId, candidate.source);
  const source = { workspaceId: event.workspaceId, type: candidate.source.type, id: candidate.source.id };
  if (!readsSource(decision, source)) return false;

  const notificationId = randomUUID();
  const inserted = await ports.insertNotification({
    id: notificationId, userId: candidate.userId, source, reason: candidate.reason, eventId: event.id,
    title: candidate.title, body: candidate.body, url: candidate.url, inInbox: channels.inApp,
  });
  if (!inserted) return false;

  const now = options.now?.() ?? new Date();
  const at = deliverableAt(preferences, now);
  const startAfter = at.getTime() > now.getTime() ? at : null;
  // With the morning summary on, what quiet hours hold back is not sent one by one when they
  // end: the summary counts it and the inbox keeps it (S22).
  if (startAfter && preferences.summaryEnabled) return true;
  if (channels.push) {
    for (const subscriptionId of await ports.deliverableSubscriptions(candidate.userId)) {
      await ports.enqueuePush({ notificationId, subscriptionId, userId: candidate.userId }, startAfter);
    }
  }
  const kinds = emailKinds(preferences.emailDestination);
  if (channels.email && options.emailAvailable && kinds.length
    && !await ports.emailedRecently(candidate.userId, candidate.source, new Date(now.getTime() - EMAIL_CALM_WINDOW_MS))) {
    for (const addressKind of kinds) {
      const emailId = randomUUID();
      if (await ports.insertEmail({ id: emailId, notificationId, userId: candidate.userId, addressKind })) await ports.enqueueEmail({ emailId }, startAfter);
    }
  }
  return true;
}

/** Attempts before an event whose generation keeps failing is dead-lettered and passed. */
export const GENERATION_MAX_ATTEMPTS = 5;

export interface GenerationResult {
  processed: number;
  created: number;
  /** True when an event failed and will be retried: the cursor stopped just before it. */
  stalled: boolean;
}

/**
 * Processes the next batch of committed events after the generator's cursor, in one
 * transaction that holds the cursor row, so concurrent workers never process an event twice
 * and a crash leaves the cursor where the stored notifications end. Each event runs in its own
 * savepoint. When one fails, the cursor stops just before it (the events before it commit) and
 * the failure is counted, so a transient error is retried rather than losing the event's
 * notifications. Only after `GENERATION_MAX_ATTEMPTS` failures is it dead-lettered (recorded,
 * logged) and passed, so one poisoned event cannot block everyone's notifications forever.
 */
export async function generateNotifications(uow: GeneratorUnitOfWork, options: GenerationOptions, limit = GENERATOR_BATCH): Promise<GenerationResult> {
  return uow.run(async (ports) => {
    const cursor = await ports.lockCursor();
    const events = await ports.eventsAfter(cursor, limit);
    let created = 0;
    let done: number | null = null;
    let processed = 0;
    for (const event of events) {
      try {
        created += await ports.isolate(async () => {
          let count = 0;
          for (const candidate of await candidatesFor(event, ports.facts)) if (await deliver(ports, event, candidate, options)) count++;
          return count;
        });
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        const attempts = await ports.recordFailure(event.id, message);
        if (attempts < GENERATION_MAX_ATTEMPTS) {
          options.log?.('Notification generation failed; the event will be retried', { eventId: event.id, kind: event.kind, attempts, error: message });
          if (done !== null) await ports.advanceCursor(done);
          return { processed, created, stalled: true };
        }
        await ports.deadLetter(event.id);
        options.log?.('Notification generation gave up on an event (dead-lettered)', { eventId: event.id, kind: event.kind, attempts, error: message });
      }
      done = event.seq;
      processed++;
    }
    if (done !== null) await ports.advanceCursor(done);
    return { processed, created, stalled: false };
  });
}
