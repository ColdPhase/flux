import { ConflictError } from '../access/errors.js';
import { isTimeZone, type StoredPreferences } from '../notifications/preferences.js';
import { localDay } from '../notifications/summary.js';
import { deliverPlainSummary, MORNING_SUMMARY_LOOKBACK } from '../notifications/summary.js';
import { readsSource } from '../push/notifications.js';
import type { SummaryPorts } from '../notifications/summary.js';
import type { PersonalRunPorts } from '../personal-runs/ports.js';
import { redactSecrets } from '../personal-runs/redaction.js';
import { announce } from '../personal-runs/progress.js';
import type { BackgroundRunSpec, BackgroundStart } from '../personal-runs/service.js';
import { accountKey, backgroundNote, uuidFrom } from './jobs.js';
import type { AssistantJobRepository } from './jobs-ports.js';

// The morning summary written by the assistant (F-027 AST-7 "The morning summary", A8 #408). It rides #350's tick: when the
// person's time comes and they asked their assistant to write it, the tick claims the day as before and starts one silent
// run instead of building the plain text. Flux gives that run the facts itself (the unread Inbox items the person can read,
// never a DM), so the run has nothing to read and changes nothing. When the run ends, its one line goes under the Home
// greeting and the one push carries the same text; if it fails or the plan says no, the plain #350 summary goes out. The
// Inbox never gets an item, and nothing ever falls back to another account.

/** A run that has not ended after this long is stopped and the plain summary goes out. */
export const SUMMARY_WAIT_MINUTES = 10;
const FACT_ITEMS = 8;

export interface SummaryRow { ownerUserId: string; day: string; runId: string | null; state: 'writing' | 'written' | 'plain'; line: string | null; createdAt: Date }

/** Rows for the morning summary written by the assistant; transaction-bound. */
export interface AssistantSummaryRepository {
  /** False when the person already has a row for this day. */
  create(row: { ownerUserId: string; day: string; runId: string }): Promise<boolean>;
  /** Rows still waiting for their run, oldest first. */
  writing(limit: number): Promise<SummaryRow[]>;
  /** One waiting row, locked; null when it was settled meanwhile or another worker holds it. */
  lock(ownerUserId: string, day: string): Promise<SummaryRow | null>;
  settle(ownerUserId: string, day: string, state: 'written' | 'plain', line: string | null, now: Date): Promise<void>;
  today(ownerUserId: string, day: string): Promise<SummaryRow | null>;
  /** The person's first name and the titles of notifications by id. */
  firstName(ownerUserId: string): Promise<string>;
  titles(notificationIds: string[]): Promise<Map<string, string>>;
  /** Projects of the workspace the person may write in and the assistant may read, newest conversation first: where the silent run is anchored. */
  anchors(ownerUserId: string, workspaceId: string, limit: number): Promise<{ projectId: string; conversationId: string }[]>;
}

export interface AssistantSummaryPorts extends PersonalRunPorts {
  jobs: Pick<AssistantJobRepository, 'noteVersion'>;
  summaries: AssistantSummaryRepository;
}

/** The facts the run is given: a greeting and what waits, as plain lines. Data, never instructions. */
export function summaryFacts(firstName: string, hour: number, titles: string[], more: number): string {
  const greeting = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return [
    `Greeting to start with: ${greeting}, ${firstName}.`,
    `Items waiting in the person's inbox (${titles.length + more}), newest first:`,
    ...titles.map((title) => `- ${title}`),
    ...(more ? [`- and ${more} more`] : []),
  ].join('\n');
}

/** One plain line from the run's answer: no markdown, no secrets, at most 200 characters; null when nothing usable. */
export function summaryLine(answer: string | null): string | null {
  const text = redactSecrets((answer ?? '').trim().split('\n').find((line) => line.trim()) ?? '').text
    .replace(/[*_`]+/g, '').replace(/^[#>\-\s]+/, '').replace(/\s+/g, ' ').trim();
  if (!text || text === '(No answer text.)') return null;
  return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
}

/** Starts the assistant's run for `day` inside the claim's transaction. False: the plain summary goes out instead. */
export async function startAssistantSummary(ports: AssistantSummaryPorts, summary: SummaryPorts, startBackground: (ports: PersonalRunPorts, spec: BackgroundRunSpec) => Promise<BackgroundStart>,
  userId: string, day: string, now: Date): Promise<boolean> {
  const enablement = await ports.runs.enablement(userId);
  if (!enablement || enablement.status !== 'active') return false;
  // The note about background use was shown and accepted when the person turned this on (AST-2.1): without it, no run.
  if (backgroundNote(enablement, await ports.jobs.noteVersion(userId, accountKey(enablement))).note !== null) return false;
  // F-029: the run is anchored only in a workspace whose AI is on, and nothing of a workspace whose AI is off is given to it.
  let workspaceId: string | undefined;
  const aiOn = new Map<string, boolean>();
  const allowed = async (id: string) => {
    if (!aiOn.has(id)) aiOn.set(id, (await ports.access.workspaceAi(id, { lock: true })).state === 'allowed');
    return aiOn.get(id)!;
  };
  for (const agent of enablement.agents) if (await allowed(agent.workspaceId)) { workspaceId = agent.workspaceId; break; }
  if (!workspaceId) return false;
  const rows = await summary.unread(userId, MORNING_SUMMARY_LOOKBACK + 1);
  const readable: { id: string }[] = [];
  for (const row of rows) {
    if (!(await allowed(row.source.workspaceId))) continue;
    // Direct messages are never given to a run (AST-9); a muted or unreadable place is not counted.
    if (row.source.type === 'dm' || await summary.isMuted(userId, row.source) || !readsSource(await summary.authorizer.canRead(userId, row.source), row.source)) continue;
    readable.push({ id: row.id });
  }
  if (!readable.length) return false;
  const titles = await ports.summaries.titles(readable.slice(0, FACT_ITEMS).map((row) => row.id));
  const lines = readable.slice(0, FACT_ITEMS).map((row) => redactSecrets((titles.get(row.id) ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)).text).filter(Boolean);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: enablement.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  const prompt = summaryFacts(await ports.summaries.firstName(userId), hour, lines, Math.max(0, readable.length - lines.length));
  // The first project where the person may write and the assistant may read; the run is only anchored there, it reads nothing of it.
  for (const anchor of await ports.summaries.anchors(userId, workspaceId, 5)) {
    const started = await startBackground(ports, {
      ownerUserId: userId, projectId: anchor.projectId, conversationId: anchor.conversationId, kind: 'morning_summary', silent: true, label: 'Morning summary', prompt,
      clientRunId: uuidFrom(`morning-summary:${userId}:${day}`),
    });
    if (started.started) return ports.summaries.create({ ownerUserId: userId, day, runId: started.run.id });
    if (started.outcome === 'failed') return false;
  }
  return false;
}

export interface AssistantSummaryUnitOfWork {
  run<T>(work: (ports: AssistantSummaryPorts, summary: SummaryPorts) => Promise<T>): Promise<T>;
}

/**
 * Closes the summaries whose run ended: the line goes to Home and the one push carries it; anything else sends the plain
 * #350 summary. A run still working after the wait is stopped, and the plain summary goes out.
 */
export async function settleAssistantSummaries(uow: AssistantSummaryUnitOfWork, now: Date = new Date()): Promise<{ written: number; plain: number }> {
  let written = 0; let plain = 0;
  const pending = await uow.run((ports) => ports.summaries.writing(50));
  for (const row of pending) {
    const outcome = await uow.run(async (ports, summary) => {
      const current = await ports.summaries.lock(row.ownerUserId, row.day);
      if (!current) return null;
      const run = current.runId ? await ports.runs.findRun(current.runId, { lock: true }) : null;
      if (run && ['queued', 'reading', 'dispatching'].includes(run.status)) {
        if (now.getTime() - current.createdAt.getTime() <= SUMMARY_WAIT_MINUTES * 60_000) return null;
        const stopped = await ports.runs.updateRun(run.id, { status: 'stopped', stoppedAtStage: run.status === 'queued' ? 'before_read' : 'before_commit', costState: run.status === 'queued' ? 'released' : 'unknown', chargedMicros: 0, completedAt: now });
        await announce(ports, stopped);
      }
      const ended = run ? await ports.runs.findRun(run.id) : null;
      // F-029: no assistant line is written for a run whose workspace has AI off now; the plain summary goes out.
      const aiOn = !!ended && (await ports.access.workspaceAi(ended.workspaceId, { lock: true })).state === 'allowed';
      const line = aiOn && ended && (ended.status === 'completed' || ended.status === 'truncated') ? summaryLine(ended.answerBody) : null;
      if (line) {
        // The one push carries the same text; with nothing left in the inbox there is no notification to hang it on.
        await deliverPlainSummary(summary, current.ownerUserId, line);
        await ports.summaries.settle(current.ownerUserId, current.day, 'written', line, now);
        return 'written' as const;
      }
      await deliverPlainSummary(summary, current.ownerUserId);
      await ports.summaries.settle(current.ownerUserId, current.day, 'plain', null, now);
      return 'plain' as const;
    });
    if (outcome === 'written') written++;
    if (outcome === 'plain') plain++;
  }
  return { written, plain };
}

/** Today's line for the Home greeting, in the person's own day (AST-7: never an Inbox item). */
export async function todaysSummary(ports: Pick<AssistantSummaryPorts, 'summaries'>, userId: string, timeZone: string, now: Date) {
  const day = localDay(now, timeZone);
  const row = await ports.summaries.today(userId, day);
  return row?.state === 'written' ? { line: row.line, day } : { line: null, day: null };
}


export interface MorningSummarySettingPorts {
  runs: Pick<PersonalRunPorts['runs'], 'enablement'>;
  jobs: Pick<AssistantJobRepository, 'noteVersion' | 'acceptNote'>;
  prefs: { lock(userId: string): Promise<StoredPreferences>; save(userId: string, values: StoredPreferences): Promise<void> };
}

/**
 * "Let your assistant write your morning summary" (AST-7): on, it turns the summary itself on (at the person's time, nine by
 * default) and records the note about background use of this account (AST-2.1); off, the plain summary goes on as before.
 */
export async function setMorningSummaryByAssistant(ports: MorningSummarySettingPorts, userId: string, input: { on: boolean; noteVersion?: unknown; timeZone?: unknown }) {
  const stored = await ports.prefs.lock(userId);
  if (input.on) {
    const enablement = await ports.runs.enablement(userId);
    if (!enablement || enablement.status !== 'active') throw new ConflictError('Turn on your assistant first', 'ASSISTANT_NOT_ENABLED');
    const key = accountKey(enablement);
    const note = backgroundNote(enablement, await ports.jobs.noteVersion(userId, key));
    if (note.note !== null) {
      if (input.noteVersion !== note.version) throw new ConflictError('Read the note about running while you\'re away, then turn it on', 'ASSISTANT_BACKGROUND_NOTE_REQUIRED');
      await ports.jobs.acceptNote(userId, key, note.version);
    }
    const zone = typeof input.timeZone === 'string' && stored.timeZone === 'UTC' && isTimeZone(input.timeZone) ? input.timeZone : stored.timeZone;
    await ports.prefs.save(userId, { ...stored, summaryEnabled: true, summaryByAssistant: true, timeZone: zone });
  } else {
    await ports.prefs.save(userId, { ...stored, summaryByAssistant: false });
  }
  return { byAssistant: input.on };
}
