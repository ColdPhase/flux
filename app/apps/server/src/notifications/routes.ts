import type { FastifyInstance } from 'fastify';
import {
  NOTIFICATION_ADDRESS_PATH,
  NOTIFICATION_ADDRESS_RESEND_PATH,
  NOTIFICATION_ADDRESS_VERIFY_PATH,
  NOTIFICATION_MUTES_PATH,
  NOTIFICATION_PREFERENCES_PATH,
  NOTIFICATION_UNSUBSCRIBE_PATH,
  type AddNotificationAddressCommand,
  type SetMuteCommand,
  type UpdateNotificationPreferencesCommand,
  type VerifyNotificationAddressCommand,
} from '@flux/contracts';
import { TooSoonError, unsubscribe, type Database } from '@flux/core';
import type { SessionResolver } from '../identity/index.js';
import type { SmtpConfig } from '../identity/config.js';
import { useDomainErrors } from '../http/commands.js';
import { notificationSettings, settingsPorts, verificationMailer } from './adapters.js';

export interface NotificationRoutesOptions {
  db: Database;
  sessions: SessionResolver;
  smtp: SmtpConfig | null;
  publicOrigin: string;
}

const channel = { type: 'object', additionalProperties: false, properties: { inApp: { type: 'boolean' }, push: { type: 'boolean' }, email: { type: 'boolean' } } } as const;

/**
 * Notification settings of the signed-in person (issue #116) and one-click unsubscribe. Every
 * settings route resolves the live session; the delivery address is stored apart from the
 * sign-in identity. The unsubscribe route takes only the token from one email (RFC 8058).
 */
export async function notificationRoutes(app: FastifyInstance, { db, sessions, smtp, publicOrigin }: NotificationRoutesOptions) {
  useDomainErrors(app);
  // A throttled verification send says when to try again (HTTP 429 + Retry-After).
  app.addHook('onError', async (_request, reply, error) => {
    if (error instanceof TooSoonError) reply.header('retry-after', String(error.retryAfterSeconds));
  });
  const mailer = verificationMailer(smtp);
  app.addHook('onClose', async () => mailer.close());
  const settings = notificationSettings(db, mailer, publicOrigin);
  const account = async (request: Parameters<SessionResolver['requirePrincipal']>[0]) => {
    const { user } = await sessions.requirePrincipal(request);
    return { userId: user.id, email: user.email };
  };
  // Mail clients POST `List-Unsubscribe=One-Click` as a form (RFC 8058). The identity bridge may
  // already accept forms app-wide (as a raw string); the token is read from the query either way.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
  }

  app.get(NOTIFICATION_PREFERENCES_PATH, async (request) => settings.view(await account(request)));

  app.patch<{ Body: UpdateNotificationPreferencesCommand }>(NOTIFICATION_PREFERENCES_PATH, {
    schema: {
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          channels: { type: 'object', additionalProperties: channel },
          emailDestination: { type: 'string' },
          quietHours: {
            type: 'object', additionalProperties: false,
            properties: { enabled: { type: 'boolean' }, start: { type: 'string', maxLength: 5 }, end: { type: 'string', maxLength: 5 }, timeZone: { type: 'string', maxLength: 64 } },
          },
          // Focus mode (#340): an ISO instant within 12 hours, or null to resume.
          pause: {
            type: 'object', required: ['until'], additionalProperties: false,
            properties: { until: { type: ['string', 'null'], maxLength: 40 } },
          },
        },
      },
    },
  }, async (request) => settings.update(await account(request), request.body));

  app.put<{ Body: SetMuteCommand }>(NOTIFICATION_MUTES_PATH, {
    schema: {
      body: {
        type: 'object', required: ['type', 'id', 'muted'], additionalProperties: false,
        properties: { type: { type: 'string' }, id: { type: 'string', maxLength: 64 }, muted: { type: 'boolean' } },
      },
    },
  }, async (request) => settings.setMute(await account(request), request.body));

  app.post<{ Body: AddNotificationAddressCommand }>(NOTIFICATION_ADDRESS_PATH, {
    schema: { body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', maxLength: 320 } } } },
  }, async (request) => settings.addAddress(await account(request), request.body));

  app.delete(NOTIFICATION_ADDRESS_PATH, async (request) => settings.removeAddress(await account(request)));

  app.post(NOTIFICATION_ADDRESS_RESEND_PATH, async (request) => settings.resend(await account(request)));

  app.post<{ Body: VerifyNotificationAddressCommand }>(NOTIFICATION_ADDRESS_VERIFY_PATH, {
    schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 128 } } } },
  }, async (request) => settings.verify(await account(request), request.body));

  // No session: the token is the authority, and it can only turn email off for its address.
  app.post<{ Querystring: { token?: string }; Body: { token?: string } | undefined }>(NOTIFICATION_UNSUBSCRIBE_PATH, async (request) => {
    const token = request.query.token ?? (request.body && typeof request.body === 'object' ? request.body.token : undefined);
    return unsubscribe(settingsPorts(db, mailer, publicOrigin), token);
  });
}
