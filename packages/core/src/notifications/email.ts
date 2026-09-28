import { createHash, randomBytes } from 'node:crypto';
import { NOTIFICATION_EMAIL_SUBJECT, NOTIFICATION_UNSUBSCRIBE_PATH } from '@flux/contracts';
import { readsSource } from '../push/notifications.js';
import type { EmailDeliveryUnitOfWork, EmailJob, NotificationMailer, OutgoingMail } from './ports.js';
import { channelOn, emailKinds } from './preferences.js';

// Notification email (issue #116, founder direction on #44). Email is a channel above the same
// permissioned inbox as push: every message is the same generic notice with an authorized link,
// so it never carries project, person or DM text — not even to someone removed since.

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');

/** Where the one-click unsubscribe goes (RFC 8058) and the page linked from the body. */
export function unsubscribeLinks(origin: string, token: string) {
  const query = `token=${encodeURIComponent(token)}`;
  return { oneClick: `${origin}${NOTIFICATION_UNSUBSCRIBE_PATH}?${query}`, page: `${origin}/unsubscribe?${query}` };
}

/** The whole email: a fixed subject and body, an in-app link that rechecks access, and unsubscribe. */
export function buildNotificationEmail(input: { origin: string; to: string; emailId: string; notificationId: string; token: string }): OutgoingMail {
  const { origin, to, emailId, notificationId, token } = input;
  const links = unsubscribeLinks(origin, token);
  const host = new URL(origin).hostname || 'flux.invalid';
  const text = [
    'There is something new for you in Flux.',
    '',
    'Open it in Flux (you may be asked to sign in):',
    `${origin}/inbox/${notificationId}`,
    '',
    'Flux never puts messages or project details in email. Choose what reaches you by email:',
    `${origin}/settings/notifications`,
    '',
    'Stop these emails to this address:',
    links.page,
    '',
  ].join('\n');
  return {
    to,
    subject: NOTIFICATION_EMAIL_SUBJECT,
    text,
    messageId: `<notification-${emailId}@${host}>`,
    headers: {
      'List-Unsubscribe': `<${links.oneClick}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
    },
  };
}

export type EmailOutcome =
  | { outcome: 'sent'; addressKind: 'account' | 'extra' }
  | { outcome: 'skipped'; reason: string };

/** Thrown when SMTP did not accept the message, so the queue retries with bounded backoff. */
export class RetryableEmailError extends Error {}

export interface EmailDeliveryOptions {
  /** False without SMTP: queued rows are skipped. */
  available: boolean;
  origin: string;
  uow: EmailDeliveryUnitOfWork;
  mailer: NotificationMailer;
}

/**
 * Sends one queued notification email at most once. In a first transaction it locks the row,
 * rechecks that the recipient can read the source now, that their preferences still want email
 * for this reason and place and that the address is still theirs (verified, for the extra one),
 * and marks the row `sending` with a fresh unsubscribe token. Only then does it talk to SMTP. A
 * row that is not `queued` is never sent again, so a retry after an uncertain send (the process
 * died after SMTP accepted) cannot duplicate it; a failure SMTP reports puts it back to queued.
 */
export async function deliverNotificationEmail(options: EmailDeliveryOptions, job: EmailJob): Promise<EmailOutcome> {
  const claim = await options.uow.run(async (ports) => {
    const row = await ports.lockEmail(job.emailId);
    if (!row) return { skip: 'email no longer exists' } as const;
    if (row.status !== 'queued') return { skip: `already ${row.status}` } as const;
    const skip = async (reason: string) => { await ports.markSkipped(row.id, reason); return { skip: reason } as const; };
    if (!options.available) return skip('email is not configured');
    const { notification } = row;
    if (!readsSource(await ports.authorizer.canRead(row.userId, notification.source), notification.source)) return skip('recipient can no longer read the source');
    const preferences = await ports.preferences.get(row.userId);
    if (notification.reason && !channelOn(preferences, notification.reason, 'email')) return skip('email turned off for this reason');
    if (await ports.preferences.isMuted(row.userId, notification.source)) return skip('place muted');
    if (!emailKinds(preferences.emailDestination).includes(row.addressKind)) return skip('address no longer chosen');
    const address = row.addressKind === 'account' ? await ports.accountAddress(row.userId) : await ports.verifiedExtraAddress(row.userId);
    if (!address) return skip('no verified address');
    const token = newToken();
    await ports.markSending(row.id, address, hashToken(token));
    return { row, address, token } as const;
  });
  if ('skip' in claim) return { outcome: 'skipped', reason: claim.skip! };

  const { row, address, token } = claim;
  const mail = buildNotificationEmail({ origin: options.origin, to: address, emailId: row.id, notificationId: row.notification.id, token });
  const result = await options.mailer.send(mail);
  if (result.kind === 'failed') {
    await options.uow.run((ports) => ports.requeue(row.id, result.message));
    throw new RetryableEmailError(`SMTP did not accept the notification email: ${result.message}`);
  }
  await options.uow.run((ports) => ports.markSent(row.id));
  return { outcome: 'sent', addressKind: row.addressKind };
}
