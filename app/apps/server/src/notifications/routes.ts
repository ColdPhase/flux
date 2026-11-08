import type { FastifyInstance } from 'fastify';
import {
  NOTIFICATION_ADDRESSES_PATH,
  NOTIFICATION_ADDRESS_VERIFY_PATH,
  NOTIFICATION_MUTES_PATH,
  NOTIFICATION_PREFERENCES_PATH,
  NOTIFICATION_UNSUBSCRIBE_PATH,
  type AddNotificationAddressCommand,
  type SetMuteCommand,
  type SetNotificationAddressCommand,
  type UpdateNotificationPreferencesCommand,
  type VerifyNotificationAddressCommand,
} from '@flux/contracts';
import { TooSoonError, unsubscribe } from '@flux/core';
import type { Database } from '@flux/db';
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
          emailMe: { type: 'boolean' },
          accountEnabled: { type: 'boolean' },
          quietHours: {
            type: 'object', additionalProperties: false,
            properties: { enabled: { type: 'boolean' }, start: { type: 'string', maxLength: 5 }, end: { type: 'string', maxLength: 5 }, timeZone: { type: 'string', maxLength: 64 } },
          },
          level: { type: 'string', maxLength: 16 },
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

  app.post<{ Body: AddNotificationAddressCommand }>(NOTIFICATION_ADDRESSES_PATH, {
    schema: { body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', maxLength: 320 } } } },
  }, async (request) => settings.addAddress(await account(request), request.body));

  app.patch<{ Params: { addressId: string }; Body: SetNotificationAddressCommand }>(`${NOTIFICATION_ADDRESSES_PATH}/:addressId`, {
    schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
  }, async (request) => settings.setAddressEnabled(await account(request), request.params.addressId, request.body));

  app.delete<{ Params: { addressId: string } }>(`${NOTIFICATION_ADDRESSES_PATH}/:addressId`, async (request) => settings.removeAddress(await account(request), request.params.addressId));

  app.post<{ Params: { addressId: string } }>(`${NOTIFICATION_ADDRESSES_PATH}/:addressId/resend`, async (request) => settings.resend(await account(request), request.params.addressId));

  app.post<{ Body: VerifyNotificationAddressCommand }>(NOTIFICATION_ADDRESS_VERIFY_PATH, {
    schema: { body: { type: 'object', required: ['token'], additionalProperties: false, properties: { token: { type: 'string', maxLength: 128 } } } },
  }, async (request) => settings.verify(await account(request), request.body));

  // No session: the token is the authority, and it can only switch off notification email to the address that email came to.
  app.post<{ Querystring: { token?: string }; Body: { token?: string } | undefined }>(NOTIFICATION_UNSUBSCRIBE_PATH, async (request) => {
    const token = request.query.token ?? (request.body && typeof request.body === 'object' ? request.body.token : undefined);
    return unsubscribe(settingsPorts(db, mailer, publicOrigin), token);
  });
}
