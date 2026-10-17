import type { AssistantJobSchedule } from '@flux/contracts';

// "Set up by asking" (F-027 AST-7): in the owner's own request, "every weekday at 9 tell me what's blocked here" makes the
// assistant prepare a schedule that stays off. The model says so the way it proposes a result: one block at the end of its
// answer. Flux takes the block out of the words that are posted and prepares the schedule; only the owner's tap turns it on.
// A background run's block is dropped without effect: no run can prepare, change or turn on a schedule (AST-7.5).

export interface ScheduleRequest { title?: string; text: string; schedule: AssistantJobSchedule }

const BLOCK = /<schedule>([\s\S]*?)<\/schedule>/g;
const OPEN = /<schedule>[\s\S]*$/;

/** The answer without any schedule block, and the first block that reads as a schedule (the schedule itself is validated when prepared). */
export function takeScheduleBlocks(answer: string): { text: string; request: ScheduleRequest | null } {
  let request: ScheduleRequest | null = null;
  let text = answer.replace(BLOCK, (_match, inner: string) => {
    if (request) return '';
    try {
      const raw = JSON.parse(inner) as Record<string, unknown>;
      const when = raw.when ?? raw.schedule;
      if (typeof raw.text === 'string' && raw.text.trim() && when && typeof when === 'object' && !Array.isArray(when))
        request = { ...(typeof raw.title === 'string' && raw.title.trim() ? { title: raw.title.trim().slice(0, 60) } : {}), text: raw.text, schedule: when as AssistantJobSchedule };
    } catch { /* a malformed block is dropped, never guessed */ }
    return '';
  });
  // An answer cut off inside a block leaves no half of it behind.
  text = text.replace(OPEN, '');
  return { text: text.trim(), request };
}
