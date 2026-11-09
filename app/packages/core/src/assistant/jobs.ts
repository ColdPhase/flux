import { createHash, randomUUID } from 'node:crypto';
import {
  AI_PROVIDERS, ASSISTANT_BACKGROUND_NOTE_VERSION, ASSISTANT_JOB_LIMITS, type AssistantBackgroundNote, type AssistantJob, type AssistantJobRun,
  type AssistantJobRunTrigger, type AssistantJobSchedule, type CreateAssistantJob, type UpdateAssistantJob,
} from '@flux/contracts';
import { ConflictError, InvalidInputError, NotFoundError, VersionConflictError } from '../access/errors.js';
import { isTimeZone } from '../notifications/preferences.js';
import type { Principal } from '../principal.js';
import type { BackgroundRunSpec, BackgroundStart } from '../personal-runs/service.js';
import type { EnablementRecord, PersonalRunPorts } from '../personal-runs/ports.js';
import { redactSecrets } from '../personal-runs/redaction.js';
import { postToAgentChat } from '../personal-runs/agent-chat.js';
import { isId } from '../work/validation.js';
import type { AssistantJobPorts, AssistantJobUnitOfWork, JobRecord, JobRunRecord } from './jobs-ports.js';
import { chatSchedule, clockIn } from './job-result.js';
import { settleOwnerRuns } from './job-settle.js';
import { nextRuns, previewRuns, scheduleFields, scheduleWords } from './schedule.js';

// An agent's schedules (F-036 AG-9, #858): the owner's own sentences, each run by one of their agents at a time in their time
// zone, in that agent's private conversation. Everything resolves the owner from the signed-in person; nobody else can see,
// change or run a schedule (they get the same 404 as for one that does not exist). Turning one on is the owner's own tap; a
// schedule prepared from a request stays off until then. A run is an ordinary personal run (`kind: 'scheduled'`) started
// through the personal-run use cases, so every consent, standing, access and budget check is the one a request has. There is
// no pause after failures: a failed run says so in the conversation and the next time happens as scheduled (C-14).

const notFound = () => new NotFoundError('Schedule', 'ASSISTANT_JOB_NOT_FOUND');

/** A deterministic UUID, so one firing can only ever start one run. */
export function uuidFrom(text: string): string {
  const bytes = createHash('sha256').update(text).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The row's name from the sentence: its first words. */
export function titleFromText(text: string): string {
  const line = text.trim().split('\n')[0]!.replace(/\s+/g, ' ').replace(/[.!?:;,\s]+$/, '');
  if (line.length <= ASSISTANT_JOB_LIMITS.title) return line || 'Schedule';
  const cut = line.slice(0, ASSISTANT_JOB_LIMITS.title - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

interface Normalized { title: string; text: string; schedule: AssistantJobSchedule; timeZone: string }

/** The text guard (AST-7 "Text guard"): a token-shaped string is refused, so no secret is stored. */
export function guardText(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new InvalidInputError('Say what it should do', 'ASSISTANT_JOB_TEXT_REQUIRED');
  if (text.length > ASSISTANT_JOB_LIMITS.text) throw new InvalidInputError(`Keep it under ${ASSISTANT_JOB_LIMITS.text} characters`, 'ASSISTANT_JOB_TEXT_TOO_LONG');
  if (redactSecrets(text).changed) throw new InvalidInputError('That looks like a key or a token. Take it out and say what to do instead.', 'ASSISTANT_JOB_SECRET');
  return text;
}

function normalizeSchedule(schedule: unknown, now: Date): AssistantJobSchedule {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) throw new InvalidInputError('Choose when it should run', 'ASSISTANT_JOB_INVALID_SCHEDULE');
  const value = schedule as Record<string, unknown>;
  const allowed: Record<string, string[]> = { daily: ['kind', 'at'], weekdays: ['kind', 'at'], weekly: ['kind', 'at', 'weekday'], hourly: ['kind', 'from', 'to'], cron: ['kind', 'cron'], once: ['kind', 'at'] };
  const keys = typeof value.kind === 'string' ? allowed[value.kind] : undefined;
  if (!keys || Object.keys(value).some((key) => !keys.includes(key))) throw new InvalidInputError('Choose when it should run', 'ASSISTANT_JOB_INVALID_SCHEDULE');
  const normalized = value as unknown as AssistantJobSchedule;
  if (normalized.kind === 'once') {
    const at = new Date(normalized.at);
    if (typeof normalized.at !== 'string' || Number.isNaN(at.getTime())) throw new InvalidInputError('Choose a time', 'ASSISTANT_JOB_INVALID_SCHEDULE');
    if (at.getTime() <= now.getTime()) throw new InvalidInputError('That time has passed', 'ASSISTANT_JOB_PAST');
    return { kind: 'once', at: at.toISOString() };
  }
  scheduleFields(normalized);
  return normalized.kind === 'cron' ? { kind: 'cron', cron: normalized.cron.trim().replace(/\s+/g, ' ') } : normalized;
}

function normalize(input: { title?: unknown; text?: unknown; schedule?: unknown; timeZone?: unknown }, now: Date): Normalized {
  const text = guardText(input.text);
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : titleFromText(text);
  if (title.length > ASSISTANT_JOB_LIMITS.title) throw new InvalidInputError(`Keep the name under ${ASSISTANT_JOB_LIMITS.title} characters`, 'ASSISTANT_JOB_TITLE_TOO_LONG');
  if (redactSecrets(title).changed) throw new InvalidInputError('That looks like a key or a token. Take it out and say what to do instead.', 'ASSISTANT_JOB_SECRET');
  if (!isTimeZone(input.timeZone)) throw new InvalidInputError('Choose a time zone', 'INVALID_TIME_ZONE');
  return { title, text, schedule: normalizeSchedule(input.schedule, now), timeZone: input.timeZone };
}

/** The account a note about background use is shown for: the signed-in CLI, or the API key connection. */
export function accountKey(enablement: Pick<EnablementRecord, 'engine' | 'provider' | 'connectionId'>): string {
  return enablement.engine === 'runtime' ? `runtime:${enablement.provider === 'openai' ? 'codex' : 'claude_code'}` : `server:${enablement.connectionId ?? 'none'}`;
}

/** What the sheet shows before *Turn on* (AST-2 "The first time … this note shows once per account"). */
export function backgroundNote(enablement: Pick<EnablementRecord, 'engine' | 'provider'>, accepted: string | null): AssistantBackgroundNote {
  if (enablement.engine === 'runtime') {
    const codex = enablement.provider === 'openai';
    const plan = codex ? 'ChatGPT plan' : 'Claude plan';
    return {
      version: ASSISTANT_BACKGROUND_NOTE_VERSION, meta: `Runs on your ${plan}`, credits: null,
      note: accepted === ASSISTANT_BACKGROUND_NOTE_VERSION ? null
        : `Runs on your ${plan} while you're away. ${codex ? 'OpenAI' : 'Anthropic'} may limit this use without notice. If your plan says no, it skips that time and tells you.`,
    };
  }
  return { version: ASSISTANT_BACKGROUND_NOTE_VERSION, meta: `Runs on your ${AI_PROVIDERS[enablement.provider].label} API key`, credits: null, note: null };
}

export interface JobDeps {
  uow: AssistantJobUnitOfWork;
  startBackground: (ports: PersonalRunPorts, spec: BackgroundRunSpec) => Promise<BackgroundStart>;
  now?: () => Date;
}

/**
 * One firing: its history row first (what makes two workers start exactly one run), then the caps, then the run through the
 * personal-run use cases. Everything commits with the caller's transaction. Null when another worker already fired it.
 */
export async function fireJob(ports: AssistantJobPorts, startBackground: JobDeps['startBackground'], job: JobRecord, firedAt: Date, by: AssistantJobRunTrigger,
  options: { late?: boolean } = {}): Promise<JobRunRecord | null> {
  // What the owner was last told about this schedule, before this firing adds its row: a failure that repeats is said once (below).
  const previous = (await ports.jobs.lastRuns([job.id])).get(job.id) ?? null;
  const row = await ports.jobs.insertRun({ id: randomUUID(), jobId: job.id, ownerUserId: job.ownerUserId, firedAt, firedBy: by, state: 'running', resultLine: '' });
  if (!row) {
    // Another worker fired this very time, or an earlier run of the schedule is still working.
    if (await ports.jobs.runExists(job.id, firedAt, by)) return null;
    const skipped = await ports.jobs.insertRun({ id: randomUUID(), jobId: job.id, ownerUserId: job.ownerUserId, firedAt, firedBy: by, state: 'skipped',
      resultLine: 'Skipped: the last run is still working', finishedAt: new Date() });
    await ports.jobs.trimRuns(job.id, ASSISTANT_JOB_LIMITS.history);
    return skipped;
  }
  /** A firing that ends without a run (C-53): its history line, and the same words in the agent's chat, so the owner is told (not only the schedule's page). */
  const end = async (record: JobRunRecord, state: 'skipped' | 'failed', line: string) => {
    const ended = await ports.jobs.updateRun(record.id, { state, resultLine: line, finishedAt: new Date() });
    // The same words twice in a row say nothing new: a schedule that cannot start every minute is not a chat of the same line.
    if (!(previous && previous.state === state && previous.resultLine === line && previous.runId === null))
      await postToAgentChat(ports, { agentId: job.agentId, runId: null, key: `job:${record.id}`, body: line, schedule: chatSchedule(job, true) });
    await ports.jobs.trimRuns(job.id, ASSISTANT_JOB_LIMITS.history);
    return ended;
  };
  if (options.late) return end(row, 'skipped', `Skipped: Flux was off at ${clockIn(firedAt, job.timeZone)}`);
  await ports.runs.enablement(job.ownerUserId, { lock: true, agentId: job.agentId });
  const started = await startBackground(ports, {
    ownerUserId: job.ownerUserId, agentId: job.agentId, kind: 'scheduled', prompt: job.text,
    clientRunId: uuidFrom(`assistant-job:${job.id}:${firedAt.toISOString()}:${by}`), label: job.title,
  });
  if (!started.started) return end(row, started.outcome, started.line);
  return ports.jobs.updateRun(row.id, { runId: started.run.id });
}

const ownerOf = (principal: Principal) => {
  if (principal.kind !== 'human') throw notFound();
  return principal.id;
};

async function view(ports: AssistantJobPorts, records: JobRecord[], at: Date): Promise<AssistantJob[]> {
  const ids = records.map((record) => record.id);
  const last = await ports.jobs.lastRuns(ids);
  const running = await ports.jobs.running(ids);
  return records.map((record) => {
    const lastRun = last.get(record.id);
    const finished = lastRun && lastRun.state !== 'running' ? lastRun : null;
    return {
      id: record.id, workspaceId: record.workspaceId, agentId: record.agentId, title: record.title, text: record.text,
      schedule: record.schedule, timeZone: record.timeZone, words: scheduleWords(record.schedule, record.timeZone),
      enabled: record.enabled, prepared: record.prepared, preparedRunId: record.preparedRunId,
      next: record.enabled ? previewRuns(record.schedule, record.timeZone, at, 3) : [],
      last: finished ? { at: finished.firedAt.toISOString(), state: finished.state, line: finished.resultLine } : null,
      running: running.has(record.id), version: record.version, createdAt: record.createdAt.toISOString(), updatedAt: record.updatedAt.toISOString(),
    };
  });
}
const viewOne = async (ports: AssistantJobPorts, id: string, at: Date) => (await view(ports, [(await ports.jobs.find(id))!], at))[0]!;

/** The owner's own agent and its setup: a schedule belongs to one of the owner's agents, and to no one else's. */
async function agentOf(ports: AssistantJobPorts, principal: Principal, agentId: string) {
  const owner = ownerOf(principal);
  const enablement = isId(agentId) ? await ports.runs.enablement(owner, { lock: false, agentId: agentId.toLowerCase() }) : null;
  if (!enablement) throw notFound();
  return enablement;
}

/** Turning something on records the owner's Turn on with the note's version, once per account (AST-2.1). */
async function acceptNote(ports: AssistantJobPorts, ownerUserId: string, enablement: EnablementRecord, noteVersion: unknown) {
  const key = accountKey(enablement);
  const accepted = await ports.jobs.noteVersion(ownerUserId, key);
  const note = backgroundNote(enablement, accepted);
  if (note.note === null) return;
  if (noteVersion !== note.version) throw new ConflictError('Read the note about running while you\'re away, then turn it on', 'ASSISTANT_BACKGROUND_NOTE_REQUIRED');
  await ports.jobs.acceptNote(ownerUserId, key, note.version);
}

function firstRun(schedule: AssistantJobSchedule, timeZone: string, at: Date): Date | null {
  return nextRuns(schedule, timeZone, at, 1)[0] ?? null;
}

/**
 * Creates a schedule. `enabled` is the owner's own Turn on; a schedule prepared from a request is created off and marked
 * `prepared` by `prepare` (a request can never turn one on).
 */
async function createIn(ports: AssistantJobPorts, principal: Principal, agentId: string, input: CreateAssistantJob, mode: 'owner' | 'prepared', preparedRunId: string | null, at: Date): Promise<AssistantJob> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new InvalidInputError('Say what it should do and when');
  const fields = normalize(input, at);
  const enablement = await agentOf(ports, principal, agentId);
  if (await ports.jobs.countActive(principal.id) >= ASSISTANT_JOB_LIMITS.perOwner) throw new ConflictError(`You can keep ${ASSISTANT_JOB_LIMITS.perOwner} schedules. Delete one first.`, 'ASSISTANT_JOB_LIMIT');
  const enabled = mode === 'owner' && input.enabled !== false;
  if (enabled) await acceptNote(ports, principal.id, enablement, input.noteVersion);
  const record = await ports.jobs.insert({
    id: randomUUID(), workspaceId: enablement.workspaceId, ownerUserId: principal.id, agentId: enablement.agentId, ...fields,
    enabled, prepared: mode === 'prepared', preparedRunId, nextRunAt: enabled ? firstRun(fields.schedule, fields.timeZone, at) : null,
  });
  return viewOne(ports, record.id, at);
}

async function ownJob(ports: AssistantJobPorts, principal: Principal, agentId: string, jobId: string, lock = false) {
  const owner = ownerOf(principal);
  // A guest of the company finds none of their schedules (they are kept until the person is a member again, #1059, C-50).
  const record = isId(jobId) ? await ports.jobs.find(jobId.toLowerCase(), { lock, visibleToOwner: true }) : null;
  if (!record || record.ownerUserId !== owner || !isId(agentId) || record.agentId !== agentId.toLowerCase()) throw notFound();
  return record;
}
const live = <T extends JobRecord>(record: T): T => {
  if (record.deletedAt) throw notFound();
  return record;
};


/** Prepares a schedule from an owner's request: off, marked as prepared, waiting for the owner's own tap (AST-7 "Set up by asking"). */
export function prepareSchedule(ports: AssistantJobPorts, ownerUserId: string, agentId: string, input: CreateAssistantJob, runId: string, now: Date = new Date()): Promise<AssistantJob> {
  return createIn(ports, { kind: 'human', id: ownerUserId }, agentId, input, 'prepared', runId, now);
}

export function createAssistantJobs({ uow, startBackground, now: clock = () => new Date() }: JobDeps) {
  return {
    async list(principal: Principal, agentId: string): Promise<AssistantJob[]> {
      ownerOf(principal);
      return uow.run(async (ports) => {
        const at = clock();
        await agentOf(ports, principal, agentId);
        await settleOwnerRuns(ports, principal.id, at);
        return view(ports, await ports.jobs.list(principal.id, agentId.toLowerCase()), at);
      });
    },

    create: (principal: Principal, agentId: string, input: CreateAssistantJob) => {
      ownerOf(principal);
      return uow.run((ports) => createIn(ports, principal, agentId, input, 'owner', null, clock()));
    },

    async update(principal: Principal, agentId: string, jobId: string, input: UpdateAssistantJob): Promise<AssistantJob> {
      ownerOf(principal);
      return uow.run(async (ports) => {
        const at = clock();
        const record = live(await ownJob(ports, principal, agentId, jobId, true));
        if (!Number.isInteger(input?.expectedVersion) || input.expectedVersion < 1) throw new InvalidInputError('Supply the current version', 'INVALID_PRECONDITION');
        if (input.expectedVersion !== record.version) throw new VersionConflictError(record.version, await viewOne(ports, record.id, at));
        const merged = normalize({
          title: input.title ?? record.title, text: input.text ?? record.text,
          schedule: input.schedule ?? record.schedule, timeZone: input.timeZone ?? record.timeZone,
        }, input.schedule === undefined && record.schedule.kind === 'once' ? new Date(0) : at);
        const enablement = await agentOf(ports, principal, agentId);
        const enabled = input.enabled ?? record.enabled;
        if (enabled && !record.enabled) await acceptNote(ports, principal.id, enablement, input.noteVersion);
        const changedTime = input.schedule !== undefined || input.timeZone !== undefined || (enabled && !record.enabled);
        const nextRunAt = !enabled ? null : changedTime || !record.nextRunAt ? firstRun(merged.schedule, merged.timeZone, at) : record.nextRunAt;
        // Change edits the wording only: the web addresses a run may read were fixed when the schedule was prepared, from its owner's own words (C-30).
        const updated = await ports.jobs.update(record.id, { ...merged, enabled, nextRunAt, prepared: enabled ? false : record.prepared });
        return viewOne(ports, updated.id, at);
      });
    },

    /** Delete with Undo (F-026 principle 6): the schedule stops now and can be brought back for a day. */
    async remove(principal: Principal, agentId: string, jobId: string): Promise<AssistantJob> {
      ownerOf(principal);
      return uow.run(async (ports) => {
        const at = clock();
        const record = live(await ownJob(ports, principal, agentId, jobId, true));
        const updated = await ports.jobs.update(record.id, { deletedAt: at, nextRunAt: null });
        return (await view(ports, [updated], at))[0]!;
      });
    },

    async restore(principal: Principal, agentId: string, jobId: string): Promise<AssistantJob> {
      ownerOf(principal);
      return uow.run(async (ports) => {
        const at = clock();
        const record = await ownJob(ports, principal, agentId, jobId, true);
        if (!record.deletedAt) return viewOne(ports, record.id, at);
        if (at.getTime() - record.deletedAt.getTime() > ASSISTANT_JOB_LIMITS.undoHours * 3600_000) throw notFound();
        const updated = await ports.jobs.update(record.id, { deletedAt: null, nextRunAt: record.enabled ? firstRun(record.schedule, record.timeZone, at) : null });
        return viewOne(ports, updated.id, at);
      });
    },

    /** Run now: the same firing as the schedule's own, started by the owner's tap. One run at a time per schedule. */
    async runNow(principal: Principal, agentId: string, jobId: string): Promise<{ job: AssistantJob; run: AssistantJobRun }> {
      ownerOf(principal);
      return uow.run(async (ports) => {
        const at = clock();
        const record = live(await ownJob(ports, principal, agentId, jobId, true));
        if ((await ports.jobs.running([record.id])).has(record.id)) throw new ConflictError('It is working on this already', 'ASSISTANT_JOB_RUNNING');
        const run = await fireJob(ports, startBackground, record, at, 'now');
        if (!run) throw new ConflictError('It is working on this already', 'ASSISTANT_JOB_RUNNING');
        await ports.jobs.update(record.id, { lastRunAt: at });
        return { job: await viewOne(ports, record.id, at), run: runView(run) };
      });
    },

    async history(principal: Principal, agentId: string, jobId: string): Promise<AssistantJobRun[]> {
      ownerOf(principal);
      return uow.run(async (ports) => {
        const record = live(await ownJob(ports, principal, agentId, jobId));
        return (await ports.jobs.runsOf(record.id, ASSISTANT_JOB_LIMITS.history)).map(runView);
      });
    },

    /** The note about background use of this agent's account, if the owner has not seen it (AST-2.1). */
    async note(principal: Principal, agentId: string): Promise<AssistantBackgroundNote> {
      ownerOf(principal);
      return uow.run(async (ports) => {
        const enablement = await agentOf(ports, principal, agentId);
        return backgroundNote(enablement, await ports.jobs.noteVersion(principal.id, accountKey(enablement)));
      });
    },
  };
}
export type AssistantJobUseCases = ReturnType<typeof createAssistantJobs>;

export function runView(run: JobRunRecord): AssistantJobRun {
  return { id: run.id, jobId: run.jobId, firedAt: run.firedAt.toISOString(), firedBy: run.firedBy, state: run.state, line: run.resultLine || (run.state === 'running' ? 'Working…' : ''),
    runId: run.runId, finishedAt: run.finishedAt?.toISOString() ?? null };
}

