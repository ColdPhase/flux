import type { AssistantJob, AssistantJobSchedule } from '@flux/contracts';

// The sheet's draft of a schedule (F-027 AST-7 "When"): four plain choices with a time, or a five-field expression under More.

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export type Frequency = 'daily' | 'weekdays' | 'weekly' | 'hourly';

export interface Draft {
  text: string;
  /** Kept when editing; a new schedule is named from the first words of its sentence. */
  title: string | null;
  projectId: string;
  frequency: Frequency;
  at: string;
  /** 1 Monday … 7 Sunday. */
  weekday: number;
  from: string;
  to: string;
  cron: string;
  conversationId: string;
  /** A one-off ("Do it at 14:00") keeps its time; the picker does not apply. */
  once: string | null;
}

export const blankDraft = (projectId: string): Draft => ({
  text: '', title: null, projectId, frequency: 'daily', at: '09:00', weekday: 1, from: '09:00', to: '17:00', cron: '', conversationId: '', once: null,
});

/** The Monday starter of the empty part: "Weekly review on Monday", on after one more tap. */
export const weeklyReviewDraft = (projectId: string): Draft => ({
  ...blankDraft(projectId), title: 'Weekly review', frequency: 'weekly', weekday: 1,
  text: 'Review the week: what moved, what is stuck and what needs a decision. Tell me in a few lines.',
});

export function draftOf(job: AssistantJob): Draft {
  const base = { ...blankDraft(job.projectId), text: job.text, title: job.title, conversationId: job.conversationId ?? '' };
  const schedule = job.schedule;
  switch (schedule.kind) {
    case 'daily': case 'weekdays': return { ...base, frequency: schedule.kind, at: schedule.at };
    case 'weekly': return { ...base, frequency: 'weekly', at: schedule.at, weekday: schedule.weekday };
    case 'hourly': return { ...base, frequency: 'hourly', from: schedule.from, to: schedule.to };
    case 'cron': return { ...base, cron: schedule.cron };
    case 'once': return { ...base, once: schedule.at };
  }
}

/** What the draft means as a schedule; null for a one-off, which is not changed from the sheet. */
export function scheduleOf(draft: Draft): AssistantJobSchedule | null {
  if (draft.once) return null;
  if (draft.cron.trim()) return { kind: 'cron', cron: draft.cron.trim() };
  switch (draft.frequency) {
    case 'daily': case 'weekdays': return { kind: draft.frequency, at: draft.at };
    case 'weekly': return { kind: 'weekly', at: draft.at, weekday: draft.weekday };
    case 'hourly': return { kind: 'hourly', from: draft.from, to: draft.to };
  }
}

export function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** "8:30" from "08:30": times are written without a leading zero, as everywhere in the app. */
export const shortTime = (value: string) => {
  const [hours, minutes] = value.split(':');
  return `${Number(hours)}:${minutes}`;
};

/** A clock time of a moment in the schedule's zone: "Tue 14:02". */
export function whenText(iso: string, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch { return iso; }
}
