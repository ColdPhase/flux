import type { RunRecord } from '../personal-runs/ports.js';
import { shortClock } from './schedule.js';

// The plain words of a schedule's history line (F-027 AST-7 "Output", "Failures", "Missed runs"): pure.

/** Why a firing could not be set up before a run: the plain line of its history. */
export const limitLine = 'Skipped: daily limit';

/** The local time of a moment in a zone, as "9:00" (the words of "Skipped: Flux was off at 9:00"). */
export function clockIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((value) => value.type === type)!.value);
  return shortClock(part('hour') * 60 + part('minute'));
}

/** The words of a finished run for the schedule's history (AST-7 "Output", "Failures", "Missed runs"). */
export function resultOf(run: RunRecord, facts: { applied: number; waiting: number }, timeZone: string, now: Date):
  { state: 'done' | 'skipped' | 'failed'; line: string } {
  const changes = (count: number) => `${count} change${count === 1 ? '' : 's'}`;
  const first = (run.answerBody ?? '').trim().split('\n')[0]!.replace(/\s+/g, ' ').slice(0, 120);
  switch (run.status) {
    case 'completed': case 'truncated': {
      if (facts.waiting && !facts.applied) return { state: 'done', line: `Done, ${facts.waiting} thing${facts.waiting === 1 ? '' : 's'} need${facts.waiting === 1 ? 's' : ''} you` };
      if (facts.applied) return { state: 'done', line: `Done: ${changes(facts.applied)}${facts.waiting ? `, ${facts.waiting} need${facts.waiting === 1 ? 's' : ''} you` : ''}` };
      return { state: 'done', line: nothingToChange(run.answerBody) ? 'Done: nothing to change' : `Done: ${first}` };
    }
    case 'cap_reached':
      // A request that never started past its limit is skipped; one that ran and hit a limit kept its changes.
      return run.dispatchedAt ? { state: 'done', line: facts.applied ? `Stopped at the limit after ${changes(facts.applied)}` : 'Stopped at the limit' } : { state: 'skipped', line: limitLine };
    case 'stopped': return { state: 'skipped', line: facts.applied ? `Stopped after ${changes(facts.applied)}` : 'Stopped' };
    case 'unavailable':
      if (run.endReason === 'plan_limit') {
        const until = run.planLimitResetsAt && run.planLimitResetsAt.getTime() > now.getTime() ? ` until ${clockIn(run.planLimitResetsAt, timeZone)}` : '';
        return { state: 'skipped', line: `Skipped: plan limit${until}` };
      }
      if (run.endReason === 'sign_in_again' || run.stoppedAtStage === 'before_dispatch' && run.engine === 'runtime' && !run.dispatchedAt && !run.endReason)
        return { state: 'failed', line: `Sign in to ${run.provider === 'openai' ? 'ChatGPT' : 'Claude'} again` };
      return { state: 'failed', line: 'Couldn\'t run' };
    case 'provider_failed': return { state: 'failed', line: run.endReason === 'refused' ? 'Refused this request' : 'Stopped answering' };
    case 'input_too_large': return { state: 'failed', line: 'Too much to read at once' };
    case 'denied': return { state: 'skipped', line: 'Skipped: I lost access to this project' };
    case 'paused': case 'revoked': return { state: 'skipped', line: 'Skipped: your assistant was turned off' };
    default: return { state: 'failed', line: 'Couldn\'t run' };
  }
}

const NOTHING = /^\W*done\W*\s*nothing to change\W*$/i;
/** "Done: nothing to change", or no words at all. */
export function nothingToChange(answer: string | null): boolean {
  const text = (answer ?? '').trim();
  return !text || text === '(No answer text.)' || NOTHING.test(text);
}

