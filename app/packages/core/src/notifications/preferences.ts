import {
  NEEDS_YOU_REASONS,
  NOTIFICATION_LEVELS,
  NOTIFICATION_REASONS,
  type ChannelChoice,
  type NotificationChannel,
  type NotificationLevel,
  type NotificationReason,
  type UpdateNotificationPreferencesCommand,
} from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import type { PreferenceRepository, PreferenceStore } from './ports.js';

// Per-person notification preferences (issue #116, #872). Pure rules: defaults, validation of changes and quiet hours
// in the person's own time zone. A person stores a level, whether email comes too, and quiet hours (C-31 to C-33);
// the channels of each reason are derived from them.

/** Stored preferences as the rules use them. */
export interface StoredPreferences {
  /** What may interrupt the person with push, and with email when `emailMe`. */
  level: NotificationLevel;
  /** "Email me too" (C-32): the same events as the level, by email, to each address that is switched on. */
  emailMe: boolean;
  /** The sign-in address's own switch (C-49); an extra address has its own on its row. */
  accountEnabled: boolean;
  quietEnabled: boolean;
  /** Minutes after local midnight. */
  quietStart: number;
  quietEnd: number;
  timeZone: string;
  /** "Sound for messages" (#1243): off by default. */
  soundMessages: boolean;
  /** "Sound when someone calls me" (#1243): on by default. */
  soundCalls: boolean;
  /** "Hide previews" (#1346): a push says only who and where, never what was written. Off by default. */
  hidePreviews: boolean;
}

/**
 * Defaults: Only what needs me, with email too (C-35): the inbox always fills; push goes to the reasons that need you
 * (push still needs the person to turn it on for a device); email follows the same reasons to the sign-in address.
 */
export const DEFAULT_PREFERENCES: StoredPreferences = {
  level: 'needsYou',
  emailMe: true,
  accountEnabled: true,
  quietEnabled: false,
  quietStart: 22 * 60,
  quietEnd: 7 * 60,
  timeZone: 'UTC',
  soundMessages: false,
  soundCalls: true,
  hidePreviews: false,
};

const NEEDS_YOU = new Set<NotificationReason>(NEEDS_YOU_REASONS);
/** A live call invitation and a call started in your space are inbox and push only, never email: the call may be over before a mail is read (docs/development/live-sessions.md, F-041). */
const NEVER_EMAILED = new Set<NotificationReason>(['invitation', 'call']);

/**
 * The channels each reason has under the stored level: the inbox always; push for the reasons the level lets interrupt
 * (the reasons that need you, every reason, or none); email on the same reasons when "Email me too" is on, except a live call
 * invitation, which is never emailed.
 */
export function channelsOf(stored: Pick<StoredPreferences, 'level' | 'emailMe'>): Record<NotificationReason, ChannelChoice> {
  const result = {} as Record<NotificationReason, ChannelChoice>;
  for (const reason of NOTIFICATION_REASONS) {
    const interrupts = stored.level === 'everything' || (stored.level === 'needsYou' && NEEDS_YOU.has(reason));
    result[reason] = { inApp: true, push: interrupts, email: interrupts && stored.emailMe && !NEVER_EMAILED.has(reason) };
  }
  return result;
}

/**
 * Muting a place keeps only its ordinary messages quiet (#1249, founder decision): a reply in a thread and a direct message. Everything that
 * needs the person still arrives, on every channel: a mention of them, a question to them, a task given to them, a decision about their
 * work, a live invitation and an agent waiting for their OK (the reasons of "Only what needs me", except an ordinary direct message).
 * This is the one rule: the generator, the push job and the email job all ask `PreferenceRepository.quiet`, which asks it.
 */
export const REACHES_MUTED_PLACE = new Set<NotificationReason>(NEEDS_YOU_REASONS.filter((reason) => reason !== 'dm'));

export function channelOn(stored: Pick<StoredPreferences, 'level' | 'emailMe'>, reason: NotificationReason, channel: NotificationChannel) {
  return channelsOf(stored)[reason][channel];
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClock(value: unknown, field: string): number {
  const match = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!match) throw new InvalidInputError(`${field} must be a time such as "22:00"`, 'INVALID_QUIET_HOURS');
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Applies a validated change to stored preferences; unknown values are refused. */
export function applyPreferenceChange(current: StoredPreferences, command: UpdateNotificationPreferencesCommand): StoredPreferences {
  if (!command || typeof command !== 'object') throw new InvalidInputError('A change is required');
  const next: StoredPreferences = { ...current };
  if (command.level !== undefined) {
    if (!(NOTIFICATION_LEVELS as readonly string[]).includes(command.level)) throw new InvalidInputError('level must be needsYou, everything or nothing', 'INVALID_LEVEL');
    next.level = command.level;
  }
  if (command.emailMe !== undefined) {
    if (typeof command.emailMe !== 'boolean') throw new InvalidInputError('emailMe must be true or false', 'INVALID_EMAIL_ME');
    next.emailMe = command.emailMe;
  }
  if (command.accountEnabled !== undefined) {
    if (typeof command.accountEnabled !== 'boolean') throw new InvalidInputError('accountEnabled must be true or false', 'INVALID_ACCOUNT_ENABLED');
    next.accountEnabled = command.accountEnabled;
  }
  if (command.hidePreviews !== undefined) {
    if (typeof command.hidePreviews !== 'boolean') throw new InvalidInputError('hidePreviews must be true or false', 'INVALID_HIDE_PREVIEWS');
    next.hidePreviews = command.hidePreviews;
  }
  const sound = command.sound;
  if (sound !== undefined) {
    if (!sound || typeof sound !== 'object') throw new InvalidInputError('sound must be an object', 'INVALID_SOUND');
    for (const [key, field] of [['messages', 'soundMessages'], ['calls', 'soundCalls']] as const) {
      const value = sound[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') throw new InvalidInputError(`sound.${key} must be true or false`, 'INVALID_SOUND');
      next[field] = value;
    }
  }
  const quiet = command.quietHours;
  if (quiet !== undefined) {
    if (!quiet || typeof quiet !== 'object') throw new InvalidInputError('quietHours must be an object', 'INVALID_QUIET_HOURS');
    if (quiet.enabled !== undefined) {
      if (typeof quiet.enabled !== 'boolean') throw new InvalidInputError('quietHours.enabled must be true or false', 'INVALID_QUIET_HOURS');
      next.quietEnabled = quiet.enabled;
    }
    if (quiet.start !== undefined) next.quietStart = parseClock(quiet.start, 'quietHours.start');
    if (quiet.end !== undefined) next.quietEnd = parseClock(quiet.end, 'quietHours.end');
    if (quiet.timeZone !== undefined) {
      if (!isTimeZone(quiet.timeZone)) throw new InvalidInputError('quietHours.timeZone must be an IANA time zone', 'INVALID_TIME_ZONE');
      next.timeZone = quiet.timeZone;
    }
    if (next.quietEnabled && next.quietStart === next.quietEnd) throw new InvalidInputError('Quiet hours need different start and end times', 'INVALID_QUIET_HOURS');
  }
  return next;
}

function clockFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function minutesOf(formatter: Intl.DateTimeFormat, at: Date) {
  const parts = formatter.formatToParts(at);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  return (hour % 24) * 60 + minute;
}

/** Minutes after local midnight at `now` in `timeZone`. */
export function localMinutes(now: Date, timeZone: string) {
  return minutesOf(clockFormatter(timeZone), now);
}

/**
 * Whether `now` falls inside the person's quiet hours (the window may cross midnight), read in their IANA zone, so
 * daylight-saving transitions are honoured. During quiet hours there is no push and no email, and nothing is sent when
 * they end (C-31); the inbox always fills.
 */
export function inQuietHours(stored: StoredPreferences, now: Date): boolean {
  if (!stored.quietEnabled || stored.quietStart === stored.quietEnd || !isTimeZone(stored.timeZone)) return false;
  const minute = minutesOf(clockFormatter(stored.timeZone), now);
  const { quietStart: start, quietEnd: end } = stored;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** Preferences with the documented defaults for anyone without a stored row. */
export function preferenceRepository(store: PreferenceStore): PreferenceRepository {
  return {
    get: async (userId) => (await store.find(userId)) ?? { ...DEFAULT_PREFERENCES },
    save: (userId, preferences) => store.save(userId, preferences),
    isMuted: (userId, source) => store.isMuted(userId, source),
    quiet: async (userId, source, reason) => !(reason && REACHES_MUTED_PLACE.has(reason)) && await store.isMuted(userId, source),
    mutes: (userId) => store.mutes(userId),
    setMuted: (userId, source, muted) => store.setMuted(userId, source, muted),
    async modify(userId, change) {
      if (store.modify) return store.modify(userId, change);
      // Stores without transactions (in-memory test doubles) apply it directly.
      const next = change((await store.find(userId)) ?? { ...DEFAULT_PREFERENCES });
      await store.save(userId, next);
      return next;
    },
  };
}
