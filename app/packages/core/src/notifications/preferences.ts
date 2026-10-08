import {
  EMAIL_DESTINATIONS,
  NEEDS_YOU_REASONS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_LEVELS,
  NOTIFICATION_REASONS,
  type ChannelChoice,
  type EmailDestination,
  type NotificationChannel,
  type NotificationLevel,
  type NotificationReason,
  type UpdateNotificationPreferencesCommand,
} from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import type { PreferenceRepository, PreferenceStore } from './ports.js';

// Per-person notification preferences (issue #116). Pure rules: defaults, validation of changes,
// quiet hours in the person's own time zone and the email addresses a destination selects.

/**
 * Defaults: Only "Needs you" (F-026 S22). Every reason reaches the inbox; push is on for the
 * reasons that need you (push still needs the person to turn it on for a device), not for
 * replies. Email starts only for what is addressed to you personally — mentions, questions and
 * direct messages — and goes to the sign-in address until the person chooses.
 */
export const DEFAULT_CHANNELS: Record<NotificationReason, ChannelChoice> = {
  mention: { inApp: true, push: true, email: true },
  question: { inApp: true, push: true, email: true },
  dm: { inApp: true, push: true, email: true },
  reply: { inApp: true, push: false, email: false },
  assigned: { inApp: true, push: true, email: false },
  review: { inApp: true, push: true, email: false },
  // A live invitation is quiet: inbox and push, never email by default and never a ringing call.
  invitation: { inApp: true, push: true, email: false },
};

/** Stored preferences as the rules use them; `channels` holds only the person's overrides. */
export interface StoredPreferences {
  channels: Partial<Record<NotificationReason, Partial<ChannelChoice>>>;
  emailDestination: EmailDestination;
  quietEnabled: boolean;
  /** Minutes after local midnight. */
  quietStart: number;
  quietEnd: number;
  timeZone: string;
  /** The morning summary (S22), at `summaryAt` minutes after local midnight in `timeZone`. */
  summaryEnabled: boolean;
  summaryAt: number;
}

export const DEFAULT_PREFERENCES: StoredPreferences = {
  channels: {},
  emailDestination: 'account',
  quietEnabled: false,
  quietStart: 22 * 60,
  quietEnd: 7 * 60,
  timeZone: 'UTC',
  summaryEnabled: false,
  summaryAt: 9 * 60,
};

const NEEDS_YOU = new Set<NotificationReason>(NEEDS_YOU_REASONS);

/**
 * The channels a level gives every reason: the inbox always; push for the reasons that need you
 * (or every reason, or none); email as before, except none at "Nothing". Coming back from
 * "Nothing", email returns to its defaults.
 */
export function channelsForLevel(level: NotificationLevel, current: Record<NotificationReason, ChannelChoice>): Record<NotificationReason, ChannelChoice> {
  const emailOff = NOTIFICATION_REASONS.every((reason) => !current[reason].email);
  const result = {} as Record<NotificationReason, ChannelChoice>;
  for (const reason of NOTIFICATION_REASONS) {
    const push = level === 'everything' || (level === 'needsYou' && NEEDS_YOU.has(reason));
    const email = level === 'nothing' ? false : emailOff ? DEFAULT_CHANNELS[reason].email : current[reason].email;
    result[reason] = { inApp: true, push, email };
  }
  return result;
}

/** Which level the channels match: by push, with "Nothing" also meaning no email. */
export function levelOf(channels: Record<NotificationReason, ChannelChoice>): NotificationLevel | 'custom' {
  if (NOTIFICATION_REASONS.every((reason) => !channels[reason].push && !channels[reason].email)) return 'nothing';
  if (NOTIFICATION_REASONS.every((reason) => channels[reason].push)) return 'everything';
  if (NOTIFICATION_REASONS.every((reason) => channels[reason].push === NEEDS_YOU.has(reason))) return 'needsYou';
  return 'custom';
}

export function channelsOf(stored: Pick<StoredPreferences, 'channels'>): Record<NotificationReason, ChannelChoice> {
  const result = {} as Record<NotificationReason, ChannelChoice>;
  for (const reason of NOTIFICATION_REASONS) result[reason] = { ...DEFAULT_CHANNELS[reason], ...stored.channels[reason] };
  return result;
}

export function channelOn(stored: StoredPreferences, reason: NotificationReason, channel: NotificationChannel) {
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

export function parseClock(value: unknown, field: string, code = 'INVALID_QUIET_HOURS'): number {
  const match = typeof value === 'string' ? HHMM.exec(value) : null;
  if (!match) throw new InvalidInputError(`${field} must be a time such as "22:00"`, code);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClock(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** Applies a validated change to stored preferences; unknown reasons, channels or values are refused. */
export function applyPreferenceChange(current: StoredPreferences, command: UpdateNotificationPreferencesCommand): StoredPreferences {
  if (!command || typeof command !== 'object') throw new InvalidInputError('A change is required');
  const next: StoredPreferences = { ...current, channels: { ...current.channels } };
  if (command.level !== undefined) {
    if (!(NOTIFICATION_LEVELS as readonly string[]).includes(command.level)) throw new InvalidInputError('level must be needsYou, everything or nothing', 'INVALID_LEVEL');
    next.channels = channelsForLevel(command.level, channelsOf(current));
  }
  if (command.channels !== undefined) {
    if (!command.channels || typeof command.channels !== 'object') throw new InvalidInputError('channels must be an object', 'INVALID_CHANNELS');
    for (const [reason, choice] of Object.entries(command.channels)) {
      if (!(NOTIFICATION_REASONS as readonly string[]).includes(reason)) throw new InvalidInputError(`Unknown notification reason ${reason}`, 'INVALID_CHANNELS');
      if (!choice || typeof choice !== 'object') throw new InvalidInputError('Each reason takes { inApp, push, email }', 'INVALID_CHANNELS');
      const merged = { ...next.channels[reason as NotificationReason] };
      for (const [channel, on] of Object.entries(choice)) {
        if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel) || typeof on !== 'boolean') throw new InvalidInputError(`Unknown channel ${channel}`, 'INVALID_CHANNELS');
        merged[channel as NotificationChannel] = on;
      }
      next.channels[reason as NotificationReason] = merged;
    }
  }
  if (command.emailDestination !== undefined) {
    if (!(EMAIL_DESTINATIONS as readonly string[]).includes(command.emailDestination)) throw new InvalidInputError('emailDestination must be account, extra, both or none', 'INVALID_DESTINATION');
    next.emailDestination = command.emailDestination;
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
  const summary = command.morningSummary;
  if (summary !== undefined) {
    if (!summary || typeof summary !== 'object') throw new InvalidInputError('morningSummary must be an object', 'INVALID_MORNING_SUMMARY');
    if (summary.enabled !== undefined) {
      if (typeof summary.enabled !== 'boolean') throw new InvalidInputError('morningSummary.enabled must be true or false', 'INVALID_MORNING_SUMMARY');
      next.summaryEnabled = summary.enabled;
    }
    if (summary.at !== undefined) next.summaryAt = parseClock(summary.at, 'morningSummary.at', 'INVALID_MORNING_SUMMARY');
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

const MINUTE = 60_000;

/**
 * When push and email may go out: `now`, or — if `now` falls inside the person's quiet hours
 * (the window may cross midnight) — the first real instant after `now` whose wall-clock time in
 * their IANA zone is outside the window, i.e. the quiet end. Instants are sampled through Intl,
 * so daylight-saving transitions are honoured: an end time that does not exist on a
 * spring-forward day resolves to the first valid instant after the gap, and an end time that
 * occurs twice on a fall-back day resolves to its first occurrence after `now`. The inbox is
 * never held back.
 */
export function deliverableAt(stored: StoredPreferences, now: Date): Date {
  if (!stored.quietEnabled || stored.quietStart === stored.quietEnd || !isTimeZone(stored.timeZone)) return now;
  const { quietStart: start, quietEnd: end } = stored;
  const formatter = clockFormatter(stored.timeZone);
  const inside = (at: Date) => {
    const minute = minutesOf(formatter, at);
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  };
  if (!inside(now)) return now;
  // Zone offsets change on whole minutes, so minute resolution finds the exact end. A coarse
  // step first (never longer than the outside part of the day, so it cannot jump over it),
  // then minute by minute inside the last step. Quiet hours last under 24 h plus a DST shift.
  const outsideMinutes = (start - end + 1440) % 1440;
  const step = Math.max(1, Math.min(15, outsideMinutes)) * MINUTE;
  let before = Math.floor(now.getTime() / MINUTE) * MINUTE;
  let after = before;
  for (let spent = 0; spent <= 27 * 60 * MINUTE; spent += step) {
    after = before + step;
    if (!inside(new Date(after))) break;
    before = after;
  }
  for (let at = before + MINUTE; at <= after; at += MINUTE) if (!inside(new Date(at))) return new Date(at);
  return new Date(after);
}

/** The address kinds a destination selects. */
export function emailKinds(destination: EmailDestination): ('account' | 'extra')[] {
  switch (destination) {
    case 'account': return ['account'];
    case 'extra': return ['extra'];
    case 'both': return ['account', 'extra'];
    case 'none': return [];
  }
}

/** What remains after one address unsubscribes: the other address of "both", else in-app only. */
export function withoutAddress(destination: EmailDestination, kind: 'account' | 'extra'): EmailDestination {
  if (destination === 'both') return kind === 'account' ? 'extra' : 'account';
  if (destination === kind) return 'none';
  return destination;
}

/** Preferences with the documented defaults for anyone without a stored row. */
export function preferenceRepository(store: PreferenceStore): PreferenceRepository {
  return {
    get: async (userId) => (await store.find(userId)) ?? { ...DEFAULT_PREFERENCES, channels: {} },
    save: (userId, preferences) => store.save(userId, preferences),
    isMuted: (userId, source) => store.isMuted(userId, source),
    mutes: (userId) => store.mutes(userId),
    setMuted: (userId, source, muted) => store.setMuted(userId, source, muted),
    async modify(userId, change) {
      if (store.modify) return store.modify(userId, change);
      // Stores without transactions (in-memory test doubles) apply it directly.
      const next = change((await store.find(userId)) ?? { ...DEFAULT_PREFERENCES, channels: {} });
      await store.save(userId, next);
      return next;
    },
  };
}
