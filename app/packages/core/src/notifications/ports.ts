import type { NotificationReason } from '@flux/contracts';
import type { NotificationSourceRef, PushSendJob, SourceLookup, SourceReadAuthorizer } from '../push/ports.js';
import type { StoredPreferences } from './preferences.js';

/**
 * Ports of notification generation, preferences, delivery addresses and email (issue #116).
 * Core declares them; `@flux/db` rows, the access policy, pg-boss and SMTP implement them in the
 * worker and server. Nothing in `packages/core/src/notifications` imports those libraries.
 */

/** A committed event as the generator reads it: identifiers only, as recorded. */
export interface GeneratorEvent {
  id: string;
  seq: number;
  kind: string;
  workspaceId: string;
  objectId: string;
  /** `<kind>:<id>` of the principal that caused it. */
  actorId: string;
  data: Record<string, unknown>;
}

export interface ProjectMessageFacts {
  id: string;
  workspaceId: string;
  projectId: string;
  projectName: string;
  conversationId: string;
  /** The conversation's opening message, its stable label. */
  opening: string;
  conversationCreatedBy: { kind: 'human' | 'agent'; id: string };
  author: { kind: 'human' | 'agent'; id: string };
  authorName: string | null;
  body: string;
  sequence: number;
  /** People who wrote in the conversation before this message. */
  earlierAuthors: string[];
}

export interface DmMessageFacts {
  id: string;
  workspaceId: string;
  dmId: string;
  kind: 'pair' | 'group';
  title: string | null;
  authorId: string;
  body: string;
  participantIds: string[];
}

export interface WorkFacts { id: string; projectId: string; projectName: string; title: string; ownerUserId: string | null }

export interface ReviewFacts {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  by: { kind: 'human' | 'agent'; id: string };
  /** People who own work this decision affects or this result is about. */
  workOwners: string[];
  /** The person who owns the agent that produced it, when an agent did. */
  agentOwner: string | null;
}

/**
 * A live invitation that still asks something of its recipient: it exists, is `pending`, and
 * its session is `available` (#62). The anchor label is project-level text the recipient could
 * read when invited (a conversation's opening message, a work item, project sketch or doc title).
 */
export interface LiveInvitationFacts {
  id: string;
  sessionId: string;
  projectId: string;
  projectName: string;
  inviterId: string;
  recipientId: string;
  anchor: { type: 'conversation' | 'work' | 'sketch' | 'doc'; label: string };
}

/** Current domain rows the generator needs to explain an event. No access decisions. */
export interface NotificationFacts {
  /** Human user ids in the event's recorded audience (`event_audience`, decided at write time). */
  audience(eventId: string): Promise<string[]>;
  projectMessage(messageId: string): Promise<ProjectMessageFacts | null>;
  dmMessage(dmId: string, messageId: string): Promise<DmMessageFacts | null>;
  work(workId: string): Promise<WorkFacts | null>;
  decision(decisionId: string): Promise<ReviewFacts | null>;
  result(resultId: string): Promise<ReviewFacts | null>;
  /** Null unless the invitation is still pending and its session still available. */
  liveInvitation(invitationId: string): Promise<LiveInvitationFacts | null>;
  names(userIds: string[]): Promise<Map<string, string>>;
}

export type EmailAddressKind = 'account' | 'extra';

/** Stored rows only; `find` answers null for someone who never changed anything. */
export interface PreferenceStore {
  find(userId: string): Promise<StoredPreferences | null>;
  save(userId: string, preferences: StoredPreferences): Promise<void>;
  isMuted(userId: string, source: { type: string; id: string }): Promise<boolean>;
  mutes(userId: string): Promise<{ type: 'project' | 'dm'; id: string }[]>;
  setMuted(userId: string, source: { type: 'project' | 'dm'; id: string }, muted: boolean): Promise<void>;
  /**
   * Reads the person's row locked (creating it with the defaults if missing), applies `change`
   * and writes the result, in one transaction, so concurrent partial changes never overwrite
   * each other. Returns what was stored.
   */
  modify?(userId: string, change: (current: StoredPreferences) => StoredPreferences): Promise<StoredPreferences>;
}

export interface PreferenceRepository {
  /** Stored preferences, or the defaults for someone who never changed them. */
  get(userId: string): Promise<StoredPreferences>;
  save(userId: string, preferences: StoredPreferences): Promise<void>;
  isMuted(userId: string, source: { type: string; id: string }): Promise<boolean>;
  mutes(userId: string): Promise<{ type: 'project' | 'dm'; id: string }[]>;
  setMuted(userId: string, source: { type: 'project' | 'dm'; id: string }, muted: boolean): Promise<void>;
  /** Atomic read-change-write of the person's preferences (see `PreferenceStore.modify`). */
  modify(userId: string, change: (current: StoredPreferences) => StoredPreferences): Promise<StoredPreferences>;
}

export interface GeneratedNotification {
  id: string;
  userId: string;
  source: NotificationSourceRef;
  reason: NotificationReason;
  eventId: string;
  title: string;
  body: string;
  url: string;
  inInbox: boolean;
}

export interface EmailJob { emailId: string }

export interface GeneratorPorts {
  /** Locks the generator's position for this transaction and returns it. */
  lockCursor(): Promise<number>;
  advanceCursor(seq: number): Promise<void>;
  eventsAfter(seq: number, limit: number): Promise<GeneratorEvent[]>;
  facts: NotificationFacts;
  preferences: PreferenceRepository;
  authorizer: SourceReadAuthorizer;
  /** Inserts once per (recipient, event); false when it already exists. */
  insertNotification(notification: GeneratedNotification): Promise<boolean>;
  deliverableSubscriptions(userId: string): Promise<string[]>;
  /** Whether an email about the same source was queued for this person since `since`. */
  emailedRecently(userId: string, source: SourceLookup, since: Date): Promise<boolean>;
  insertEmail(row: { id: string; notificationId: string; userId: string; addressKind: EmailAddressKind }): Promise<boolean>;
  enqueuePush(job: PushSendJob, startAfter: Date | null): Promise<string | null>;
  enqueueEmail(job: EmailJob, startAfter: Date | null): Promise<string | null>;
  /** Counts a failed generation of the event (outside its savepoint) and returns the attempts so far. */
  recordFailure(eventId: string, error: string): Promise<number>;
  /** Marks the event as given up on, for operators to inspect. */
  deadLetter(eventId: string): Promise<void>;
  /** Runs `work` in a savepoint so one event that fails does not undo the batch. */
  isolate<T>(work: () => Promise<T>): Promise<T>;
}

export interface GeneratorUnitOfWork {
  run<T>(work: (ports: GeneratorPorts) => Promise<T>): Promise<T>;
}

/** The email row and its notification, read from current rows. */
export interface ClaimableEmail {
  id: string;
  userId: string;
  addressKind: EmailAddressKind;
  status: 'queued' | 'sending' | 'sent' | 'skipped';
  notification: { id: string; source: NotificationSourceRef; reason: NotificationReason | null };
}

export interface EmailDeliveryPorts {
  /** Locks the email row (FOR UPDATE) in this transaction. */
  lockEmail(id: string): Promise<ClaimableEmail | null>;
  authorizer: SourceReadAuthorizer;
  preferences: PreferenceRepository;
  /** The sign-in address, or null when the account is gone. */
  accountAddress(userId: string): Promise<string | null>;
  /** The verified extra address, or null. */
  verifiedExtraAddress(userId: string): Promise<string | null>;
  markSkipped(id: string, reason: string): Promise<void>;
  markSending(id: string, address: string, unsubscribeHash: string): Promise<void>;
  markSent(id: string): Promise<void>;
  /** Back to queued after a send that failed before SMTP accepted it, so the retry may send. */
  requeue(id: string, error: string): Promise<void>;
}

export interface EmailDeliveryUnitOfWork {
  run<T>(work: (ports: EmailDeliveryPorts) => Promise<T>): Promise<T>;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  headers: Record<string, string>;
  messageId: string;
}

export type MailResult = { kind: 'accepted' } | { kind: 'failed'; message: string };

export interface NotificationMailer {
  send(mail: OutgoingMail): Promise<MailResult>;
}

export interface AddressRecord {
  id: string;
  userId: string;
  email: string;
  verifiedAt: Date | null;
  lastSentAt: Date | null;
}

export interface AddressRepository {
  find(userId: string): Promise<AddressRecord | null>;
  /** Replaces the person's extra address (and its tokens) with a new unverified one. */
  replace(userId: string, id: string, email: string): Promise<AddressRecord>;
  remove(userId: string): Promise<boolean>;
  /** Stores a new token hash for the address, removing earlier ones, and records the send time. */
  issueToken(addressId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  /** Consumes a token that belongs to `userId`'s address and has not expired; marks it verified. */
  consumeToken(userId: string, tokenHash: string): Promise<AddressRecord | null>;
  /** Atomically reserves one verification send within the limits, or says how long to wait. */
  reserveVerificationSend(userId: string, limits: { cooldownSeconds: number; perWindow: number; windowSeconds: number }):
    Promise<{ allowed: true } | { allowed: false; retryAfterSeconds: number }>;
}

export interface VerificationMailer {
  /** False when SMTP is not configured. */
  available: boolean;
  send(to: string, link: string): Promise<void>;
}

export interface UnsubscribeRepository {
  /** The email the token was placed in: its recipient, address kind and the exact address used. */
  findByToken(tokenHash: string): Promise<{ userId: string; addressKind: EmailAddressKind; address: string | null } | null>;
  /** The current sign-in address. */
  accountAddress(userId: string): Promise<string | null>;
  /** The current verified extra address. */
  verifiedExtraAddress(userId: string): Promise<string | null>;
  /** The latest SMTP failure of an email to this person that is still unsent, since `since`. */
  lastFailure(userId: string, since: Date): Promise<Date | null>;
}
