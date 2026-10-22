import { ASSISTANT_JOB_LIMITS } from '@flux/contracts';
import { settleOne } from './job-settle.js';
import { fireJob, type JobDeps } from './jobs.js';
import { nextRuns } from './schedule.js';

// The per-minute tick of "On a schedule" (F-027 AST-7 "Engine", A8 #408). Every minute one worker runs it (pg-boss gives the
// scheduled job a singleton slot per minute), and it is also safe if two do: a schedule is picked with FOR UPDATE SKIP LOCKED,
// the firing's history row is unique per (schedule, time), and the run's client id is derived from the same two, so a second
// worker finds nothing to do or loses the insert. Nothing is ever caught up: a time that could not start within ten minutes is
// recorded as skipped and the schedule moves on to its next time after now.

export const ASSISTANT_TICK_JOB = 'assistant.background.tick.v1';
/** One active tick at a time across workers (pg-boss `singleton`); never retried, a lost tick is simply the next minute's. */
export const ASSISTANT_TICK_RETRY = { retryLimit: 0, expireInSeconds: 300, heartbeatSeconds: 30, deleteAfterSeconds: 24 * 3600 };
export const ASSISTANT_TICK_QUEUE = { policy: 'singleton' as const, ...ASSISTANT_TICK_RETRY };

const BATCH = 50;

export interface TickDeps extends Pick<JobDeps, 'uow' | 'startBackground'> {
  log?: (line: Record<string, unknown>) => void;
}
export interface TickResult { fired: number; settled: number; purged: number }

/** Fires every schedule that is due at `now`, one transaction each. */
async function fireDue(deps: TickDeps, now: Date): Promise<number> {
  let fired = 0;
  for (let count = 0; count < BATCH; count++) {
    const id = await deps.uow.run(async (ports) => {
      const job = await ports.jobs.lockDue(now);
      if (!job) return null;
      const firedAt = job.nextRunAt!;
      const late = now.getTime() - firedAt.getTime() > ASSISTANT_JOB_LIMITS.missedMinutes * 60_000;
      const once = job.schedule.kind === 'once';
      // The next time after now, never the next after the missed one: there is no backlog (AST-7 "Missed runs").
      const next = once ? null : nextRuns(job.schedule, job.timeZone, now, 1)[0] ?? null;
      // F-029: while AI is off in the job's workspace nothing fires and no history row is written; the schedule moves on
      // to its next time after now, so a missed time never runs later (AST-7).
      const aiOn = (await ports.access.workspaceAi(job.workspaceId, { lock: true })).state === 'allowed';
      if (aiOn) await fireJob(ports, deps.startBackground, job, firedAt, 'schedule', { late });
      // Skipped while AI is off: no "Last run" either, only the next time.
      await ports.jobs.update(job.id, { ...(aiOn ? { lastRunAt: firedAt } : {}), nextRunAt: next, ...(once || !next ? { enabled: false } : {}) });
      return job.id;
    });
    if (!id) break;
    fired++;
  }
  return fired;
}

/** One tick: fire what is due, close what ended, and let deleted schedules go after their Undo time. */
export async function assistantTick(deps: TickDeps, now: Date = new Date()): Promise<TickResult> {
  const fired = await fireDue(deps, now);
  let settled = 0;
  const open = await deps.uow.run((ports) => ports.jobs.openRuns(BATCH));
  for (const firing of open) if (await deps.uow.run((ports) => settleOne(ports, firing.id, now))) settled++;
  const purged = await deps.uow.run((ports) => ports.jobs.purgeDeleted(new Date(now.getTime() - ASSISTANT_JOB_LIMITS.undoHours * 3600_000)));
  const result = { fired, settled, purged };
  if (fired || settled || purged) deps.log?.({ job: ASSISTANT_TICK_JOB, ...result });
  return result;
}
