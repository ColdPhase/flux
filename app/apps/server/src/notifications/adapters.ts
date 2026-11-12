import {
  notificationAddressRows,
  notificationEmailRows,
  notificationFollowRows,
  notificationPlaceRows,
  notificationPreferenceRows,
  recordNotificationsChanged,
  accessReader, type Database
} from '@flux/db';
import {
  createNotificationSettings,
  policySourceReader,
  preferenceRepository,
  readsSource,
  type SettingsPorts,
  type StoredPreferences,
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

/**
 * Stored preferences with an atomic partial change: row lock, merge and write in one transaction. A mute is written with the event that
 * tells the person's other tabs (#1249), in the same transaction.
 */
function preferenceStore(db: Database) {
  return {
    ...notificationPreferenceRows(db),
    setMuted: (userId: string, place: { type: 'project' | 'dm'; id: string }, muted: boolean) => db.transaction(async (tx) => {
      await notificationPreferenceRows(tx).setMuted(userId, place, muted);
      await recordNotificationsChanged(tx, userId, place);
    }),
    modify: (userId: string, change: (current: StoredPreferences) => StoredPreferences) => db.transaction(async (tx) => {
      const rows = notificationPreferenceRows(tx);
      const next = change(await rows.lock(userId) as StoredPreferences);
      await rows.save(userId, next as Parameters<typeof rows.save>[1]);
      return next;
    }),
  };
}

export function settingsPorts(db: Database, mailer: VerificationMailer, origin: string): SettingsPorts {
  const authorizer = policySourceReader(accessReader(db));
  const places = notificationPlaceRows(db);
  return {
    preferences: preferenceRepository(preferenceStore(db)),
    follows: {
      ...notificationFollowRows(db),
      // The choice and the event that tells the person's other tabs, in one transaction (#1249).
      set: (userId, conversationId, following) => db.transaction(async (tx) => {
        const rows = notificationFollowRows(tx);
        const thread = await rows.locate(conversationId);
        await rows.set(userId, conversationId, following);
        if (thread) await recordNotificationsChanged(tx, userId, { type: 'project', id: thread.projectId });
      }),
    },
    addresses: notificationAddressRows(db),
    unsubscribes: notificationEmailRows(db),
    authorizer,
    mailer,
    origin,
    /** Names only the places the person can read now, decided by the access policy. */
    async placeNames(list, userId) {
      const readable: typeof list = [];
      for (const place of list) {
        let decision: Awaited<ReturnType<typeof authorizer.canRead>>;
        try { decision = await authorizer.canRead(userId, place); }
        catch (error) {
          // F-030 (#712 review P2-3): only an active member learns a lock, so a place of a locked encrypted workspace is
          // listed, named by its workspace (the openers below), instead of failing the whole settings page.
          if ((error as { code?: unknown }).code === 'WORKSPACE_LOCKED') { readable.push(place); continue; }
          throw error;
        }
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

export const notificationSettings = (db: Database, mailer: VerificationMailer, origin: string) => createNotificationSettings(settingsPorts(db, mailer, origin));
