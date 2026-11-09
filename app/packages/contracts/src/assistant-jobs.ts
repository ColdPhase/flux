// An agent's schedules (F-036 AG-9, #858). A schedule is the owner's own sentence, told to one of their agents in its private
// conversation and run by that agent at a time in the owner's time zone. The words "job" and "cron" are internal.

export const ASSISTANT_JOB_LIMITS = {
  /** The row's name; taken from the first words of the sentence when the owner gives none. */
  title: 60,
  /** The owner's sentence: the instruction the run gets (the same bound as any assistant request). */
  text: 4000,
  /**
   * Schedules per owner (enabled or not): a technical safety bound nobody meets in normal use (#843). Flux sets no runs a
   * day for a schedule or for background work; the plan's own limits or the API key's daily budget apply.
   */
  perOwner: 200,
  /** History kept per schedule (AST-7 "history (last 20)"). */
  history: 20,
  /** A run that could not start within this many minutes of its time is skipped (AST-7 "Missed runs"). */
  missedMinutes: 10,
  /** A deleted schedule can be brought back with Undo for this long (hours). */
  undoHours: 24,
} as const;

/** The version of the note about background use of a subscription (AST-2). Shown once per account and version. */
export const ASSISTANT_BACKGROUND_NOTE_VERSION = 'ast-2.2026-10-09';

/** The default "while I work" window: 9:00 to 17:00 on weekdays, editable (AST-7 "When"). */
export const ASSISTANT_WORK_WINDOW = { from: '09:00', to: '17:00' } as const;

/** Local clock times are "HH:MM"; weekdays count from Monday (1) to Sunday (7). */
export type AssistantJobSchedule =
  | { kind: 'daily'; at: string }
  | { kind: 'weekdays'; at: string }
  | { kind: 'weekly'; at: string; weekday: number }
  | { kind: 'hourly'; from: string; to: string }
  | { kind: 'cron'; cron: string }
  /** One time only ("Do it at 14:00"): an ISO instant. */
  | { kind: 'once'; at: string };
export type AssistantJobScheduleKind = AssistantJobSchedule['kind'];

export type AssistantJobRunState = 'running' | 'done' | 'skipped' | 'failed';
export type AssistantJobRunTrigger = 'schedule' | 'now';

/** One line of a schedule's history. `line` is the plain result: "Done, 2 things need you", "Skipped: Flux was off at 9:00". */
export interface AssistantJobRun {
  id: string;
  jobId: string;
  /** The scheduled time (the moment of the tap for Run now). */
  firedAt: string;
  firedBy: AssistantJobRunTrigger;
  state: AssistantJobRunState;
  line: string;
  /** The assistant run behind it, when one started. */
  runId: string | null;
  finishedAt: string | null;
}

/** What the owner sees of one schedule. Nobody else can read it (404). */
export interface AssistantJob {
  id: string;
  workspaceId: string;
  /** The agent it belongs to: it runs in that agent's private conversation. */
  agentId: string;
  title: string;
  text: string;
  schedule: AssistantJobSchedule;
  timeZone: string;
  /** "Every Monday at 9:00". */
  words: string;
  enabled: boolean;
  /** Prepared from a request and still waiting for the owner's tap (never enabled by anyone else). */
  prepared: boolean;
  /** The owner's request that prepared it; the conversation offers *Turn on* under that answer. */
  preparedRunId: string | null;
  /** The next three times, in the owner's time zone ("Mon 9:00"); empty when off. */
  next: { at: string; label: string }[];
  /** The latest history line, when there is one. */
  last: { at: string; state: AssistantJobRunState; line: string } | null;
  /** A run of this schedule is working now. */
  running: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAssistantJob {
  /** Optional: the first words of `text` name the schedule. */
  title?: string;
  text: string;
  schedule: AssistantJobSchedule;
  timeZone: string;
  /** `false` creates the schedule off. */
  enabled?: boolean;
  /** The version of the background-use note the owner saw, when the account needs one (AST-2.1). */
  noteVersion?: string;
}
export interface UpdateAssistantJob {
  expectedVersion: number;
  title?: string;
  text?: string;
  schedule?: AssistantJobSchedule;
  timeZone?: string;
  enabled?: boolean;
  noteVersion?: string;
}

/** What the sheet shows before *Turn on*: the note about background use, when this account has not seen it (AST-2.1). */
export interface AssistantBackgroundNote {
  /** Null: nothing to show, only the meta line. */
  note: string | null;
  version: string;
  /** "Runs on your Claude plan" (the one meta line of every sheet). */
  meta: string;
  /** For a Claude Max or Team plan: the line about monthly API credits, with the plan named (AST-2 "Your plan includes …"). */
  credits: string | null;
}

export const assistantJobsPath = (agentId: string) => `/api/v1/my-agents/${agentId}/schedules`;
export const assistantJobPath = (agentId: string, jobId: string) => `${assistantJobsPath(agentId)}/${jobId}`;
export const assistantJobRunNowPath = (agentId: string, jobId: string) => `${assistantJobPath(agentId, jobId)}/run`;
export const assistantJobRestorePath = (agentId: string, jobId: string) => `${assistantJobPath(agentId, jobId)}/restore`;
export const assistantJobHistoryPath = (agentId: string, jobId: string) => `${assistantJobPath(agentId, jobId)}/history`;
export const assistantJobNotePath = (agentId: string) => `/api/v1/my-agents/${agentId}/background-note`;

/** The ready-made schedules an agent offers to turn on, as a sentence the owner can say to it (#858: the morning summary is one). */
export const ASSISTANT_SCHEDULE_STARTERS = [
  { id: 'morning-summary', title: 'Morning summary', text: 'Every weekday at 9, summarise what needs me: my tasks that are due or waiting, and what changed in my spaces since yesterday.',
    schedule: { kind: 'weekdays', at: '09:00' } as AssistantJobSchedule },
] as const;
