import type { AssistantJobSchedule } from '@flux/contracts';
import type { RunRecord } from '../personal-runs/ports.js';
import { scheduleWords, shortClock } from './schedule.js';

// The plain words of a schedule's history line (F-027 AST-7 "Output", "Failures", "Missed runs"): pure.

/** A firing on an API key whose daily budget is used (#854): the key's one budget is the only limit. */
export const budgetLine = 'Skipped: not enough left of your API key\'s daily budget';

/** What a schedule's line in the agent's chat says about it: its name, when it runs, and `failed` when it has no result to show (it failed, or was skipped). */
export const chatSchedule = (job: { title: string; schedule: AssistantJobSchedule; timeZone: string }, failed: boolean) =>
  ({ title: job.title, words: scheduleWords(job.schedule, job.timeZone), failed });

/** The local time of a moment in a zone, as "9:00" (the words of "Skipped: Flux was off at 9:00"). */
export function clockIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((value) => value.type === type)!.value);
  return shortClock(part('hour') * 60 + part('minute'));
}

/** The words of a finished run for the schedule's history (AST-7 "Output", "Failures", "Missed runs"). A schedule reads and reports, so a run has no changes to count. */
export function resultOf(run: RunRecord, timeZone: string, now: Date): { state: 'done' | 'skipped' | 'failed'; line: string } {
  const first = (run.answerBody ?? '').trim().split('\n')[0]!.replace(/\s+/g, ' ').slice(0, 120);
  switch (run.status) {
    case 'completed': case 'truncated': return { state: 'done', line: nothingToReport(run.answerBody) ? 'Done: nothing to report' : `Done: ${first}` };
    case 'cap_reached':
      // A run that never started at the key's budget is skipped; one that ran and met a bound is done as far as it got.
      return run.dispatchedAt ? { state: 'done', line: 'Stopped at the limit' } : { state: 'skipped', line: budgetLine };
    case 'stopped': return { state: 'skipped', line: 'Stopped' };
    case 'unavailable':
      if (run.endReason === 'plan_limit') {
        const until = run.planLimitResetsAt && run.planLimitResetsAt.getTime() > now.getTime() ? ` until ${clockIn(run.planLimitResetsAt, timeZone)}` : '';
        return { state: 'skipped', line: `Skipped: ${run.provider === 'openai' ? 'ChatGPT' : 'Claude'} limit reached${until}` };
      }
      if (run.endReason === 'sign_in_again' || run.stoppedAtStage === 'before_dispatch' && run.engine === 'runtime' && !run.dispatchedAt && !run.endReason)
        return { state: 'failed', line: `Sign in to ${run.provider === 'openai' ? 'ChatGPT' : 'Claude'} again` };
      return { state: 'failed', line: 'Couldn\'t run' };
    case 'provider_failed':
      if (run.endReason === 'credits') return { state: 'skipped', line: 'Skipped: API credits used up' };
      return { state: 'failed', line: run.endReason === 'refused' ? 'Refused this request' : 'Stopped answering' };
    case 'input_too_large': return { state: 'failed', line: 'Too much to read at once' };
    case 'denied': return { state: 'skipped', line: 'Skipped: your agent could not do this any more' };
    case 'paused': case 'revoked': return { state: 'skipped', line: 'Skipped: your assistant was turned off' };
    default: return { state: 'failed', line: 'Couldn\'t run' };
  }
}

// `\s` is part of `\W`, so `\W*\s*` would backtrack in a quadratic number of ways on a long answer: one run of non-word characters is enough.
const NOTHING = /^\W*(done\W*)?nothing (to report|new|to change)\W*$/i;
/** "Nothing to report", or no words at all: a schedule never posts that (AST-7.11). */
export function nothingToReport(answer: string | null): boolean {
  const text = (answer ?? '').trim();
  return !text || text === '(No answer text.)' || NOTHING.test(text);
}
