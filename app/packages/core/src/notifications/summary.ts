import { randomUUID } from 'node:crypto';
import { readsSource } from '../push/notifications.js';
import type { NotificationSourceRef, SourceReadAuthorizer } from '../push/ports.js';
import { channelsOf, levelOf, type StoredPreferences } from './preferences.js';
import { scheduledSummaryDay } from './summary-schedule.js';

// The morning summary (#350, F-026 S22): once a local day, at the person's chosen time in their
// quiet-hours time zone, one push counts what still waits in their inbox. It is not an inbox
// item itself; the inbox already lists everything it counts.

export const MORNING_SUMMARY_JOB = 'notification.morning-summary.v1';
/** The scheduler ticks every 15 minutes; a summary missed by more than this waits for tomorrow. */
export const MORNING_SUMMARY_LATE_MINUTES = 180;
/** Unread inbox rows looked at per person; the count shows "50+" beyond it. */
export const MORNING_SUMMARY_LOOKBACK = 50;

/** The local calendar day ("YYYY-MM-DD") at `now` in `timeZone`. */
export function localDay(now: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Current preferences explicitly admit a summary only while enabled and not at Nothing. */
export function summaryWanted(preferences: Pick<StoredPreferences, 'summaryEnabled' | 'channels'>) {
  return preferences.summaryEnabled && levelOf(channelsOf(preferences)) !== 'nothing';
}

/** The scheduled local day still within its elapsed-time window and beyond the durable claim. */
export function summaryDueOn(preferences: Pick<StoredPreferences, 'summaryEnabled' | 'summaryAt' | 'timeZone' | 'channels'>, lastOn: string | null, now: Date): string | null {
  if (!summaryWanted(preferences)) return null;
  const day = scheduledSummaryDay(preferences.summaryAt, preferences.timeZone, now);
  // A timezone/schedule edit cannot rewind the claim watermark and redeliver an old day.
  return day && (!lastOn || lastOn < day) ? day : null;
}

export function summaryTitle(count: number, more: boolean) {
  if (more) return `${count}+ things wait in your inbox`;
  return count === 1 ? '1 thing waits in your inbox' : `${count} things wait in your inbox`;
}

export interface SummaryCandidate {
  userId: string;
  preferences: Pick<StoredPreferences, 'summaryEnabled' | 'summaryAt' | 'timeZone' | 'channels'>;
  lastOn: string | null;
}

export interface SummaryPorts {
  authorizer: SourceReadAuthorizer;
  lockCandidate(userId: string): Promise<SummaryCandidate | null>;
  isMuted(userId: string, source: NotificationSourceRef): Promise<boolean>;
  /** Claims the day for the person: true only for the first caller (`summary_last_on` advances to `day`). */
  claimDay(userId: string, day: string): Promise<boolean>;
  /** The person's newest unread inbox notifications, newest first. */
  unread(userId: string, limit: number): Promise<{ id: string; source: NotificationSourceRef }[]>;
  /** Stores the summary as a notification outside the inbox with its explicit kind and complete source list. */
  insertSummary(row: { id: string; userId: string; source: NotificationSourceRef; sources: NotificationSourceRef[]; title: string; body: string; url: string }): Promise<void>;
  deliverableSubscriptions(userId: string): Promise<string[]>;
  enqueuePush(job: { notificationId: string; subscriptionId: string; userId: string }): Promise<unknown>;
}

export interface SummaryUnitOfWork {
  /** People with the summary on. */
  candidates(): Promise<SummaryCandidate[]>;
  /** One person's summary in one transaction, so the claimed day commits with its push jobs. */
  run<T>(work: (ports: SummaryPorts) => Promise<T>): Promise<T>;
}

/**
 * Sends the summaries that are due. Only sources the person can read now are counted, and the
 * push retains every counted source so delivery can suppress the aggregate if any source has
 * become unreadable or muted. Nobody is told about an empty inbox.
 */
export async function sendMorningSummaries(uow: SummaryUnitOfWork, now: Date = new Date()) {
  let sent = 0;
  let empty = 0;
  for (const candidate of await uow.candidates()) {
    const day = summaryDueOn(candidate.preferences, candidate.lastOn, now);
    if (!day) continue;
    const outcome = await uow.run(async (ports) => {
      const current = await ports.lockCandidate(candidate.userId);
      const currentDay = current && summaryDueOn(current.preferences, current.lastOn, now);
      if (!currentDay) return 'changed' as const;
      if (!await ports.claimDay(candidate.userId, currentDay)) return 'claimed' as const;
      const rows = await ports.unread(candidate.userId, MORNING_SUMMARY_LOOKBACK + 1);
      const readable: NotificationSourceRef[] = [];
      for (const row of rows) if (!await ports.isMuted(candidate.userId, row.source) && readsSource(await ports.authorizer.canRead(candidate.userId, row.source), row.source)) readable.push(row.source);
      if (!readable.length) return 'empty' as const;
      const more = readable.length > MORNING_SUMMARY_LOOKBACK;
      const id = randomUUID();
      await ports.insertSummary({
        id, userId: candidate.userId, source: readable[0]!, sources: readable, url: '/inbox',
        title: summaryTitle(Math.min(readable.length, MORNING_SUMMARY_LOOKBACK), more), body: 'Your morning summary from Flux',
      });
      for (const subscriptionId of await ports.deliverableSubscriptions(candidate.userId)) {
        await ports.enqueuePush({ notificationId: id, subscriptionId, userId: candidate.userId });
      }
      return 'sent' as const;
    });
    if (outcome === 'sent') sent++;
    if (outcome === 'empty') empty++;
  }
  return { sent, empty };
}
