// Notification preferences, delivery addresses and email unsubscribe (issue #116, foundation 8.9; #872).
// The inbox itself is in ./push.ts (#41). Every notification has a reason a person can act on;
// people choose one level, whether email comes too, mute places and set quiet hours.

/**
 * Why a notification exists. `review` covers a proposed decision or a recorded result that is
 * about work you own, or that your agent produced. `invitation` is someone asking you to join
 * them live at a task, map, doc or conversation (#62): one quiet signal per invitation.
 */
export const NOTIFICATION_REASONS = ['mention', 'question', 'reply', 'dm', 'assigned', 'review', 'invitation'] as const;
export type NotificationReason = typeof NOTIFICATION_REASONS[number];

/**
 * The reasons that "need you" (F-026 S22): decisions and results about your work, questions and
 * mentions, direct messages, work assigned to you and invitations. Replies in conversations you
 * joined are the rest of "Everything".
 */
export const NEEDS_YOU_REASONS = ['mention', 'question', 'dm', 'assigned', 'review', 'invitation'] as const satisfies readonly NotificationReason[];

/**
 * What may interrupt you with push and email (F-026 S22). The inbox keeps every reason in each
 * level. The level is all a person stores of "which kinds" (C-33): there is no per-reason choice.
 */
export const NOTIFICATION_LEVELS = ['needsYou', 'everything', 'nothing'] as const;
export type NotificationLevel = typeof NOTIFICATION_LEVELS[number];

export const NOTIFICATION_CHANNELS = ['inApp', 'push', 'email'] as const;
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number];
export type ChannelChoice = Record<NotificationChannel, boolean>;

export const NOTIFICATION_PREFERENCES_PATH = '/api/v1/notification-preferences';
export const NOTIFICATION_MUTES_PATH = `${NOTIFICATION_PREFERENCES_PATH}/mutes`;
export const NOTIFICATION_ADDRESS_PATH = '/api/v1/notification-address';
export const NOTIFICATION_ADDRESS_RESEND_PATH = `${NOTIFICATION_ADDRESS_PATH}/resend`;
export const NOTIFICATION_ADDRESS_VERIFY_PATH = `${NOTIFICATION_ADDRESS_PATH}/verify`;
/** RFC 8058 one-click target (`POST ?token=`); also used by the unsubscribe page. */
export const NOTIFICATION_UNSUBSCRIBE_PATH = '/api/v1/notifications/unsubscribe';
export const INBOX_READ_ALL_PATH = '/api/v1/inbox/read-all';

export interface QuietHours {
  enabled: boolean;
  /** Local time "HH:MM" in `timeZone`; the window may cross midnight. */
  start: string;
  end: string;
  /** IANA time zone, e.g. "Europe/Warsaw". */
  timeZone: string;
}

export type MutablePlaceType = 'project' | 'dm';

/** A place the person muted. `name` is shown only while they can still read it. */
export interface MutedPlace {
  type: MutablePlaceType;
  id: string;
  name: string;
}

/** The extra delivery address. Only one; replacing it starts a new verification. */
export interface NotificationAddress {
  email: string;
  verified: boolean;
  verifiedAt: string | null;
  /** When the latest verification link was sent. */
  sentAt: string | null;
}

export interface NotificationPreferences {
  /** What may interrupt you with push (and email, when `emailMe`). */
  level: NotificationLevel;
  /** "Email me too" (C-32): the same events as the level, by email to the sign-in address and a confirmed extra address. */
  emailMe: boolean;
  email: {
    /** The sign-in address; changing email delivery never changes it. */
    accountAddress: string;
    extra: NotificationAddress | null;
    /** False when the operator has not configured SMTP: "email delivery unavailable"; the inbox still works. */
    available: boolean;
    /** The latest failed attempt to email you in the past day that is still unsent, or null. */
    lastFailureAt: string | null;
  };
  quietHours: QuietHours;
  muted: MutedPlace[];
}

/** `PATCH /api/v1/notification-preferences`: every field is optional and merged. */
export interface UpdateNotificationPreferencesCommand {
  level?: NotificationLevel;
  emailMe?: boolean;
  quietHours?: Partial<QuietHours>;
}

/** `PUT /api/v1/notification-preferences/mutes`: mute or unmute a place you can read. */
export interface SetMuteCommand {
  type: MutablePlaceType;
  id: string;
  muted: boolean;
}

/** `POST /api/v1/notification-address`: replaces the extra address and emails a verification link. */
export interface AddNotificationAddressCommand {
  email: string;
}

/** `POST /api/v1/notification-address/verify`, signed in as the account that added the address. */
export interface VerifyNotificationAddressCommand {
  token: string;
}

/**
 * Which address stopped receiving email. The sign-in address stops with "Email me too" (`emailMe` is then false); an extra
 * address is removed. Either can be turned on or added again in settings.
 */
export interface UnsubscribeResponse {
  /** `stale`: the link belongs to an address that is no longer yours (replaced or changed); nothing changed. */
  result: 'stopped' | 'stale';
  stopped: 'account' | 'extra';
  emailMe: boolean;
}

/** Fixed subject of every notification email: it never names a project, person or message. */
export const NOTIFICATION_EMAIL_SUBJECT = 'New activity in Flux';
