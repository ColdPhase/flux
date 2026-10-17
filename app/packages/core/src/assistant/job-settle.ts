import { ASSISTANT_JOB_LIMITS } from '@flux/contracts';
import { announce } from '../personal-runs/progress.js';
import type { RunRecord } from '../personal-runs/ports.js';
import { clockIn, nothingToChange, resultOf } from './job-result.js';
import type { AssistantJobPorts } from './jobs-ports.js';

// Closing a schedule's firing once its run has ended (F-027 AST-7, A8 #408): its words, the failure streak, the pause after
// three failures and the Inbox. Shared by the worker's tick and by the owner's own list (so the screen is current at once).

const IN_FLIGHT = new Set<RunRecord['status']>(['queued', 'reading', 'dispatching']);

/** Closes the firing of a run that ended: its words, the streak, the pause after three failures, the Inbox. */
export async function settleOne(ports: AssistantJobPorts, jobRunId: string, now: Date): Promise<boolean> {
  const firing = await ports.jobs.findRun(jobRunId, { lock: true });
  if (!firing || firing.state !== 'running') return false;
  const job = await ports.jobs.find(firing.jobId, { lock: true });
  const finish = (state: 'done' | 'skipped' | 'failed', line: string, needsYou = false) =>
    ports.jobs.updateRun(firing.id, { state, resultLine: line, needsYou, finishedAt: now });
  if (!job) return false;
  const run = firing.runId ? await ports.runs.findRun(firing.runId, { lock: true }) : null;
  if (!run) {
    await finish('failed', 'Couldn\'t run');
    return true;
  }
  if (IN_FLIGHT.has(run.status)) {
    // Still waiting for the owner's lane after the missed-run window: skipped, never run late.
    if (run.status !== 'queued' || now.getTime() - firing.firedAt.getTime() <= ASSISTANT_JOB_LIMITS.missedMinutes * 60_000) return false;
    const stopped = await ports.runs.updateRun(run.id, { status: 'stopped', stoppedAtStage: 'before_read', costState: 'released', chargedMicros: 0, completedAt: now });
    await announce(ports, stopped);
    await finish('skipped', `Skipped: your assistant was busy at ${clockIn(firing.firedAt, job.timeZone)}`);
    return true;
  }
  const facts = await ports.jobs.settledFacts(run.id);
  const result = resultOf(run, { applied: facts.appliedChanges, waiting: facts.waitingChanges }, job.timeZone, now);
  // When something needs the owner, one Inbox item; otherwise the result stays in Recent (AST-7 "Output").
  const needsYou = facts.waitingChanges > 0 && await ports.jobs.promoteWaiting(run.id, now) > 0;
  // A schedule that posts in a conversation never posts "Done: nothing to change" (AST-7.11).
  if (result.state === 'done' && !run.silent && nothingToChange(run.answerBody) && !facts.appliedChanges && !facts.waitingChanges)
    await ports.runs.updateRun(run.id, { silent: true });
  await finish(result.state, result.line, needsYou);
  const streak = result.state === 'failed' ? job.failureStreak + 1 : result.state === 'done' ? 0 : job.failureStreak;
  const pause = result.state === 'failed' && streak >= ASSISTANT_JOB_LIMITS.failuresToPause && job.enabled;
  await ports.jobs.update(job.id, { failureStreak: streak, ...(pause ? { enabled: false, nextRunAt: null, pausedReason: 'failures' as const } : {}) });
  if (pause) {
    const reason = /^Sign in/.test(result.line) ? `${result.line[0]!.toLowerCase()}${result.line.slice(1)}` : 'it failed three times in a row';
    await ports.inbox.tell(job.ownerUserId, job.projectId, `Paused ${job.title}: ${reason}`.slice(0, 200), 'Your assistant paused this schedule. Turn it on again when it is fixed.', '/settings/assistant');
  }
  await ports.jobs.trimRuns(job.id, ASSISTANT_JOB_LIMITS.history);
  return true;
}

/** Settles the owner's own open firings (the screen asks, so "Last: Done" is there without waiting for the next tick). */
export async function settleOwnerRuns(ports: AssistantJobPorts, ownerUserId: string, now: Date): Promise<number> {
  let settled = 0;
  for (const firing of await ports.jobs.openRuns(20, ownerUserId)) if (await settleOne(ports, firing.id, now)) settled++;
  return settled;
}
