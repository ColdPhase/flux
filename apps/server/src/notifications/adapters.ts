import {
  notificationAddressRows,
  notificationEmailRows,
  notificationPlaceRows,
  notificationPreferenceRows,
  type DbExecutor,
} from '@flux/db';
import {
  createNotificationSettings,
  policySourceReader,
  preferenceRepository,
  readsSource,
  type SettingsPorts,
  type VerificationMailer,
} from '@flux/core';
import type { SmtpConfig } from '../identity/config.js';
import { createSmtpMailer } from '../identity/mailer.js';

// Adapters that connect the core notification settings use cases (issue #116) to Drizzle rows,
// the access policy and the instance SMTP transport (#46: core defines the ports).

const VERIFY_SUBJECT = 'Confirm your Flux notification address';

/** The verification email; it names no project or person and says the address cannot sign in. */
export function verificationMailer(smtp: SmtpConfig | null): VerificationMailer & { close(): void } {
  if (!smtp) return { available: false, send: async () => { throw new Error('SMTP is not configured'); }, close: () => undefined };
  const mailer = createSmtpMailer(smtp);
  return {
    available: true,
    send: (to, link) => mailer.send({
      to,
      subject: VERIFY_SUBJECT,
      text: `Someone signed in to Flux asked to receive notification emails at this address.\n\nTo confirm, open this link while signed in to that Flux account. It works once and expires in 24 hours:\n\n${link}\n\nThis address only receives notifications. It can never be used to sign in or reset a password.\nIf you did not ask for this, ignore this message.\n`,
    }),
    close: () => mailer.close(),
  };
}

export function settingsPorts(db: DbExecutor, mailer: VerificationMailer, origin: string): SettingsPorts {
  const authorizer = policySourceReader(db);
  const places = notificationPlaceRows(db);
  return {
    preferences: preferenceRepository(notificationPreferenceRows(db)),
    addresses: notificationAddressRows(db),
    unsubscribes: notificationEmailRows(db),
    authorizer,
    mailer,
    origin,
    /** Names only the places the person can read now, decided by the access policy. */
    async placeNames(list, userId) {
      const readable: typeof list = [];
      for (const place of list) {
        const decision = await authorizer.canRead(userId, place);
        if (decision.workspaceId && readsSource(decision, { workspaceId: decision.workspaceId, ...place })) readable.push(place);
      }
      const projects = await places.projectNames(readable.filter((place) => place.type === 'project').map((place) => place.id));
      const dms = await places.dmNames(readable.filter((place) => place.type === 'dm').map((place) => place.id), userId);
      const names = new Map<string, string>();
      for (const place of readable) {
        const name = place.type === 'project' ? projects.get(place.id) : dms.get(place.id);
        if (name) names.set(`${place.type}:${place.id}`, name);
      }
      return names;
    },
  };
}

export const notificationSettings = (db: DbExecutor, mailer: VerificationMailer, origin: string) => createNotificationSettings(settingsPorts(db, mailer, origin));
