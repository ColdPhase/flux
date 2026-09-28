// Instance email configuration for notification delivery (issue #116). The administrator sets
// SMTP once for the instance (FLUX_SMTP_URL, FLUX_MAIL_FROM), the same transport password reset
// uses; links in email point at FLUX_PUBLIC_ORIGIN. Pure: reads only the given environment.

export type NotificationMailConfig =
  | { status: 'available'; smtpUrl: string; from: string; origin: string }
  | { status: 'unavailable'; reason: string };

export function loadNotificationMailConfig(env: NodeJS.ProcessEnv = process.env): NotificationMailConfig {
  const smtpUrl = env.FLUX_SMTP_URL?.trim();
  const from = env.FLUX_MAIL_FROM?.trim();
  const origin = env.FLUX_PUBLIC_ORIGIN?.trim().replace(/\/$/, '');
  if (!smtpUrl) return { status: 'unavailable', reason: 'Notification email is off: FLUX_SMTP_URL is not set' };
  if (!from) throw new Error('FLUX_MAIL_FROM is required when FLUX_SMTP_URL is set');
  let url: URL;
  try { url = new URL(origin ?? ''); } catch { throw new Error('FLUX_PUBLIC_ORIGIN is required for notification email links'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== origin) throw new Error('FLUX_PUBLIC_ORIGIN must be an http(s) origin without a path');
  return { status: 'available', smtpUrl, from, origin: url.origin };
}
