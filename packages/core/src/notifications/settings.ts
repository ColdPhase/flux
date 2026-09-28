import { randomUUID } from 'node:crypto';
import type {
  MutedPlace,
  NotificationAddress,
  NotificationPreferences,
  SetMuteCommand,
  UnsubscribeResponse,
  UpdateNotificationPreferencesCommand,
} from '@flux/contracts';
import { ConflictError, DomainError, InvalidInputError, NotFoundError } from '../access/errors.js';
import type { SourceReadAuthorizer } from '../push/ports.js';
import { hashToken, newToken } from './email.js';
import type { AddressRecord, AddressRepository, PreferenceRepository, UnsubscribeRepository, VerificationMailer } from './ports.js';
import { applyPreferenceChange, channelsOf, formatClock, withoutAddress } from './preferences.js';

// Notification settings of one signed-in person (issue #116): preferences, muted places, the
// extra delivery address and its verification, and one-click unsubscribe. A delivery address is
// only a destination for notification email: nothing here touches sign-in, sessions, grants or
// password reset, which keep using the account's own address.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A deliberately plain check; verification proves the mailbox. */
const EMAIL = /^[^\s@<>()[\],;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const VERIFICATION_TTL_MS = 24 * 3600_000;
export const VERIFICATION_RESEND_MS = 60_000;

export class MailUnavailableError extends DomainError {
  constructor() {
    super(503, 'EMAIL_UNAVAILABLE', 'Email is not set up on this Flux server');
  }
}

export class MailSendError extends DomainError {
  constructor() {
    super(503, 'EMAIL_SEND_FAILED', 'The verification email could not be sent; try again in a moment');
  }
}

export class TooSoonError extends DomainError {
  constructor() {
    super(429, 'VERIFICATION_RECENTLY_SENT', 'A verification link was sent less than a minute ago');
  }
}

export interface SettingsPorts {
  preferences: PreferenceRepository;
  addresses: AddressRepository;
  unsubscribes: UnsubscribeRepository;
  authorizer: SourceReadAuthorizer;
  mailer: VerificationMailer;
  /** Names of places the caller can read, for the muted list. */
  placeNames(places: { type: 'project' | 'dm'; id: string }[], userId: string): Promise<Map<string, string>>;
  origin: string;
  now?: () => Date;
}

export interface Account {
  userId: string;
  email: string;
}

function addressView(record: AddressRecord | null): NotificationAddress | null {
  if (!record) return null;
  return { email: record.email, verified: !!record.verifiedAt, verifiedAt: record.verifiedAt?.toISOString() ?? null, sentAt: record.lastSentAt?.toISOString() ?? null };
}

export function normalizeEmail(value: unknown) {
  const email = typeof value === 'string' ? value.trim() : '';
  if (email.length > 254 || !EMAIL.test(email)) throw new InvalidInputError('Enter an email address such as name@example.org', 'INVALID_EMAIL');
  const at = email.lastIndexOf('@');
  return `${email.slice(0, at)}@${email.slice(at + 1).toLowerCase()}`;
}

export function createNotificationSettings(ports: SettingsPorts) {
  const now = () => ports.now?.() ?? new Date();

  async function view(account: Account): Promise<NotificationPreferences> {
    const stored = await ports.preferences.get(account.userId);
    const mutes = await ports.preferences.mutes(account.userId);
    const names = await ports.placeNames(mutes, account.userId);
    // A place the person can no longer read stays muted but is not named or listed.
    const muted: MutedPlace[] = mutes.filter((place) => names.has(`${place.type}:${place.id}`))
      .map((place) => ({ ...place, name: names.get(`${place.type}:${place.id}`)! }));
    return {
      channels: channelsOf(stored),
      email: {
        destination: stored.emailDestination, accountAddress: account.email, extra: addressView(await ports.addresses.find(account.userId)), available: ports.mailer.available,
        lastFailureAt: (await ports.unsubscribes.lastFailure(account.userId, new Date(now().getTime() - 24 * 3600_000)))?.toISOString() ?? null,
      },
      quietHours: { enabled: stored.quietEnabled, start: formatClock(stored.quietStart), end: formatClock(stored.quietEnd), timeZone: stored.timeZone },
      muted,
    };
  }

  async function sendVerification(address: AddressRecord) {
    const token = newToken();
    await ports.addresses.issueToken(address.id, hashToken(token), new Date(now().getTime() + VERIFICATION_TTL_MS));
    try {
      await ports.mailer.send(address.email, `${ports.origin}/settings/notifications/verify?token=${encodeURIComponent(token)}`);
    } catch {
      // The address stays pending; "Send again" retries once the mail server answers.
      throw new MailSendError();
    }
  }

  return {
    view,

    async update(account: Account, command: UpdateNotificationPreferencesCommand) {
      const next = applyPreferenceChange(await ports.preferences.get(account.userId), command);
      await ports.preferences.save(account.userId, next);
      return view(account);
    },

    /** Mutes only a place the person can read now; unmuting always works. */
    async setMute(account: Account, command: SetMuteCommand) {
      if (!command || (command.type !== 'project' && command.type !== 'dm') || typeof command.id !== 'string' || !UUID.test(command.id) || typeof command.muted !== 'boolean') {
        throw new InvalidInputError('Give { type: "project" | "dm", id, muted }', 'INVALID_MUTE');
      }
      const place = { type: command.type, id: command.id.toLowerCase() };
      if (command.muted) {
        const decision = await ports.authorizer.canRead(account.userId, place);
        if (!decision.visible || !decision.allowed) throw new NotFoundError(command.type === 'dm' ? 'Direct message' : 'Project', 'PLACE_NOT_FOUND');
      }
      await ports.preferences.setMuted(account.userId, place, command.muted);
      return view(account);
    },

    /** Replaces the extra address and sends a single-use link that expires in 24 hours. */
    async addAddress(account: Account, input: { email: unknown }) {
      if (!ports.mailer.available) throw new MailUnavailableError();
      const email = normalizeEmail(input?.email);
      if (email.toLowerCase() === account.email.toLowerCase()) {
        throw new ConflictError('This is already your sign-in address; choose it under "Where email goes"', 'ADDRESS_IS_ACCOUNT');
      }
      const address = await ports.addresses.replace(account.userId, randomUUID(), email);
      await sendVerification(address);
      return view(account);
    },

    async resend(account: Account) {
      if (!ports.mailer.available) throw new MailUnavailableError();
      const address = await ports.addresses.find(account.userId);
      if (!address || address.verifiedAt) throw new NotFoundError('Unverified address', 'ADDRESS_NOT_PENDING');
      if (address.lastSentAt && now().getTime() - address.lastSentAt.getTime() < VERIFICATION_RESEND_MS) throw new TooSoonError();
      await sendVerification(address);
      return view(account);
    },

    /**
     * Verifies the address with a token from the link, for the signed-in account that added it.
     * A used, expired, replaced or someone else's token gives the same answer.
     */
    async verify(account: Account, input: { token: unknown }) {
      const token = typeof input?.token === 'string' ? input.token.trim() : '';
      if (!token || token.length > 128) throw new InvalidInputError('The verification link is not valid', 'VERIFICATION_INVALID');
      const address = await ports.addresses.consumeToken(account.userId, hashToken(token));
      if (!address) throw new InvalidInputError('This verification link has expired or was already used', 'VERIFICATION_INVALID');
      return view(account);
    },

    /** Removing the extra address never starts email to the sign-in address by itself. */
    async removeAddress(account: Account) {
      if (!await ports.addresses.remove(account.userId)) throw new NotFoundError('Address', 'ADDRESS_NOT_FOUND');
      const stored = await ports.preferences.get(account.userId);
      const next = withoutAddress(stored.emailDestination, 'extra');
      if (next !== stored.emailDestination) await ports.preferences.save(account.userId, { ...stored, emailDestination: next });
      return view(account);
    },
  };
}

/**
 * One-click unsubscribe (RFC 8058) with the token from one email: that address stops receiving
 * notification email. It needs no session and changes nothing but the email destination.
 * Repeating it is harmless.
 */
export async function unsubscribe(ports: Pick<SettingsPorts, 'preferences' | 'unsubscribes'>, token: unknown): Promise<UnsubscribeResponse> {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value || value.length > 128) throw new NotFoundError('Unsubscribe link', 'UNSUBSCRIBE_INVALID');
  const email = await ports.unsubscribes.findByToken(hashToken(value));
  if (!email) throw new NotFoundError('Unsubscribe link', 'UNSUBSCRIBE_INVALID');
  const stored = await ports.preferences.get(email.userId);
  const destination = withoutAddress(stored.emailDestination, email.addressKind);
  if (destination !== stored.emailDestination) await ports.preferences.save(email.userId, { ...stored, emailDestination: destination });
  return { stopped: email.addressKind, destination };
}
