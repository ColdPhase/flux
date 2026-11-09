import { joinsAddress } from '../personal-runs/web-addresses.js';
import type { AssistantJobSchedule } from '@flux/contracts';

// "Set up by asking" (F-027 AST-7): in the owner's own request, "every weekday at 9 tell me what's blocked here" makes the
// assistant prepare a schedule that stays off. The model says so with one block at the end of its
// answer. Flux takes the block out of the words that are posted and prepares the schedule; only the owner's tap turns it on.
// A background run's block is dropped without effect: no run can prepare, change or turn on a schedule (AST-7.5).

export interface ScheduleRequest { title?: string; text: string; schedule: AssistantJobSchedule }

const OPEN = '<schedule>';
const CLOSE = '</schedule>';

/** The answer without any schedule block, and the first block that reads as a schedule (the schedule itself is validated when prepared). */
export function takeScheduleBlocks(answer: string, separator = false): { text: string; request: ScheduleRequest | null } {
  let request: ScheduleRequest | null = null;
  const gap = separator ? ' ' : '';
  // Each block runs from an opening tag to the next closing one. Found by indexOf, in one pass: a regular expression retried from every
  // opening tag of an answer without a closing one would take time growing with the square of its length.
  let text = '';
  let at = 0;
  for (let start = answer.indexOf(OPEN); start >= 0; start = answer.indexOf(OPEN, at)) {
    const end = answer.indexOf(CLOSE, start + OPEN.length);
    if (end < 0) break;
    text += answer.slice(at, start) + gap;
    at = end + CLOSE.length;
    if (request) continue;
    try {
      const raw = JSON.parse(answer.slice(start + OPEN.length, end)) as Record<string, unknown>;
      const when = raw.when ?? raw.schedule;
      if (typeof raw.text === 'string' && raw.text.trim() && when && typeof when === 'object' && !Array.isArray(when))
        request = { ...(typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim().slice(0, 60) } : {}), text: raw.text, schedule: when as AssistantJobSchedule };
    } catch { /* a malformed block is dropped, never guessed */ }
  }
  text += answer.slice(at);
  // An answer cut off inside a block leaves no half of it behind.
  const open = text.indexOf(OPEN);
  if (open >= 0) text = text.slice(0, open) + gap;
  // A block taken out never joins the text on its sides into a web address that was not there (#1149): then a space stands in its place.
  if (!separator && joinsAddress(answer, text)) return takeScheduleBlocks(answer, true);
  return { text: text.trim(), request };
}
