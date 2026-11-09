import { ASSISTANT_JOB_LIMITS } from '@flux/contracts';
import { announce } from '../personal-runs/progress.js';
import type { RunRecord } from '../personal-runs/ports.js';
import { postToAgentChat } from '../personal-runs/agent-chat.js';
import { chatSchedule, clockIn, nothingToReport, resultOf } from './job-result.js';
import type { AssistantJobPorts } from './jobs-ports.js';

// Closing a schedule's firing once its run has ended (F-036 AG-9, #858): its words in the history, and the result in the agent's
// private conversation. A failed run is told there like any other and the schedule goes on at its next time: no streak, no pause
// (C-14). Shared by the worker's tick and by the owner's own list (so the screen is current at once).

const IN_FLIGHT = new Set<RunRecord['status']>(['queued', 'reading', 'dispatching']);

/**
 * What a firing leaves in the agent's conversation: the answer of a run that ended well, what happened otherwise. Nothing to report says nothing.
 * The words are the result alone: the schedule's name and times are the line's own (`chatSchedule`).
 */
function chatBody(state: 'done' | 'skipped' | 'failed', line: string, answer: string | null): string | null {
  if (state === 'done') return nothingToReport(answer) ? null : (answer ?? '').trim();
  return line;
}

/** Whether a firing whose run has not ended has to wait: it is working, or queued within the missed-run window. */
const waiting = (run: RunRecord, firedAt: Date, now: Date) =>
  IN_FLIGHT.has(run.status) && (run.status !== 'queued' || now.getTime() - firedAt.getTime() <= ASSISTANT_JOB_LIMITS.missedMinutes * 60_000);

/** Closes the firing of a run that ended: its words in the history and in the agent's conversation. */
export async function settleOne(ports: AssistantJobPorts, jobRunId: string, now: Date): Promise<boolean> {
  // A plain read first: the owner's open chat asks again while a run works, and a run that is still going has nothing to close, so no row is locked for it.
  const seen = await ports.jobs.findRun(jobRunId);
  if (!seen || seen.state !== 'running') return false;
  const working = seen.runId ? await ports.runs.findRun(seen.runId) : null;
  if (working && waiting(working, seen.firedAt, now)) return false;
  // The schedule's row first, then the firing's: the order of agent deletion (its schedule rows, then the firings that go with them) and of a firing,
  // so two transactions that need both never wait on each other.
  const job = await ports.jobs.find(seen.jobId, { lock: true });
  const firing = await ports.jobs.findRun(jobRunId, { lock: true });
  if (!firing || firing.state !== 'running') return false;
  const finish = (state: 'done' | 'skipped' | 'failed', line: string) => ports.jobs.updateRun(firing.id, { state, resultLine: line, finishedAt: now });
  if (!job) return false;
  const run = firing.runId ? await ports.runs.findRun(firing.runId, { lock: true }) : null;
  if (!run) {
    await finish('failed', 'Couldn\'t run');
    return true;
  }
  if (IN_FLIGHT.has(run.status)) {
    // Still waiting for the owner's lane after the missed-run window: skipped, never run late.
    if (waiting(run, firing.firedAt, now)) return false;
    const stopped = await ports.runs.updateRun(run.id, { status: 'stopped', stoppedAtStage: 'before_read', costState: 'released', chargedMicros: 0, completedAt: now });
    await announce(ports, stopped);
    await finish('skipped', `Skipped: your assistant was busy at ${clockIn(firing.firedAt, job.timeZone)}`);
    return true;
  }
  const result = resultOf(run, job.timeZone, now);
  await finish(result.state, result.line);
  const body = chatBody(result.state, result.line, run.answerBody);
  if (body) await postToAgentChat(ports, { agentId: job.agentId, runId: run.id, key: `job:${firing.id}`, body, schedule: chatSchedule(job, result.state !== 'done') });
  await ports.jobs.trimRuns(job.id, ASSISTANT_JOB_LIMITS.history);
  return true;
}

/** Settles the owner's own open firings (the screen asks, so "Last: Done" is there without waiting for the next tick). */
export async function settleOwnerRuns(ports: AssistantJobPorts, ownerUserId: string, now: Date): Promise<number> {
  let settled = 0;
  for (const firing of await ports.jobs.openRuns(20, ownerUserId)) if (await settleOne(ports, firing.id, now)) settled++;
  return settled;
}
