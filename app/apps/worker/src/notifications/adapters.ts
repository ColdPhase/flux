import { fromDrizzle, type PgBoss } from 'pg-boss';
import nodemailer from 'nodemailer';
import {
  assignmentDeliveryAdmission,
  notificationEmailRows,
  notificationFactRows,
  notificationGeneratorRows,
  notificationPreferenceRows,
  pushSubscriptionRepository,
  sql,
} from '@flux/db';
import {
  NOTIFICATION_EMAIL_JOB,
  PUSH_SEND_JOB,
  channelOn,
  summaryWanted,
  deliverableAt,
  policySourceReader,
  preferenceRepository,
  type Database,
  type EmailDeliveryUnitOfWork,
  type GeneratorPorts,
  type GeneratorUnitOfWork,
  type NotificationMailConfig,
  type NotificationMailer,
  type NotificationRecord,
  type Transaction,
} from '@flux/core';

// Worker adapters for notification generation and email (issue #116; #46: the rules live in
// core, the worker composes Drizzle rows, the access policy, pg-boss and SMTP).

function generatorPorts(tx: Transaction, boss: PgBoss): GeneratorPorts {
  const rows = notificationGeneratorRows(tx);
  // Jobs are sent in the generator's transaction, so they commit with their notification rows.
  const queueDb = fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql);
  const later = (startAfter: Date | null) => (startAfter ? { startAfter } : {});
  return {
    lockCursor: () => rows.lockCursor(),
    advanceCursor: (seq) => rows.advanceCursor(seq),
    eventsAfter: (seq, limit) => rows.eventsAfter(seq, limit),
    facts: notificationFactRows(tx),
    preferences: preferenceRepository(notificationPreferenceRows(tx)),
    authorizer: policySourceReader(tx),
    insertNotification: (notification) => rows.insertNotification(notification),
    deliverableSubscriptions: (userId) => pushSubscriptionRepository(tx).deliverableIdsForUser(userId),
    emailedRecently: (userId, source, since) => rows.emailedRecently(userId, source, since),
    insertEmail: (row) => rows.insertEmail(row),
    enqueuePush: (job, startAfter) => boss.send(PUSH_SEND_JOB, job, { db: queueDb, singletonKey: `${job.notificationId}:${job.subscriptionId}`, ...later(startAfter) }),
    enqueueEmail: (job, startAfter) => boss.send(NOTIFICATION_EMAIL_JOB, job, { db: queueDb, singletonKey: job.emailId, ...later(startAfter) }),
    recordFailure: (eventId, error) => rows.recordFailure(eventId, error),
    deadLetter: (eventId) => rows.deadLetter(eventId),
    isolate: (work) => tx.transaction(() => work()),
  };
}

export function generatorUnitOfWork(db: Database, boss: PgBoss): GeneratorUnitOfWork {
  return { run: (work) => db.transaction((tx) => work(generatorPorts(tx, boss))) };
}

export function emailUnitOfWork(db: Database, boss: PgBoss): EmailDeliveryUnitOfWork {
  return {
    admitSend: (notificationId, send) => assignmentDeliveryAdmission(db, notificationId, send),
    run: (work) => db.transaction((tx) => {
      const rows = notificationEmailRows(tx);
      const queueDb = fromDrizzle(tx as Parameters<typeof fromDrizzle>[0], sql);
      return work({
        lockEmail: (id) => rows.lockEmail(id),
        mailboxClaimed: (notificationId, exceptId, address) => rows.mailboxClaimed(notificationId, exceptId, address),
        authorizer: policySourceReader(tx),
        preferences: preferenceRepository(notificationPreferenceRows(tx)),
        accountAddress: (userId) => rows.accountAddress(userId),
        verifiedExtraAddress: (userId) => rows.verifiedExtraAddress(userId),
        markSkipped: (id, reason) => rows.markSkipped(id, reason),
        markSending: (id, address, hash) => rows.markSending(id, address, hash),
        markSent: (id) => rows.markSent(id),
        requeue: (id, error) => rows.requeue(id, error),
        failPermanently: (id, reason, error) => rows.failPermanently(id, reason, error),
        promoteSkippedCopy: (notificationId, exceptId, skipReason) => rows.promoteSkippedCopy(notificationId, exceptId, skipReason),
        // A promoted copy is a new send of a row whose own job already completed (#329).
        enqueueEmail: (job) => boss.send(NOTIFICATION_EMAIL_JOB, job, { db: queueDb, singletonKey: `${job.emailId}:promoted` }),
      });
    }),
  };
}

/** The instance SMTP transport (nodemailer) as the core mail port. */
export function smtpNotificationMailer(config: Extract<NotificationMailConfig, { status: 'available' }>): NotificationMailer & { close(): void } {
  const transport = nodemailer.createTransport(config.smtpUrl);
  return {
    async send(mail) {
      try {
        await transport.sendMail({ from: config.from, to: mail.to, subject: mail.subject, text: mail.text, headers: mail.headers, messageId: mail.messageId });
        return { kind: 'accepted' };
      } catch (error) {
        return { kind: 'failed', message: (error as Error).message };
      }
    },
    close: () => transport.close(),
  };
}

/** Push rechecks the person's current preferences before sending (#116): muted place, push off. */
export function pushPreferenceCheck(db: Database) {
  const preferences = preferenceRepository(notificationPreferenceRows(db));
  return async (userId: string, notification: NotificationRecord) => {
    if (await preferences.isMuted(userId, notification.source)) return false;
    if (notification.deliveryKind === 'morning_summary') {
      if (!summaryWanted(await preferences.get(userId)) || !notification.summarySources?.length) return false;
      for (const source of notification.summarySources) if (await preferences.isMuted(userId, source)) return false;
      return true;
    }
    return !notification.reason || channelOn(await preferences.get(userId), notification.reason, 'push');
  };
}

/** Push rechecks the person's current quiet hours before sending (#116). */
export function pushQuietCheck(db: Database, now = () => new Date()) {
  const preferences = preferenceRepository(notificationPreferenceRows(db));
  return async (userId: string) => {
    const at = now();
    const until = deliverableAt(await preferences.get(userId), at);
    return until.getTime() > at.getTime() ? until : null;
  };
}
