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
  preferences: Pick<StoredPreferences, 'summaryEnabled' | 'summaryAt' | 'timeZone' | 'channels'> & Partial<Pick<StoredPreferences, 'summaryByAssistant'>>;
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
  insertSummary(row: { id: string; userId: string; source: NotificationSourceRef; sources: NotificationSourceRef[]; title: string; body: string; url: string; aiOrigin: boolean }): Promise<void>;
  deliverableSubscriptions(userId: string): Promise<string[]>;
  /** F-030: whether the workspace is encrypted. Its row stays content-free: anchored on a plain source, or the plain count. */
  sealedWorkspace?(workspaceId: string): Promise<boolean>;
  enqueuePush(job: { notificationId: string; subscriptionId: string; userId: string }): Promise<unknown>;
  /**
   * F-027 A8: when the person asked their assistant to write the summary, starts that run in this same transaction (the claimed
   * day commits with it). False when the assistant cannot write it now: the plain summary goes out, as before.
   */
  assistantSummary?: { start(userId: string, day: string, now: Date): Promise<boolean> };
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
  let writing = 0;
  const failed: unknown[] = [];
  for (const candidate of await uow.candidates()) {
    const day = summaryDueOn(candidate.preferences, candidate.lastOn, now);
    if (!day) continue;
    // One person's failure never stops the tick for the others; their day stays unclaimed and the next tick retries.
    const outcome = await uow.run(async (ports) => {
      const current = await ports.lockCandidate(candidate.userId);
      const currentDay = current && summaryDueOn(current.preferences, current.lastOn, now);
      if (!currentDay) return 'changed' as const;
      if (!await ports.claimDay(candidate.userId, currentDay)) return 'claimed' as const;
      // The assistant writes the text and its one push when it finishes; if it cannot start, this plain summary goes out.
      if (current.preferences.summaryByAssistant && ports.assistantSummary && await ports.assistantSummary.start(candidate.userId, currentDay, now)) return 'writing' as const;
      return deliverPlainSummary(ports, candidate.userId);
    }).catch((error: unknown) => { failed.push(error); return 'failed' as const; });
    if (outcome === 'sent') sent++;
    if (outcome === 'empty') empty++;
    if (outcome === 'writing') writing++;
  }
  // Failures are thrown after every person had their turn, so the job still reports them (and retries the rest).
  if (failed.length === 1) throw failed[0];
  if (failed.length) throw new AggregateError(failed, `${failed.length} morning summaries failed`);
  // `writing` appears only when the assistant has runs on the way (F-027 A8); the plain tick keeps its shape.
  return writing ? { sent, empty, writing } : { sent, empty };
}

/** The plain #350 summary: one push counting what still waits, from sources the person can read now. Nobody is told about an empty inbox. */
export async function deliverPlainSummary(ports: SummaryPorts, userId: string, line?: string): Promise<'sent' | 'empty'> {
  const rows = await ports.unread(userId, MORNING_SUMMARY_LOOKBACK + 1);
  const readable: NotificationSourceRef[] = [];
  for (const row of rows) {
    try {
      if (!await ports.isMuted(userId, row.source) && readsSource(await ports.authorizer.canRead(userId, row.source), row.source)) readable.push(row.source);
    } catch (error) {
      // F-030 (#712 review P2-4): an item of a locked encrypted workspace cannot be checked now; it is left out of
      // today's count, and the rest still goes out (and the day is claimed).
      if ((error as { code?: unknown }).code !== 'WORKSPACE_LOCKED') throw error;
    }
  }
  if (!readable.length) return 'empty';
  const more = readable.length > MORNING_SUMMARY_LOOKBACK;
  const id = randomUUID();
  // F-030: the row belongs to the newest source of a plain workspace. When every source is in an encrypted one, the row
  // is the plain count (the database allows only that there), never an assistant-written line.
  let anchor = readable[0]!;
  if (ports.sealedWorkspace) {
    const plain = [];
    for (const source of readable) if (!await ports.sealedWorkspace(source.workspaceId)) { plain.push(source); break; }
    if (plain[0]) anchor = plain[0];
    else line = undefined;
  }
  await ports.insertSummary({
    id, userId, source: anchor, sources: readable, url: '/inbox',
    title: line ?? summaryTitle(Math.min(readable.length, MORNING_SUMMARY_LOOKBACK), more), body: 'Your morning summary from Flux',
    // The assistant-written line is AI content (F-029); the plain count is not.
    aiOrigin: line !== undefined,
  });
  for (const subscriptionId of await ports.deliverableSubscriptions(userId)) {
    await ports.enqueuePush({ notificationId: id, subscriptionId, userId });
  }
  return 'sent';
}
